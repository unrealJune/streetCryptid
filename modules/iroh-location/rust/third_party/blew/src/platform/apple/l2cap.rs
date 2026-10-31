//! Shared L2CAP transport construction for Apple platforms.
//!
//! CoreBluetooth vends `NSInputStream` / `NSOutputStream` objects for each
//! `CBL2CAPChannel`. Those streams are run-loop driven and thread-affine enough
//! that the backend needs an explicit owner for all stream lifecycle work.
//!
//! The long-term shape here is a shared reactor thread. Each bridged channel is
//! registered with that reactor, which owns stream scheduling, reads, writes,
//! and close/unschedule. Tokio only bridges bytes between the app-facing
//! transport and the reactor.
//!
//! streetCryptid modifications (2026-10-31, see NOTICE):
//! - The reactor sleeps in its run loop until something happens. Upstream polled it every 50 ms
//!   (20 wake-ups a second for as long as the reactor existed), and a write queued from Rust
//!   waited for the next poll. Commands now signal a `CFRunLoopSource`. Having that source
//!   attached also keeps the run loop from returning at once when no stream is scheduled on it
//!   (`acceptInputForMode:beforeDate:` returns immediately when no input sources are attached),
//!   which left an idle reactor spinning once its last channel closed.
//! - A full stream no longer closes the channel. Upstream called `write:maxLength:` without
//!   checking `hasSpaceAvailable` (it can block) and treated a return of 0 as a dead channel, so a
//!   busy channel could tear itself down. Bytes the stream cannot take yet stay queued per
//!   channel and go out when it reports space, and the Rust side stops reading from the app once
//!   `L2CAP_MAX_PENDING` bytes are queued, so the backlog is bounded and the back-pressure reaches
//!   the writer.

#![allow(clippy::cast_possible_truncation)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, mpsc};

use objc2::rc::autoreleasepool;
use objc2_core_bluetooth::CBL2CAPChannel;
use objc2_core_foundation::{
    CFRetained, CFRunLoop, CFRunLoopSource, CFRunLoopSourceContext, kCFRunLoopDefaultMode,
};
use objc2_foundation::{
    NSDate, NSDefaultRunLoopMode, NSInputStream, NSOutputStream, NSRunLoop, NSStreamStatus,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Handle;
use tokio::sync::mpsc as tokio_mpsc;
use tracing::{debug, trace, warn};

use crate::l2cap::L2capChannel;
use crate::platform::apple::helpers::{ObjcSend, retain_send};

const L2CAP_DUPLEX_BUF_SIZE: usize = 65536;
const L2CAP_READ_BUF_SIZE: usize = 4096;
/// How long the reactor sleeps when nothing wakes it. A safety net only: commands signal the wake
/// source, and stream events are run-loop sources of their own.
const RUN_LOOP_IDLE_SECS: f64 = 1.0;
/// How long it sleeps while bytes wait for a stream to report space, in case that event is late.
const RUN_LOOP_BACKLOG_SECS: f64 = 0.05;
/// Bytes queued for one channel's output stream before the Rust side stops reading from the app.
const L2CAP_MAX_PENDING: usize = 64 * 1024;

type InputStream = Arc<ObjcSend<NSInputStream>>;
type OutputStream = Arc<ObjcSend<NSOutputStream>>;

static REACTOR: OnceLock<ReactorHandle> = OnceLock::new();
static NEXT_CHANNEL_ID: AtomicU64 = AtomicU64::new(1);

/// Wakes the reactor's run loop from any thread.
struct RunLoopWaker {
    run_loop: CFRetained<CFRunLoop>,
    source: CFRetained<CFRunLoopSource>,
}

// SAFETY: `CFRunLoopSourceSignal` and `CFRunLoopWakeUp` may be called from any thread, and they
// are the only things done with these handles off the reactor thread.
unsafe impl Send for RunLoopWaker {}
unsafe impl Sync for RunLoopWaker {}

impl RunLoopWaker {
    fn wake(&self) {
        self.source.signal();
        self.run_loop.wake_up();
    }
}

struct ReactorHandle {
    tx: mpsc::Sender<ReactorCmd>,
    waker: RunLoopWaker,
}

impl ReactorHandle {
    fn send(&self, cmd: ReactorCmd) -> Result<(), ()> {
        self.tx.send(cmd).map_err(drop)?;
        self.waker.wake();
        Ok(())
    }
}

/// Shared by a channel's outbound bridge and the reactor: how many bytes are queued for the
/// output stream, and whether the reactor has closed the channel.
struct Flow {
    pending: AtomicUsize,
    closed: AtomicBool,
    drained: tokio::sync::Notify,
}

impl Flow {
    fn new() -> Self {
        Self {
            pending: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            drained: tokio::sync::Notify::new(),
        }
    }
}

struct RegisterChannel {
    id: u64,
    channel_ref: Arc<ObjcSend<CBL2CAPChannel>>,
    input: InputStream,
    output: OutputStream,
    inbound_tx: tokio_mpsc::UnboundedSender<Vec<u8>>,
    flow: Arc<Flow>,
}

enum ReactorCmd {
    Register(RegisterChannel),
    Write { id: u64, data: Vec<u8> },
    Close { id: u64 },
}

struct ReactorChannel {
    channel_ref: Arc<ObjcSend<CBL2CAPChannel>>,
    input: InputStream,
    output: OutputStream,
    inbound_tx: tokio_mpsc::UnboundedSender<Vec<u8>>,
    flow: Arc<Flow>,
    /// Bytes taken from the app that the output stream has not accepted yet. What is left to
    /// write is `pending[sent..]`.
    pending: Vec<u8>,
    sent: usize,
}

struct L2capReactor {
    cmd_rx: mpsc::Receiver<ReactorCmd>,
    channels: HashMap<u64, ReactorChannel>,
}

fn default_run_loop_mode() -> &'static objc2_foundation::NSRunLoopMode {
    unsafe { NSDefaultRunLoopMode }
}

fn reactor() -> &'static ReactorHandle {
    REACTOR.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        let (waker_tx, waker_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("blew-l2cap-reactor".to_string())
            .spawn(move || L2capReactor::new(rx).run(&waker_tx))
            .expect("spawn blew-l2cap-reactor");
        // The thread installs its wake source before it reads a single command, so nothing sent
        // after this returns can be missed.
        let waker = waker_rx.recv().expect("blew-l2cap-reactor wake source");
        ReactorHandle { tx, waker }
    })
}

/// Attach a source to the current thread's run loop that does nothing when it fires. Firing it is
/// what makes `acceptInputForMode:beforeDate:` return; having it attached is what keeps that call
/// from returning at once when no stream is scheduled.
fn install_wake_source() -> RunLoopWaker {
    unsafe extern "C-unwind" fn perform(_info: *mut c_void) {}
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
        perform: Some(perform),
    };
    // SAFETY: `context` is a valid version-0 context, and CoreFoundation copies it.
    let source =
        unsafe { CFRunLoopSource::new(None, 0, &raw mut context) }.expect("CFRunLoopSourceCreate");
    let run_loop = CFRunLoop::current().expect("CFRunLoopGetCurrent");
    // SAFETY: reads an immutable CoreFoundation constant. It is the same mode as
    // `NSDefaultRunLoopMode`, which the reactor runs in.
    run_loop.add_source(Some(&source), unsafe { kCFRunLoopDefaultMode });
    RunLoopWaker { run_loop, source }
}

fn next_channel_id() -> u64 {
    NEXT_CHANNEL_ID.fetch_add(1, Ordering::Relaxed)
}

fn close_channel(run_loop: &NSRunLoop, id: u64, channel: ReactorChannel, reason: &'static str) {
    let ReactorChannel {
        channel_ref,
        input,
        output,
        inbound_tx: _,
        flow,
        pending: _,
        sent: _,
    } = channel;
    trace!(id, reason, "apple L2CAP reactor closing channel");
    flow.closed.store(true, Ordering::Release);
    flow.drained.notify_one();
    unsafe {
        input.removeFromRunLoop_forMode(run_loop, default_run_loop_mode());
        output.removeFromRunLoop_forMode(run_loop, default_run_loop_mode());
    }
    input.close();
    output.close();
    drop(channel_ref);
}

impl ReactorChannel {
    fn has_backlog(&self) -> bool {
        self.sent < self.pending.len()
    }

    /// Write whatever the output stream will take now. `false` means the stream has failed and
    /// the channel must close; a stream that is only full keeps its bytes for a later turn.
    fn flush(&mut self, id: u64) -> bool {
        let mut written = 0_usize;
        while self.sent < self.pending.len() {
            // `write:maxLength:` can block on a stream with no space, and this one thread serves
            // every channel, so it is never called without this check.
            if !self.output.hasSpaceAvailable() {
                break;
            }
            let rest = &self.pending[self.sent..];
            let n = unsafe {
                self.output.write_maxLength(
                    NonNull::new(rest.as_ptr().cast_mut()).expect("data ptr"),
                    rest.len(),
                )
            };
            if n < 0 {
                trace!(id, "apple L2CAP reactor write failed");
                return false;
            }
            if n == 0 {
                break;
            }
            let n = n.cast_unsigned();
            self.sent += n;
            written += n;
        }
        if written > 0 {
            trace!(
                id,
                written,
                queued = self.pending.len() - self.sent,
                "apple L2CAP reactor wrote outbound bytes"
            );
            self.flow.pending.fetch_sub(written, Ordering::AcqRel);
            self.flow.drained.notify_one();
        }
        if self.sent == self.pending.len() {
            self.pending.clear();
            self.sent = 0;
        } else if self.sent >= L2CAP_READ_BUF_SIZE {
            self.pending.drain(..self.sent);
            self.sent = 0;
        }
        let status = self.output.streamStatus();
        status != NSStreamStatus::Error
            && status != NSStreamStatus::Closed
            && status != NSStreamStatus::AtEnd
    }

    fn forward_available_input(&self, id: u64) -> bool {
        while self.input.hasBytesAvailable() {
            let mut buf = vec![0_u8; L2CAP_READ_BUF_SIZE];
            let n = unsafe {
                self.input
                    .read_maxLength(NonNull::new(buf.as_mut_ptr()).expect("buf ptr"), buf.len())
            };
            if n <= 0 {
                trace!(id, "apple L2CAP reactor input returned EOF/closed");
                return false;
            }
            buf.truncate(n.cast_unsigned());
            trace!(
                id,
                len = buf.len(),
                "apple L2CAP reactor forwarding inbound chunk"
            );
            if self.inbound_tx.send(buf).is_err() {
                trace!(id, "apple L2CAP reactor inbound channel closed");
                return false;
            }
        }

        true
    }
}

impl L2capReactor {
    fn new(cmd_rx: mpsc::Receiver<ReactorCmd>) -> Self {
        Self {
            cmd_rx,
            channels: HashMap::new(),
        }
    }

    fn run(mut self, waker_tx: &mpsc::SyncSender<RunLoopWaker>) {
        autoreleasepool(|_| {
            trace!("apple L2CAP reactor started");
            let run_loop = NSRunLoop::currentRunLoop();
            let _ = waker_tx.send(install_wake_source());
            loop {
                autoreleasepool(|_| {
                    self.drain_commands(&run_loop);
                    self.flush_all(&run_loop);
                    self.forward_available_input(&run_loop);
                    let backlog = self.channels.values().any(ReactorChannel::has_backlog);
                    Self::poll_run_loop(
                        &run_loop,
                        if backlog {
                            RUN_LOOP_BACKLOG_SECS
                        } else {
                            RUN_LOOP_IDLE_SECS
                        },
                    );
                });
            }
        });
    }

    fn drain_commands(&mut self, run_loop: &NSRunLoop) {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            match cmd {
                ReactorCmd::Register(channel) => self.register_channel(run_loop, channel),
                ReactorCmd::Write { id, data } => self.write_channel(run_loop, id, &data),
                ReactorCmd::Close { id } => self.remove_channel(run_loop, id, "close requested"),
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
            flow,
        } = channel;

        trace!(id, "apple L2CAP reactor registering channel");
        unsafe {
            input.scheduleInRunLoop_forMode(run_loop, default_run_loop_mode());
            output.scheduleInRunLoop_forMode(run_loop, default_run_loop_mode());
        }
        input.open();
        output.open();
        self.channels.insert(
            id,
            ReactorChannel {
                channel_ref,
                input,
                output,
                inbound_tx,
                flow,
                pending: Vec::new(),
                sent: 0,
            },
        );
    }

    fn write_channel(&mut self, run_loop: &NSRunLoop, id: u64, data: &[u8]) {
        let should_close = self.channels.get_mut(&id).is_some_and(|channel| {
            channel.pending.extend_from_slice(data);
            !channel.flush(id)
        });
        if should_close {
            self.remove_channel(run_loop, id, "write failed");
        }
    }

    fn flush_all(&mut self, run_loop: &NSRunLoop) {
        let mut closed = Vec::new();
        for (&id, channel) in &mut self.channels {
            if channel.has_backlog() && !channel.flush(id) {
                closed.push(id);
            }
        }
        for id in closed {
            self.remove_channel(run_loop, id, "write failed");
        }
    }

    fn forward_available_input(&mut self, run_loop: &NSRunLoop) {
        let mut closed = Vec::new();
        for (&id, channel) in &self.channels {
            if !channel.forward_available_input(id) {
                closed.push(id);
            }
        }
        for id in closed {
            self.remove_channel(run_loop, id, "input ended");
        }
    }

    fn remove_channel(&mut self, run_loop: &NSRunLoop, id: u64, reason: &'static str) {
        if let Some(channel) = self.channels.remove(&id) {
            close_channel(run_loop, id, channel, reason);
        }
    }

    fn poll_run_loop(run_loop: &NSRunLoop, secs: f64) {
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
pub(crate) fn bridge_l2cap_channel(channel: &CBL2CAPChannel, runtime: &Handle) -> L2capChannel {
    let channel = Arc::new(unsafe { retain_send(channel) });

    let inp = unsafe { channel.inputStream() };
    let Some(inp) = inp else {
        warn!("apple L2CAP channel missing input stream");
        let (app_side, _io_side) = tokio::io::duplex(64);
        return L2capChannel::from_duplex(app_side);
    };
    let out = unsafe { channel.outputStream() };
    let Some(out) = out else {
        warn!("apple L2CAP channel missing output stream");
        let (app_side, _io_side) = tokio::io::duplex(64);
        return L2capChannel::from_duplex(app_side);
    };

    let input = Arc::new(unsafe { retain_send(&*inp) });
    let output = Arc::new(unsafe { retain_send(&*out) });
    let (inbound_tx, mut inbound_rx) = tokio_mpsc::unbounded_channel();
    let reactor = reactor();
    let channel_id = next_channel_id();
    let flow = Arc::new(Flow::new());

    reactor
        .send(ReactorCmd::Register(RegisterChannel {
            id: channel_id,
            channel_ref: Arc::clone(&channel),
            input,
            output,
            inbound_tx,
            flow: Arc::clone(&flow),
        }))
        .expect("apple L2CAP reactor available");

    let (app_side, io_side) = tokio::io::duplex(L2CAP_DUPLEX_BUF_SIZE);
    let (mut io_reader, mut io_writer) = tokio::io::split(io_side);

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
        }
        trace!(id = channel_id, "apple L2CAP inbound async bridge exited");
    });

    runtime.spawn(async move {
        trace!(id = channel_id, "apple L2CAP outbound async bridge started");
        let mut buf = vec![0_u8; L2CAP_READ_BUF_SIZE];
        loop {
            // Back-pressure: stop taking bytes from the app while the stream is this far behind.
            // `notify_one` stores a permit, so a drain between the check and the wait is not lost.
            while flow.pending.load(Ordering::Acquire) >= L2CAP_MAX_PENDING
                && !flow.closed.load(Ordering::Acquire)
            {
                flow.drained.notified().await;
            }
            if flow.closed.load(Ordering::Acquire) {
                trace!(
                    id = channel_id,
                    "apple L2CAP outbound async bridge stopping: channel closed"
                );
                break;
            }
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
            flow.pending.fetch_add(n, Ordering::AcqRel);
            if reactor
                .send(ReactorCmd::Write {
                    id: channel_id,
                    data: buf[..n].to_vec(),
                })
                .is_err()
            {
                trace!(
                    id = channel_id,
                    "apple L2CAP outbound async bridge stopping: reactor unavailable"
                );
                break;
            }
        }
        trace!(id = channel_id, "apple L2CAP outbound async bridge exited");
    });

    L2capChannel::from_duplex_with_close_hook(app_side, move || {
        let _ = reactor.send(ReactorCmd::Close { id: channel_id });
    })
}
