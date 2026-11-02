//! Shared L2CAP transport construction for Apple platforms.
//!
//! CoreBluetooth vends `NSInputStream` / `NSOutputStream` objects for each
//! `CBL2CAPChannel`. Those streams are run-loop driven and thread-affine enough
//! that the backend needs an explicit owner for all stream lifecycle work, so a
//! single reactor thread owns every channel's streams and Tokio only bridges
//! bytes to and from it.
//!
//! # Flow control
//!
//! Every queue here is bounded, and that is load-bearing rather than tidiness.
//! L2CAP CoC is credit-based: the receiver grants credits and each K-frame
//! spends one. If the reactor stops reading a socket, credits stop being
//! returned and the *peer* stops transmitting. So the correct response to a
//! slow application is simply to stop reading — the protocol throttles the
//! sender for us. An unbounded local queue defeats exactly that, converting the
//! peer's flow control into unbounded memory growth on this side.
//!
//! Outbound works the same way in reverse: the reactor only pulls from a
//! channel's outbound queue when the stream reports space, so a slow peer backs
//! pressure up through the bounded queue into the caller's `write()`.

#![allow(clippy::cast_possible_truncation)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};

use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class};
use objc2_core_bluetooth::CBL2CAPChannel;
use objc2_core_foundation::{
    CFRetained, CFRunLoop, CFRunLoopSource, CFRunLoopSourceContext, kCFRunLoopDefaultMode,
};
use objc2_foundation::{
    NSDate, NSDefaultRunLoopMode, NSInputStream, NSOutputStream, NSRunLoop, NSStream,
    NSStreamDelegate, NSStreamEvent, NSStreamStatus,
};
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Handle;
use tokio::sync::mpsc as tokio_mpsc;
use tracing::{debug, trace, warn};

use crate::l2cap::types::{L2capCloseReason, L2capConfig};
use crate::l2cap::{CloseReasonSlot, DuplexBridge, L2capChannel};
use crate::platform::apple::helpers::{ObjcSend, retain_send};

/// Backstop only. The reactor is woken by stream events and by
/// [`wake_reactor`], so this bounds how long a *missed* wakeup could stall a
/// channel rather than setting the service interval.
const RUN_LOOP_IDLE_SECS: f64 = 1.0;
/// Smallest number of queued chunks per direction, so a tiny `buffer_size` can
/// never produce a zero-capacity channel (which would deadlock).
const MIN_QUEUE_CHUNKS: usize = 2;

type InputStream = Arc<ObjcSend<NSInputStream>>;
type OutputStream = Arc<ObjcSend<NSOutputStream>>;

static REACTOR_TX: OnceLock<mpsc::Sender<ReactorCmd>> = OnceLock::new();
static NEXT_CHANNEL_ID: AtomicU64 = AtomicU64::new(1);
static REACTOR_RUN_LOOP: OnceLock<SendRunLoop> = OnceLock::new();
static REACTOR_READY: OnceLock<ReadySet> = OnceLock::new();

/// The reactor thread's run loop and its wake source, so other threads can
/// pull it out of its wait.
///
/// The source is what makes both waking and sleeping work, for two separate
/// reasons (#55):
/// - `acceptInputForMode:beforeDate:` returns at once when the mode has no
///   sources, and otherwise the only sources are the channels' streams. So
///   with no channel registered -- including for the rest of the process once
///   the last one closes -- the reactor would spin at full CPU.
/// - It returns early only once it has *handled* a source. `CFRunLoopWakeUp`
///   alone makes the run loop re-check and go back to sleep until the
///   deadline; a signalled source is what it handles.
///
/// # Safety
/// `CFRunLoopSourceSignal` and `CFRunLoopWakeUp` are the run-loop calls Apple
/// documents as safe to make from any thread; nothing else is done with these
/// handles off the reactor thread.
struct SendRunLoop {
    run_loop: CFRetained<CFRunLoop>,
    wake_source: CFRetained<CFRunLoopSource>,
}
unsafe impl Send for SendRunLoop {}
unsafe impl Sync for SendRunLoop {}

impl SendRunLoop {
    /// Attach a wake source to the current thread's run loop.
    fn install() -> Option<Self> {
        let run_loop = CFRunLoop::current()?;
        let mut context = CFRunLoopSourceContext {
            version: 0,
            info: std::ptr::null_mut(),
            retain: None,
            release: None,
            copyDescription: None,
            equal: None,
            hash: None,
            schedule: None,
            cancel: None,
            perform: Some(wake_source_perform),
        };
        // `CFRunLoopSourceCreate` copies the context, so it may live on the
        // stack.
        let wake_source = unsafe { CFRunLoopSource::new(None, 0, &raw mut context) }?;
        run_loop.add_source(Some(&wake_source), unsafe { kCFRunLoopDefaultMode });
        Some(Self {
            run_loop,
            wake_source,
        })
    }

    fn wake(&self) {
        // Signal first: a wake delivered while the reactor is between passes
        // stays latched on the source, so the next wait handles it and
        // returns immediately rather than sleeping through the work.
        self.wake_source.signal();
        self.run_loop.wake_up();
    }
}

/// Nothing to do: handling the source is itself what ends the wait.
unsafe extern "C-unwind" fn wake_source_perform(_info: *mut std::ffi::c_void) {}

/// Pull the reactor out of `acceptInputForMode:beforeDate:`.
///
/// Needed because the two things that give a channel work are not both visible
/// to the run loop: peer traffic arrives as a stream event, but an application
/// `write()` only lands in a Tokio channel the reactor polls. Without this, an
/// outbound write would wait for the idle backstop.
fn wake_reactor() {
    if let Some(run_loop) = REACTOR_RUN_LOOP.get() {
        run_loop.wake();
    }
}

/// Channels with news since the reactor last looked.
///
/// Written by the stream delegate (on the reactor thread) and by the outbound
/// bridge tasks (on Tokio workers); drained by the reactor each pass.
#[derive(Clone, Default)]
struct ReadySet(Arc<Mutex<HashSet<u64>>>);

impl ReadySet {
    fn mark(&self, id: u64) {
        self.0.lock().insert(id);
    }

    fn drain(&self) -> HashSet<u64> {
        std::mem::take(&mut *self.0.lock())
    }
}

struct StreamDelegateIvars {
    id: u64,
    ready: ReadySet,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BlewL2capStreamDelegate"]
    #[ivars = StreamDelegateIvars]
    struct StreamDelegate;

    unsafe impl NSObjectProtocol for StreamDelegate {}

    unsafe impl NSStreamDelegate for StreamDelegate {
        /// Fires on the reactor thread, since that is where the streams are
        /// scheduled.
        ///
        /// The event code is deliberately ignored: `pump_output` and
        /// `pump_input` already distinguish data, space, EOF and error from the
        /// stream itself, and acting on the code here would duplicate that in a
        /// second place that could drift. What matters is that a delegate
        /// exists at all -- it makes "the run loop processed this stream's
        /// source" a defined event rather than something we hope happens.
        #[unsafe(method(stream:handleEvent:))]
        #[allow(non_snake_case, reason = "mirrors the Objective-C selector")]
        unsafe fn stream_handleEvent(&self, _stream: &NSStream, _event: NSStreamEvent) {
            let ivars = self.ivars();
            ivars.ready.mark(ivars.id);
        }
    }
);

impl StreamDelegate {
    fn new(id: u64, ready: ReadySet) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamDelegateIvars { id, ready });
        unsafe { objc2::msg_send![super(this), init] }
    }
}

/// Queue depth in chunks for `buffer_size` bytes of `read_chunk_size` chunks.
fn queue_capacity(config: &L2capConfig) -> usize {
    config
        .effective_buffer_size()
        .div_ceil(config.effective_read_chunk_size())
        .max(MIN_QUEUE_CHUNKS)
}

struct RegisterChannel {
    id: u64,
    channel_ref: Arc<ObjcSend<CBL2CAPChannel>>,
    input: InputStream,
    output: OutputStream,
    inbound_tx: tokio_mpsc::Sender<Vec<u8>>,
    outbound_rx: tokio_mpsc::Receiver<Vec<u8>>,
    read_chunk_size: usize,
    close_reason: CloseReasonSlot,
    linger_timeout: Option<Duration>,
}

enum ReactorCmd {
    Register(Box<RegisterChannel>),
    Close { id: u64 },
}

struct ReactorChannel {
    channel_ref: Arc<ObjcSend<CBL2CAPChannel>>,
    input: InputStream,
    output: OutputStream,
    inbound_tx: tokio_mpsc::Sender<Vec<u8>>,
    outbound_rx: tokio_mpsc::Receiver<Vec<u8>>,
    /// Bytes accepted from the app but not yet taken by the output stream.
    pending: VecDeque<Vec<u8>>,
    /// How much of `pending.front()` the stream has already taken.
    pending_offset: usize,
    /// The app closed its write side; once `pending` empties we are drained.
    outbound_done: bool,
    /// Set when the app closed or dropped the channel. The reactor keeps
    /// draining `pending` after this, which is what gives `Drop` the same
    /// delivery behaviour as `close()`.
    closing_since: Option<Instant>,
    linger_timeout: Option<Duration>,
    read_chunk_size: usize,
    close_reason: CloseReasonSlot,
    /// `setDelegate:` does not retain, so the delegate has to live here or the
    /// streams would be left pointing at freed memory.
    _delegate: Retained<StreamDelegate>,
}

/// Whether a channel should be serviced this pass.
///
/// A lingering channel is always serviced: its deadline has to be checked even
/// when idle, and once the peer goes quiet nothing else will signal it -- so
/// skipping it would leave the channel open until the idle backstop, or
/// forever if the deadline is `None`.
fn needs_service(ready: &HashSet<u64>, id: u64, closing: bool) -> bool {
    closing || ready.contains(&id)
}

/// Whether a closing channel is finished: everything queued has been written,
/// or the linger deadline has passed.
///
/// Split out from `ReactorChannel` so the policy is testable without a radio.
fn linger_finished(
    closing_since: Option<Instant>,
    outbound_done: bool,
    pending_empty: bool,
    linger_timeout: Option<Duration>,
    now: Instant,
) -> bool {
    let Some(since) = closing_since else {
        return false;
    };
    if outbound_done && pending_empty {
        return true;
    }
    match linger_timeout {
        Some(limit) => now.duration_since(since) >= limit,
        None => false,
    }
}

struct L2capReactor {
    cmd_rx: mpsc::Receiver<ReactorCmd>,
    channels: HashMap<u64, ReactorChannel>,
    ready: ReadySet,
}

fn default_run_loop_mode() -> &'static objc2_foundation::NSRunLoopMode {
    unsafe { NSDefaultRunLoopMode }
}

/// Send a command and wake the reactor so it acts on it promptly.
fn send_cmd(cmd: ReactorCmd) -> Result<(), mpsc::SendError<ReactorCmd>> {
    reactor_tx().send(cmd)?;
    wake_reactor();
    Ok(())
}

/// The reactor's ready set. Created here rather than inside the reactor so it
/// is available to bridge tasks the moment a channel exists, without racing
/// the reactor thread's startup.
fn ready_set() -> &'static ReadySet {
    REACTOR_READY.get_or_init(ReadySet::default)
}

fn reactor_tx() -> &'static mpsc::Sender<ReactorCmd> {
    REACTOR_TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let ready = ready_set().clone();
        std::thread::Builder::new()
            .name("blew-l2cap-reactor".to_string())
            .spawn(move || L2capReactor::new(rx, ready).run())
            .expect("spawn blew-l2cap-reactor");
        tx
    })
}

fn next_channel_id() -> u64 {
    NEXT_CHANNEL_ID.fetch_add(1, Ordering::Relaxed)
}

/// Outcome of servicing one direction of one channel for one tick.
enum Pump {
    /// Made whatever progress was available; keep the channel.
    Continue,
    /// The channel is finished and should be torn down.
    Done(L2capCloseReason),
}

impl ReactorChannel {
    /// The output stream has failed, if it has.
    fn output_failure(&self) -> Option<L2capCloseReason> {
        (self.output.streamStatus() == NSStreamStatus::Error)
            .then(|| stream_error(self.output.streamError().as_deref()))
    }

    /// Move bytes app -> peer, never writing without reported space.
    fn pump_output(&mut self) -> Pump {
        // Before looking for work, not only when some is found. An error on an
        // idle output stream consumes its ready mark and would otherwise go
        // unnoticed until the next application write -- leaving the channel
        // half-dead with `close_reason()` still empty, possibly forever.
        if let Some(reason) = self.output_failure() {
            return Pump::Done(reason);
        }
        loop {
            if self.pending.is_empty() {
                match self.outbound_rx.try_recv() {
                    Ok(chunk) => {
                        if !chunk.is_empty() {
                            self.pending.push_back(chunk);
                        }
                    }
                    Err(tokio_mpsc::error::TryRecvError::Empty) => break,
                    Err(tokio_mpsc::error::TryRecvError::Disconnected) => {
                        self.outbound_done = true;
                        break;
                    }
                }
            }
            let Some(front) = self.pending.front() else {
                break;
            };
            // Asking an NSOutputStream to write with no space either blocks the
            // reactor thread -- stalling every other channel -- or reports a
            // failure we would misread as a dead channel. Stop instead: the
            // peer returning credits produces a HasSpaceAvailable event, which
            // re-marks this channel and brings us back here.
            if !self.output.hasSpaceAvailable() {
                // "No space" and "dead" are indistinguishable from
                // hasSpaceAvailable alone, and a dead stream never reports
                // space again -- so without this check a failed output stream
                // stalls every subsequent write for the life of the channel.
                // Re-checked here because a write earlier in this same pass
                // may have killed the stream.
                if let Some(reason) = self.output_failure() {
                    return Pump::Done(reason);
                }
                break;
            }
            let remaining = &front[self.pending_offset..];
            let n = unsafe {
                self.output.write_maxLength(
                    NonNull::new(remaining.as_ptr().cast_mut()).expect("data ptr"),
                    remaining.len(),
                )
            };
            if n < 0 {
                return Pump::Done(stream_error(self.output.streamError().as_deref()));
            }
            if n == 0 {
                break;
            }
            self.pending_offset += n.cast_unsigned();
            if self.pending_offset >= front.len() {
                self.pending.pop_front();
                self.pending_offset = 0;
            }
        }

        Pump::Continue
    }

    /// Move bytes peer -> app, never reading what we cannot deliver.
    fn pump_input(&mut self, id: u64) -> Pump {
        while self.input.hasBytesAvailable() {
            // Reserve delivery capacity *before* reading. Bytes read out of the
            // socket are bytes whose L2CAP credit has been returned to the peer,
            // so reading without somewhere to put them is what turns the peer's
            // flow control into unbounded local buffering.
            let permit = match self.inbound_tx.try_reserve() {
                Ok(permit) => permit,
                Err(tokio_mpsc::error::TrySendError::Full(())) => {
                    trace!(id, "apple L2CAP inbound queue full; pausing reads");
                    break;
                }
                Err(tokio_mpsc::error::TrySendError::Closed(())) => {
                    return Pump::Done(L2capCloseReason::Closed);
                }
            };

            let mut buf = vec![0_u8; self.read_chunk_size];
            let n = unsafe {
                self.input
                    .read_maxLength(NonNull::new(buf.as_mut_ptr()).expect("buf ptr"), buf.len())
            };
            if n < 0 {
                return Pump::Done(stream_error(self.input.streamError().as_deref()));
            }
            if n == 0 {
                trace!(id, "apple L2CAP input reached end of stream");
                return Pump::Done(L2capCloseReason::Closed);
            }
            buf.truncate(n.cast_unsigned());
            permit.send(buf);
        }

        // A clean peer close produces no readable bytes, so the loop above
        // exits without ever seeing the 0-length read that means EOF. Only the
        // stream's own status reports it, and `AtEnd` is only reached once
        // everything readable has been consumed -- anything still buffered
        // keeps the status at Open/Reading, and anything already handed to
        // `inbound_tx` is still delivered after the sender drops.
        match self.input.streamStatus() {
            NSStreamStatus::Error => Pump::Done(stream_error(self.input.streamError().as_deref())),
            NSStreamStatus::AtEnd => {
                trace!(id, "apple L2CAP input stream at end");
                Pump::Done(L2capCloseReason::Closed)
            }
            _ => Pump::Continue,
        }
    }
}

fn stream_error(err: Option<&objc2_foundation::NSError>) -> L2capCloseReason {
    match err {
        Some(e) => L2capCloseReason::TransportError(e.localizedDescription().to_string()),
        None => L2capCloseReason::LinkLost,
    }
}

fn close_channel(
    run_loop: &NSRunLoop,
    id: u64,
    channel: ReactorChannel,
    reason: &L2capCloseReason,
) {
    trace!(id, ?reason, "apple L2CAP reactor closing channel");
    channel.close_reason.set(reason.clone());
    unsafe {
        // Unset before unscheduling: `setDelegate:` does not retain, so a
        // stream outliving the delegate would hold a dangling pointer.
        channel.input.setDelegate(None);
        channel.output.setDelegate(None);
        channel
            .input
            .removeFromRunLoop_forMode(run_loop, default_run_loop_mode());
        channel
            .output
            .removeFromRunLoop_forMode(run_loop, default_run_loop_mode());
    }
    channel.input.close();
    channel.output.close();
    drop(channel.channel_ref);
}

impl L2capReactor {
    fn new(cmd_rx: mpsc::Receiver<ReactorCmd>, ready: ReadySet) -> Self {
        Self {
            cmd_rx,
            channels: HashMap::new(),
            ready,
        }
    }

    fn run(mut self) {
        autoreleasepool(|_| {
            trace!("apple L2CAP reactor started");
            let run_loop = NSRunLoop::currentRunLoop();
            // Publish before servicing anything, so a wake that races startup
            // is not lost.
            if let Some(cf) = SendRunLoop::install() {
                let _ = REACTOR_RUN_LOOP.set(cf);
            } else {
                warn!("apple L2CAP reactor has no wake source; falling back to idle polling");
            }
            loop {
                autoreleasepool(|_| {
                    self.drain_commands(&run_loop);
                    self.pump_channels(&run_loop);
                    let secs = self.sleep_secs(Instant::now());
                    Self::wait_for_work(&run_loop, secs);
                });
            }
        });
    }

    fn drain_commands(&mut self, run_loop: &NSRunLoop) {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            match cmd {
                ReactorCmd::Register(channel) => self.register_channel(run_loop, *channel),
                // Closing is a request to stop *after* draining, not an
                // immediate teardown -- see `pump_channels`.
                ReactorCmd::Close { id } => {
                    if let Some(channel) = self.channels.get_mut(&id)
                        && channel.closing_since.is_none()
                    {
                        channel.closing_since = Some(Instant::now());
                        self.ready.mark(id);
                        trace!(id, "apple L2CAP channel closing; draining outbound queue");
                    }
                }
            }
        }
    }

    fn register_channel(&mut self, run_loop: &NSRunLoop, channel: RegisterChannel) {
        let RegisterChannel {
            id,
            channel_ref,
            input,
            output,
            inbound_tx,
            outbound_rx,
            read_chunk_size,
            close_reason,
            linger_timeout,
        } = channel;

        trace!(id, "apple L2CAP reactor registering channel");
        let delegate = StreamDelegate::new(id, self.ready.clone());
        let delegate_ref = ProtocolObject::from_ref(&*delegate);
        unsafe {
            input.setDelegate(Some(delegate_ref));
            output.setDelegate(Some(delegate_ref));
            input.scheduleInRunLoop_forMode(run_loop, default_run_loop_mode());
            output.scheduleInRunLoop_forMode(run_loop, default_run_loop_mode());
        }
        input.open();
        output.open();
        // Service it once without waiting for an event; opening may already
        // have made space available.
        self.ready.mark(id);
        self.channels.insert(
            id,
            ReactorChannel {
                channel_ref,
                input,
                output,
                inbound_tx,
                outbound_rx,
                pending: VecDeque::new(),
                pending_offset: 0,
                outbound_done: false,
                closing_since: None,
                linger_timeout,
                read_chunk_size,
                close_reason,
                _delegate: delegate,
            },
        );
    }

    fn pump_channels(&mut self, run_loop: &NSRunLoop) {
        let now = Instant::now();
        let ready = self.ready.drain();
        let mut finished = Vec::new();
        for (&id, channel) in &mut self.channels {
            if !needs_service(&ready, id, channel.closing_since.is_some()) {
                continue;
            }
            if let Pump::Done(reason) = channel.pump_output() {
                finished.push((id, reason));
                continue;
            }
            // A closing channel has no reader left, and its inbound queue has
            // usually already been dropped -- which would otherwise look like a
            // reason to tear down immediately and defeat the linger.
            if channel.closing_since.is_none()
                && let Pump::Done(reason) = channel.pump_input(id)
            {
                finished.push((id, reason));
                continue;
            }
            if linger_finished(
                channel.closing_since,
                channel.outbound_done,
                channel.pending.is_empty(),
                channel.linger_timeout,
                now,
            ) {
                finished.push((id, L2capCloseReason::Closed));
            }
        }
        for (id, reason) in finished {
            self.remove_channel(run_loop, id, &reason);
        }
    }

    fn remove_channel(&mut self, run_loop: &NSRunLoop, id: u64, reason: &L2capCloseReason) {
        if let Some(channel) = self.channels.remove(&id) {
            close_channel(run_loop, id, channel, reason);
        }
    }

    /// How long the reactor may sleep before it has work of its own.
    ///
    /// A lingering channel has to be torn down at its deadline whether or not
    /// anything signals it, so sleeping past that deadline would overrun a
    /// short `linger_timeout` by up to the idle backstop.
    fn sleep_secs(&self, now: Instant) -> f64 {
        let mut secs = RUN_LOOP_IDLE_SECS;
        for channel in self.channels.values() {
            let (Some(since), Some(limit)) = (channel.closing_since, channel.linger_timeout) else {
                continue;
            };
            let remaining = limit.saturating_sub(now.saturating_duration_since(since));
            secs = secs.min(remaining.as_secs_f64());
        }
        secs.max(0.0)
    }

    /// Block until a stream event, a [`wake_reactor`] call, or the next
    /// deadline the reactor owes something to.
    fn wait_for_work(run_loop: &NSRunLoop, secs: f64) {
        let deadline = NSDate::dateWithTimeIntervalSinceNow(secs);
        run_loop.acceptInputForMode_beforeDate(default_run_loop_mode(), &deadline);
    }
}

/// Wrap an Apple `CBL2CAPChannel` into a `L2capChannel` (AsyncRead + AsyncWrite).
///
/// # Ownership / lifetime
/// The `CBL2CAPChannel` is retained for the lifetime of the bridge: Apple's
/// docs say "you should retain the channel yourself" -- without this, CB may
/// release the channel after the delegate callback returns, closing the streams.
///
/// # Errors
/// Returns an error if CoreBluetooth vended a channel without both streams,
/// rather than handing back a channel that would read EOF immediately.
pub(crate) fn bridge_l2cap_channel(
    channel: &CBL2CAPChannel,
    runtime: &Handle,
    config: &L2capConfig,
) -> Result<L2capChannel, L2capCloseReason> {
    let channel = Arc::new(unsafe { retain_send(channel) });

    let Some(inp) = (unsafe { channel.inputStream() }) else {
        warn!("apple L2CAP channel missing input stream");
        return Err(L2capCloseReason::TransportError(
            "L2CAP channel has no input stream".into(),
        ));
    };
    let Some(out) = (unsafe { channel.outputStream() }) else {
        warn!("apple L2CAP channel missing output stream");
        return Err(L2capCloseReason::TransportError(
            "L2CAP channel has no output stream".into(),
        ));
    };

    let input = Arc::new(unsafe { retain_send(&*inp) });
    let output = Arc::new(unsafe { retain_send(&*out) });

    let capacity = queue_capacity(config);
    let (inbound_tx, mut inbound_rx) = tokio_mpsc::channel::<Vec<u8>>(capacity);
    let (outbound_tx, outbound_rx) = tokio_mpsc::channel::<Vec<u8>>(capacity);
    let close_reason = CloseReasonSlot::default();

    let outbound_ready = ready_set().clone();
    let channel_id = next_channel_id();

    send_cmd(ReactorCmd::Register(Box::new(RegisterChannel {
        id: channel_id,
        channel_ref: Arc::clone(&channel),
        input,
        output,
        inbound_tx,
        outbound_rx,
        read_chunk_size: config.effective_read_chunk_size(),
        close_reason: close_reason.clone(),
        linger_timeout: config.linger_timeout,
    })))
    .expect("apple L2CAP reactor available");

    let (app_side, io_side) = tokio::io::duplex(config.effective_buffer_size());
    let (mut io_reader, mut io_writer) = tokio::io::split(io_side);

    let inbound_ready = ready_set().clone();
    runtime.spawn(async move {
        trace!(id = channel_id, "apple L2CAP inbound async bridge started");
        while let Some(bytes) = inbound_rx.recv().await {
            if io_writer.write_all(&bytes).await.is_err() {
                trace!(
                    id = channel_id,
                    "apple L2CAP inbound async bridge stopping: app-side writer closed"
                );
                break;
            }
            // Draining one chunk frees inbound capacity, which is the only
            // thing that lets a paused `pump_input` resume. No stream event
            // will say so: `hasBytesAvailable` is a level, not an edge, so the
            // unread bytes that stalled us generate no new notification.
            // Without this the channel would stall until the idle backstop.
            inbound_ready.mark(channel_id);
            wake_reactor();
        }
        trace!(id = channel_id, "apple L2CAP inbound async bridge exited");
    });

    let read_chunk = config.effective_read_chunk_size();
    runtime.spawn(async move {
        trace!(id = channel_id, "apple L2CAP outbound async bridge started");
        let mut buf = vec![0_u8; read_chunk];
        loop {
            let n = match io_reader.read(&mut buf).await {
                Ok(0) => {
                    trace!(
                        id = channel_id,
                        "apple L2CAP outbound async bridge stopping: app-side reader EOF"
                    );
                    break;
                }
                Err(e) => {
                    debug!(
                        id = channel_id,
                        "apple L2CAP outbound async bridge stopping: app-side read failed: {e}"
                    );
                    break;
                }
                Ok(n) => n,
            };
            // Awaiting capacity here is what makes the caller's `write()` block
            // when the peer stops accepting data.
            if outbound_tx.send(buf[..n].to_vec()).await.is_err() {
                trace!(
                    id = channel_id,
                    "apple L2CAP outbound async bridge stopping: reactor dropped channel"
                );
                break;
            }
            // An application write produces no stream event, so the reactor has
            // no other way to learn this channel has bytes waiting.
            outbound_ready.mark(channel_id);
            wake_reactor();
        }
        // Dropping `outbound_tx` is how the reactor learns no more bytes are
        // coming, which lets a lingering close finish.
        drop(outbound_tx);
        outbound_ready.mark(channel_id);
        wake_reactor();
        trace!(id = channel_id, "apple L2CAP outbound async bridge exited");
    });

    Ok(L2capChannel::from_bridge(DuplexBridge {
        inner: app_side,
        close_hook: Some(Box::new(move || {
            let _ = send_cmd(ReactorCmd::Close { id: channel_id });
        })),
        close_reason,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_capacity_divides_buffer_into_chunks() {
        let config = L2capConfig {
            buffer_size: 64 * 1024,
            read_chunk_size: 4096,
            ..Default::default()
        };
        assert_eq!(queue_capacity(&config), 16);
    }

    #[test]
    fn queue_capacity_rounds_up_a_partial_chunk() {
        let config = L2capConfig {
            buffer_size: 5000,
            read_chunk_size: 4096,
            ..Default::default()
        };
        assert_eq!(queue_capacity(&config), 2);
    }

    #[test]
    fn ready_set_drains_once() {
        let ready = ReadySet::default();
        ready.mark(1);
        ready.mark(2);
        ready.mark(1);
        assert_eq!(ready.drain(), HashSet::from([1, 2]));
        assert!(
            ready.drain().is_empty(),
            "a drained mark must not be replayed"
        );
    }

    #[test]
    fn only_signalled_channels_are_serviced() {
        let ready = HashSet::from([7_u64]);
        assert!(needs_service(&ready, 7, false));
        assert!(!needs_service(&ready, 8, false));
    }

    #[test]
    fn a_closing_channel_is_serviced_even_unsignalled() {
        // Otherwise its linger deadline is never evaluated and it stays open.
        let ready = HashSet::new();
        assert!(needs_service(&ready, 7, true));
    }

    #[test]
    fn not_closing_never_finishes() {
        let now = Instant::now();
        assert!(!linger_finished(None, true, true, None, now));
    }

    #[test]
    fn closing_finishes_once_the_queue_is_drained() {
        let now = Instant::now();
        assert!(linger_finished(
            Some(now),
            true,
            true,
            Some(Duration::from_secs(60)),
            now
        ));
    }

    #[test]
    fn closing_waits_while_bytes_remain() {
        let now = Instant::now();
        // Outbound finished but bytes still pending...
        assert!(!linger_finished(
            Some(now),
            true,
            false,
            Some(Duration::from_secs(60)),
            now
        ));
        // ...and the app may still be writing.
        assert!(!linger_finished(
            Some(now),
            false,
            true,
            Some(Duration::from_secs(60)),
            now
        ));
    }

    #[test]
    fn closing_gives_up_once_the_deadline_passes() {
        let start = Instant::now();
        let later = start + Duration::from_secs(2);
        assert!(linger_finished(
            Some(start),
            false,
            false,
            Some(Duration::from_secs(1)),
            later
        ));
    }

    #[test]
    fn a_none_deadline_drains_indefinitely() {
        let start = Instant::now();
        let much_later = start + Duration::from_hours(24);
        assert!(!linger_finished(
            Some(start),
            false,
            false,
            None,
            much_later
        ));
    }

    #[test]
    fn queue_capacity_never_reaches_zero() {
        // A zero-capacity tokio channel would deadlock rather than throttle.
        let config = L2capConfig {
            buffer_size: 0,
            read_chunk_size: 0,
            ..Default::default()
        };
        assert!(queue_capacity(&config) >= MIN_QUEUE_CHUNKS);
    }

    /// Run `f` on a fresh thread, whose run loop has no sources of its own --
    /// the state the reactor is in with no channels registered.
    fn on_fresh_run_loop<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::spawn(move || autoreleasepool(|_| f()))
            .join()
            .expect("run loop thread panicked")
    }

    #[test]
    fn idle_wait_blocks_with_no_channels() {
        let elapsed = on_fresh_run_loop(|| {
            let run_loop = NSRunLoop::currentRunLoop();
            let _wake = SendRunLoop::install().expect("thread has a CFRunLoop");
            let start = Instant::now();
            L2capReactor::wait_for_work(&run_loop, 0.3);
            start.elapsed()
        });
        assert!(
            elapsed >= Duration::from_millis(250),
            "idle wait returned after {elapsed:?}; the reactor would spin"
        );
    }

    #[test]
    fn wake_up_interrupts_the_idle_wait() {
        let elapsed = on_fresh_run_loop(|| {
            let run_loop = NSRunLoop::currentRunLoop();
            let wake = Arc::new(SendRunLoop::install().expect("thread has a CFRunLoop"));
            let waker = {
                let wake = Arc::clone(&wake);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    wake.wake();
                })
            };
            let start = Instant::now();
            L2capReactor::wait_for_work(&run_loop, 5.0);
            let elapsed = start.elapsed();
            waker.join().expect("waker panicked");
            elapsed
        });
        assert!(
            elapsed < Duration::from_secs(2),
            "wake_up did not interrupt the wait ({elapsed:?})"
        );
    }

    #[test]
    fn a_wake_before_the_wait_is_not_lost() {
        let elapsed = on_fresh_run_loop(|| {
            let run_loop = NSRunLoop::currentRunLoop();
            let wake = SendRunLoop::install().expect("thread has a CFRunLoop");
            wake.wake();
            let start = Instant::now();
            L2capReactor::wait_for_work(&run_loop, 5.0);
            start.elapsed()
        });
        assert!(
            elapsed < Duration::from_secs(2),
            "a latched wake was lost ({elapsed:?})"
        );
    }
}
