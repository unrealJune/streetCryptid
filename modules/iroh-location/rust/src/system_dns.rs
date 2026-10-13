//! iroh's DNS, answered by the operating system's resolver on Apple platforms and Android.
//!
//! iroh resolves everything that makes a phone reachable through one [`DnsResolver`]: relay
//! hostnames (the relay connection and every `net_report` probe), the `_iroh.<z32>` TXT records
//! the n0 address lookup uses to find a friend, and the HTTP client that publishes our own
//! record. Its default resolver asks hickory for the system's nameservers, and on Apple hickory
//! reads them from `SCDynamicStore` (`State:/Network/Global/DNS`), which an iOS app cannot reach.
//! iroh then logs "Failed to read the system's DNS config, using Google DNS servers as fallback"
//! and sends raw UDP/TCP queries to 8.8.8.8 / 8.8.4.4 / 2001:4860:4860::8888 for the life of the
//! process. Every iPhone in the fleet has done this.
//!
//! That works on any network which lets an app talk to Google's DNS directly, and on nothing
//! else. On 2026-10-11 an iPhone 16 had failed every lookup through it, at a bar on 2026-09-17 and
//! on home Wi-Fi alike. It never completed a relay probe in 30 days. Its telemetry, which
//! resolves through `getaddrinfo` in the same process, shipped the whole time. The phone could
//! only reach a friend over BLE or a shared LAN, and went dark the moment it left one.
//!
//! No list of nameserver IPs is right on iOS. Encrypted-DNS profiles, VPNs pushing
//! `NEDNSSettings`, split DNS, iCloud Private Relay and per-interface resolvers all live behind
//! mDNSResponder, so every query here goes to it through `DNSServiceQueryRecord` (dns_sd.h, part
//! of libSystem). That covers A, AAAA and TXT with one call. It is driven from the daemon socket
//! with tokio's `AsyncFd`, so no thread blocks, and dropping a query (iroh's per-call timeout
//! does) deallocates it, which cancels it in the daemon.
//!
//! ## Android
//!
//! Android has the same hole with a different shape. hickory CAN read the system's nameservers
//! there (over JNI, from the active network's `LinkProperties`), but only when the endpoint is
//! built and again when iroh sees a major network change, and then it sends its own UDP/TCP
//! queries to those IPs for as long as the list stands. A list read mid-handover is wrong for the
//! network the phone ends up on, and nothing replaces it. On 2026-10-13 a Pixel 10 adopted a
//! node the background service had built and, from 01:26 on, failed EVERY iroh lookup — every
//! relay connect, every pkarr publish to `dns.iroh.link` — while its telemetry and map tiles,
//! resolving through the OS in the same process, were fine. It had no relay at all and could
//! only be reached on its LAN. A list is also wrong by construction behind Private DNS and VPNs,
//! exactly as on iOS.
//!
//! So on API 29+ every query goes to netd through `android_res_nquery` (libandroid,
//! `<android/multinetwork.h>`) on `NETWORK_UNSPECIFIED`, which is the process's default network
//! as the OS sees it at the moment of the query: Private DNS, VPNs and network switches are the
//! OS's problem, not ours. The call hands back a socket that becomes readable when netd has the
//! answer; it is driven with `AsyncFd` like the Apple daemon socket, and a query dropped before
//! it answers is cancelled with `android_res_cancel`. The answer is a whole DNS message, which
//! [`wire`] reads. The symbols are looked up at run time because `minSdkVersion` is below 29; a
//! phone without them keeps iroh's resolver and says so once in the log.
//!
//! A failure names its cause in the log MESSAGE (`iroh_location::system_dns`), because Loki keeps
//! the message and drops the fields, and iroh's own `Failed to resolve` hides the source chain.
//! That opacity is why the phones above took weeks, and then a day, to explain.
//!
//! [`DnsResolver`]: iroh::dns::DnsResolver

// Elsewhere only the tests reach the pure half.
#![cfg_attr(
    not(any(target_vendor = "apple", target_os = "android")),
    allow(dead_code)
)]

/// RR types this module asks for.
pub(crate) const RR_A: u16 = 1;
pub(crate) const RR_AAAA: u16 = 28;
pub(crate) const RR_TXT: u16 = 16;

/// Decoders for the raw RDATA the OS hands back. Pure, so they are tested on every host.
pub(crate) mod rdata {
    use std::net::{Ipv4Addr, Ipv6Addr};

    pub(crate) fn a(rdata: &[u8]) -> Option<Ipv4Addr> {
        <[u8; 4]>::try_from(rdata).ok().map(Ipv4Addr::from)
    }

    pub(crate) fn aaaa(rdata: &[u8]) -> Option<Ipv6Addr> {
        <[u8; 16]>::try_from(rdata).ok().map(Ipv6Addr::from)
    }

    /// RFC 1035 §3.3.14: one or more `<length><bytes>` character strings. `None` if a length
    /// runs past the end, which is a record we must not half-read.
    pub(crate) fn txt(rdata: &[u8]) -> Option<Vec<Box<[u8]>>> {
        let mut strings = Vec::new();
        let mut rest = rdata;
        while let Some((&len, tail)) = rest.split_first() {
            let len = usize::from(len);
            if tail.len() < len {
                return None;
            }
            strings.push(tail[..len].into());
            rest = &tail[len..];
        }
        Some(strings)
    }
}

/// Reads the answer section out of a whole DNS response (RFC 1035 §4), which is what netd hands
/// back on Android. Pure, so it is tested on every host.
pub(crate) mod wire {
    /// RCODE NXDOMAIN.
    pub(crate) const RCODE_NXDOMAIN: u8 = 3;
    const CLASS_IN: u16 = 1;

    /// What a response said: its RCODE, and the RDATA of every IN answer of the type asked for.
    /// The CNAMEs on the way to the answer are skipped, as the Apple path skips intermediates.
    #[derive(Debug, PartialEq, Eq)]
    pub(crate) struct Response {
        pub(crate) rcode: u8,
        pub(crate) records: Vec<Vec<u8>>,
    }

    /// `None` if the message is truncated or malformed.
    pub(crate) fn parse(msg: &[u8], rrtype: u16) -> Option<Response> {
        let header = msg.get(..12)?;
        let rcode = header[3] & 0x0f;
        let qdcount = u16::from_be_bytes([header[4], header[5]]);
        let ancount = u16::from_be_bytes([header[6], header[7]]);
        let mut pos = 12;
        for _ in 0..qdcount {
            pos = skip_name(msg, pos)?;
            // QTYPE, QCLASS
            msg.get(pos..pos + 4)?;
            pos += 4;
        }
        let mut records = Vec::new();
        for _ in 0..ancount {
            pos = skip_name(msg, pos)?;
            let fixed = msg.get(pos..pos + 10)?;
            let rtype = u16::from_be_bytes([fixed[0], fixed[1]]);
            let class = u16::from_be_bytes([fixed[2], fixed[3]]);
            let rdlen = usize::from(u16::from_be_bytes([fixed[8], fixed[9]]));
            pos += 10;
            let rdata = msg.get(pos..pos + rdlen)?;
            pos += rdlen;
            if rtype == rrtype && class == CLASS_IN {
                records.push(rdata.to_vec());
            }
        }
        Some(Response { rcode, records })
    }

    /// Past one domain name. A compression pointer ends a name, so skipping one never needs to
    /// follow it.
    fn skip_name(msg: &[u8], mut pos: usize) -> Option<usize> {
        loop {
            let len = *msg.get(pos)?;
            match len & 0xc0 {
                0x00 if len == 0 => return Some(pos + 1),
                0x00 => pos += 1 + usize::from(len),
                0xc0 => return msg.get(pos + 1).map(|_| pos + 2),
                // 0x40 / 0x80: label types nothing uses.
                _ => return None,
            }
        }
    }

    /// The name RFC 1035 gives an RCODE, for log messages a human reads.
    pub(crate) fn rcode_name(rcode: u8) -> &'static str {
        match rcode {
            0 => "NoError",
            1 => "FormErr",
            2 => "ServFail",
            3 => "NXDomain",
            4 => "NotImp",
            5 => "Refused",
            _ => "unrecognised",
        }
    }
}

/// The name dns_sd.h gives an error code, for log messages a human reads.
pub(crate) fn dnssd_error_name(code: i32) -> &'static str {
    match code {
        -65537 => "Unknown",
        -65538 => "NoSuchName",
        -65539 => "NoMemory",
        -65540 => "BadParam",
        -65541 => "BadReference",
        -65542 => "BadState",
        -65543 => "BadFlags",
        -65544 => "Unsupported",
        -65545 => "NotInitialized",
        -65549 => "Invalid",
        -65550 => "Firewall",
        -65552 => "BadInterfaceIndex",
        -65553 => "Refused",
        -65554 => "NoSuchRecord",
        -65555 => "NoAuth",
        -65562 => "Transient",
        -65563 => "ServiceNotRunning",
        -65566 => "NoRouter",
        -65568 => "Timeout",
        -65569 => "DefunctConnection",
        -65570 => "PolicyDenied",
        -65571 => "NotPermitted",
        _ => "unrecognised",
    }
}

fn rr_name(rrtype: u16) -> &'static str {
    match rrtype {
        RR_A => "A",
        RR_AAAA => "AAAA",
        RR_TXT => "TXT",
        _ => "?",
    }
}

/// Logs a failed lookup. Fields don't survive Loki, so the message carries everything; a
/// negative answer (NXDOMAIN, no records of that type) is an answer, not a fault, and logs quieter.
#[cfg(any(target_vendor = "apple", target_os = "android"))]
fn log_failure(host: &str, rrtype: u16, err: &dyn std::fmt::Display, negative: bool) {
    let msg = format!("system dns: {} {host} failed: {err}", rr_name(rrtype));
    if negative {
        tracing::trace!("{msg}");
    } else {
        tracing::debug!("{msg}");
    }
}

#[cfg(any(target_vendor = "apple", target_os = "android"))]
pub(crate) use system::resolver;

/// iroh's [`Resolver`](iroh::dns::Resolver) over this platform's OS resolver. The platform
/// modules only answer "the RDATA for this name and type".
#[cfg(any(target_vendor = "apple", target_os = "android"))]
mod system {
    use std::future::Future;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::pin::Pin;

    use iroh::dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData};

    #[cfg(target_os = "android")]
    use super::android as platform;
    #[cfg(target_vendor = "apple")]
    use super::apple as platform;
    use super::{rdata, RR_A, RR_AAAA, RR_TXT};

    type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

    #[derive(Debug)]
    struct Malformed;

    impl std::fmt::Display for Malformed {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "malformed record data")
        }
    }

    impl std::error::Error for Malformed {}

    fn decode<T>(records: Vec<Vec<u8>>, f: fn(&[u8]) -> Option<T>) -> Result<Vec<T>, DnsError> {
        records
            .iter()
            .map(|r| f(r.as_slice()))
            .collect::<Option<Vec<T>>>()
            .ok_or_else(|| DnsError::from(n0_error::AnyError::from_std(Malformed)))
    }

    #[derive(Debug, Default)]
    struct SystemResolver;

    impl Resolver for SystemResolver {
        fn lookup_ipv4(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv4Addr>, DnsError>> {
            Box::pin(async move {
                let addrs = decode(platform::query(host, RR_A).await?, rdata::a)?;
                Ok(Box::new(addrs.into_iter()) as BoxIter<Ipv4Addr>)
            })
        }

        fn lookup_ipv6(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv6Addr>, DnsError>> {
            Box::pin(async move {
                let addrs = decode(platform::query(host, RR_AAAA).await?, rdata::aaaa)?;
                Ok(Box::new(addrs.into_iter()) as BoxIter<Ipv6Addr>)
            })
        }

        fn lookup_txt(&self, host: String) -> BoxFuture<Result<BoxIter<TxtRecordData>, DnsError>> {
            Box::pin(async move {
                let records = decode(platform::query(host, RR_TXT).await?, rdata::txt)?;
                Ok(Box::new(records.into_iter().map(TxtRecordData::from))
                    as BoxIter<TxtRecordData>)
            })
        }

        /// The OS owns the cache, and shares it with every other process.
        fn clear_cache(&self) {}

        /// Nothing to rebind: every query is its own call into the OS, which tracks network
        /// changes itself. A reset that re-reads a nameserver list is what stranded the Pixel in
        /// the module docs.
        fn reset(&self) -> Box<dyn Resolver> {
            Box::new(SystemResolver)
        }
    }

    /// The resolver `LocationNode::start` hands the endpoint, or `None` where the OS offers no
    /// resolver API (Android below 29), which keeps iroh's own.
    pub(crate) fn resolver() -> Option<DnsResolver> {
        match platform::backend() {
            Ok(backend) => {
                tracing::info!("system dns: iroh lookups go through {backend}");
                Some(DnsResolver::custom(SystemResolver))
            }
            Err(why) => {
                tracing::warn!("system dns: unavailable ({why}); iroh keeps its own resolver");
                None
            }
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::fmt;
    use std::os::fd::{AsRawFd, RawFd};
    use std::sync::OnceLock;

    use iroh::dns::DnsError;
    use tokio::io::unix::AsyncFd;

    use super::{log_failure, wire};

    /// `net_handle_t` 0, `NETWORK_UNSPECIFIED`: whatever the OS considers this process's default
    /// network when the query is made.
    const NETWORK_UNSPECIFIED: u64 = 0;
    const CLASS_IN: c_int = 1;
    /// The largest DNS message there is; netd retries a truncated UDP answer over TCP itself.
    const ANSWER_MAX: usize = 65_535;

    // <android/multinetwork.h>, API 29.
    type NQuery = unsafe extern "C" fn(
        network: u64,
        dname: *const c_char,
        ns_class: c_int,
        ns_type: c_int,
        flags: u32,
    ) -> c_int;
    type NResult =
        unsafe extern "C" fn(fd: c_int, rcode: *mut c_int, answer: *mut u8, anslen: usize) -> c_int;
    type Cancel = unsafe extern "C" fn(fd: c_int);

    struct Api {
        nquery: NQuery,
        nresult: NResult,
        cancel: Cancel,
    }

    fn api() -> Result<&'static Api, &'static str> {
        static API: OnceLock<Result<Api, &'static str>> = OnceLock::new();
        API.get_or_init(load).as_ref().map_err(|why| *why)
    }

    fn load() -> Result<Api, &'static str> {
        // SAFETY: dlopen/dlsym with NUL-terminated names. The handle is never closed, so the
        // symbols stay valid for the life of the process, and each one is transmuted to the
        // signature multinetwork.h declares for it.
        unsafe {
            let lib = libc::dlopen(c"libandroid.so".as_ptr(), libc::RTLD_NOW);
            if lib.is_null() {
                return Err("libandroid.so did not load");
            }
            let nquery = libc::dlsym(lib, c"android_res_nquery".as_ptr());
            let nresult = libc::dlsym(lib, c"android_res_nresult".as_ptr());
            let cancel = libc::dlsym(lib, c"android_res_cancel".as_ptr());
            if nquery.is_null() || nresult.is_null() || cancel.is_null() {
                return Err("android_res_nquery needs API 29");
            }
            Ok(Api {
                nquery: std::mem::transmute::<*mut c_void, NQuery>(nquery),
                nresult: std::mem::transmute::<*mut c_void, NResult>(nresult),
                cancel: std::mem::transmute::<*mut c_void, Cancel>(cancel),
            })
        }
    }

    /// A lookup that did not produce records, with the reason netd gave.
    #[derive(Debug)]
    enum QueryError {
        BadName,
        Unavailable(&'static str),
        /// `android_res_nquery` refused, with the errno.
        Start(i32),
        /// `android_res_nresult` failed, with the errno (`ETIMEDOUT` is netd giving up).
        Result(i32),
        /// An answer with a failing RCODE.
        Rcode(u8),
        /// NOERROR with no record of the type asked for.
        NoData,
        Socket(std::io::Error),
        Malformed,
    }

    impl QueryError {
        fn is_negative(&self) -> bool {
            matches!(
                self,
                QueryError::Rcode(wire::RCODE_NXDOMAIN) | QueryError::NoData
            )
        }
    }

    impl fmt::Display for QueryError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                QueryError::BadName => write!(f, "name contains a NUL byte"),
                QueryError::Unavailable(why) => write!(f, "{why}"),
                QueryError::Start(errno) => write!(
                    f,
                    "android_res_nquery refused: {}",
                    std::io::Error::from_raw_os_error(*errno)
                ),
                QueryError::Result(errno) => write!(
                    f,
                    "android_res_nresult: {}",
                    std::io::Error::from_raw_os_error(*errno)
                ),
                QueryError::Rcode(rcode) => write!(f, "{} ({rcode})", wire::rcode_name(*rcode)),
                QueryError::NoData => write!(f, "no records of that type"),
                QueryError::Socket(e) => write!(f, "netd socket: {e}"),
                QueryError::Malformed => write!(f, "malformed answer"),
            }
        }
    }

    impl std::error::Error for QueryError {}

    struct NetdFd(RawFd);

    impl AsRawFd for NetdFd {
        fn as_raw_fd(&self) -> RawFd {
            self.0
        }
    }

    /// One in-flight `android_res_nquery`. Dropping it before the answer is read cancels it.
    struct Query {
        api: &'static Api,
        /// The socket netd answers on; -1 once `android_res_nresult` has consumed (closed) it.
        raw: RawFd,
        fd: Option<AsyncFd<NetdFd>>,
    }

    impl Query {
        fn start(name: &str, rrtype: u16) -> Result<Self, QueryError> {
            let api = api().map_err(QueryError::Unavailable)?;
            let name = CString::new(name).map_err(|_| QueryError::BadName)?;
            // SAFETY: a valid C string for the duration of the call; flags 0 = netd's defaults
            // (its cache, its retries).
            let raw = unsafe {
                (api.nquery)(
                    NETWORK_UNSPECIFIED,
                    name.as_ptr(),
                    CLASS_IN,
                    c_int::from(rrtype),
                    0,
                )
            };
            if raw < 0 {
                return Err(QueryError::Start(-raw));
            }
            let mut query = Query { api, raw, fd: None };
            // On failure Drop cancels the query, which closes the socket.
            query.fd = Some(AsyncFd::new(NetdFd(raw)).map_err(QueryError::Socket)?);
            Ok(query)
        }

        async fn run(mut self, rrtype: u16) -> Result<Vec<Vec<u8>>, QueryError> {
            {
                let fd = self.fd.as_ref().expect("set by start");
                let _ready = fd.readable().await.map_err(QueryError::Socket)?;
            }
            // Deregister before `nresult` closes the socket under the reactor.
            self.fd.take();
            let raw = std::mem::replace(&mut self.raw, -1);
            let mut rcode: c_int = 0;
            let mut answer = vec![0u8; ANSWER_MAX];
            // SAFETY: `raw` is the live query socket, consumed (closed) exactly once, here;
            // `answer` is writable for its whole length.
            let len =
                unsafe { (self.api.nresult)(raw, &mut rcode, answer.as_mut_ptr(), answer.len()) };
            if len < 0 {
                return Err(QueryError::Result(-len));
            }
            answer.truncate(len as usize);
            let response = wire::parse(&answer, rrtype).ok_or(QueryError::Malformed)?;
            if !response.records.is_empty() {
                return Ok(response.records);
            }
            Err(match response.rcode {
                0 => QueryError::NoData,
                rcode => QueryError::Rcode(rcode),
            })
        }
    }

    impl Drop for Query {
        fn drop(&mut self) {
            self.fd.take();
            if self.raw >= 0 {
                // SAFETY: the query socket has not been consumed; cancel closes it, exactly once.
                unsafe { (self.api.cancel)(self.raw) };
            }
        }
    }

    pub(super) async fn query(host: String, rrtype: u16) -> Result<Vec<Vec<u8>>, DnsError> {
        let result = match Query::start(&host, rrtype) {
            Ok(q) => q.run(rrtype).await,
            Err(e) => Err(e),
        };
        result.map_err(|e| {
            log_failure(&host, rrtype, &e, e.is_negative());
            DnsError::from(n0_error::AnyError::from_std(e))
        })
    }

    pub(super) fn backend() -> Result<&'static str, &'static str> {
        api().map(|_| "netd (android_res_nquery)")
    }
}

#[cfg(target_vendor = "apple")]
mod apple {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::fmt;
    use std::os::fd::{AsRawFd, RawFd};

    use iroh::dns::DnsError;
    use tokio::io::unix::AsyncFd;

    use super::{dnssd_error_name, log_failure, RR_TXT};

    #[repr(C)]
    struct DnsServiceOpaque {
        _private: [u8; 0],
    }
    type DnsServiceRef = *mut DnsServiceOpaque;

    type QueryRecordReply = extern "C" fn(
        sd_ref: DnsServiceRef,
        flags: u32,
        interface_index: u32,
        error_code: i32,
        fullname: *const c_char,
        rrtype: u16,
        rrclass: u16,
        rdlen: u16,
        rdata: *const c_void,
        ttl: u32,
        context: *mut c_void,
    );

    // dns_sd.h. These live in libSystem, which every Apple binary links already.
    extern "C" {
        fn DNSServiceQueryRecord(
            sd_ref: *mut DnsServiceRef,
            flags: u32,
            interface_index: u32,
            fullname: *const c_char,
            rrtype: u16,
            rrclass: u16,
            callback: QueryRecordReply,
            context: *mut c_void,
        ) -> i32;
        fn DNSServiceRefSockFD(sd_ref: DnsServiceRef) -> c_int;
        fn DNSServiceProcessResult(sd_ref: DnsServiceRef) -> i32;
        fn DNSServiceRefDeallocate(sd_ref: DnsServiceRef);
    }

    const FLAG_MORE_COMING: u32 = 0x1;
    const FLAG_ADD: u32 = 0x2;
    /// Delivers negative answers (NXDOMAIN, no such record) as an error callback. Without it a
    /// name that does not exist is a query that never answers, and a friend who has not
    /// published to the n0 DNS would cost a full timeout on every lookup.
    const FLAG_RETURN_INTERMEDIATES: u32 = 0x1000;
    /// Drops A/AAAA records this host cannot use on its current networks.
    const FLAG_SUPPRESS_UNUSABLE: u32 = 0x8000;
    const INTERFACE_ANY: u32 = 0;
    const CLASS_IN: u16 = 1;
    const ERR_NO_SUCH_RECORD: i32 = -65554;
    const ERR_NO_SUCH_NAME: i32 = -65538;

    /// A lookup that did not produce records, with the reason mDNSResponder gave.
    #[derive(Debug)]
    enum QueryError {
        BadName,
        Start(i32),
        Process(i32),
        Answer(i32),
        Socket(std::io::Error),
    }

    impl QueryError {
        /// NXDOMAIN / no such record: an answer, not a fault. Logged quieter.
        fn is_negative(&self) -> bool {
            matches!(
                self,
                QueryError::Answer(ERR_NO_SUCH_RECORD) | QueryError::Answer(ERR_NO_SUCH_NAME)
            )
        }
    }

    impl fmt::Display for QueryError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                QueryError::BadName => write!(f, "name contains a NUL byte"),
                QueryError::Start(c) => {
                    write!(
                        f,
                        "DNSServiceQueryRecord refused: {} ({c})",
                        dnssd_error_name(*c)
                    )
                }
                QueryError::Process(c) => {
                    write!(
                        f,
                        "daemon connection failed: {} ({c})",
                        dnssd_error_name(*c)
                    )
                }
                QueryError::Answer(c) => write!(f, "{} ({c})", dnssd_error_name(*c)),
                QueryError::Socket(e) => write!(f, "daemon socket: {e}"),
            }
        }
    }

    impl std::error::Error for QueryError {}

    /// What the reply callback accumulates. Lives on the heap behind a raw pointer for as long as
    /// the `DNSServiceRef` that writes to it.
    struct Answers {
        rrtype: u16,
        records: Vec<Vec<u8>>,
        error: Option<i32>,
        done: bool,
    }

    extern "C" fn on_reply(
        _sd_ref: DnsServiceRef,
        flags: u32,
        _interface_index: u32,
        error_code: i32,
        _fullname: *const c_char,
        rrtype: u16,
        _rrclass: u16,
        rdlen: u16,
        rdata: *const c_void,
        _ttl: u32,
        context: *mut c_void,
    ) {
        // SAFETY: `context` is the `Answers` pointer `Query::start` registered; it is freed only
        // after the ref is deallocated, and callbacks run synchronously inside
        // `DNSServiceProcessResult` on the thread that owns the query.
        let answers = unsafe { &mut *(context as *mut Answers) };
        if error_code != 0 {
            // A negative answer after real records (a second, empty RRset) changes nothing.
            if answers.records.is_empty() {
                answers.error = Some(error_code);
            }
            answers.done = true;
            return;
        }
        // Intermediates include the CNAMEs on the way to the answer; keep only the type asked for.
        if flags & FLAG_ADD != 0 && rrtype == answers.rrtype && !rdata.is_null() {
            // SAFETY: mDNSResponder guarantees `rdlen` readable bytes at `rdata` for the call.
            let bytes =
                unsafe { std::slice::from_raw_parts(rdata as *const u8, usize::from(rdlen)) };
            answers.records.push(bytes.to_vec());
        }
        if flags & FLAG_MORE_COMING == 0 && !answers.records.is_empty() {
            answers.done = true;
        }
    }

    struct DaemonFd(RawFd);

    impl AsRawFd for DaemonFd {
        fn as_raw_fd(&self) -> RawFd {
            self.0
        }
    }

    /// One in-flight `DNSServiceQueryRecord`. Dropping it cancels the query.
    struct Query {
        sd_ref: DnsServiceRef,
        answers: *mut Answers,
        fd: Option<AsyncFd<DaemonFd>>,
    }

    // SAFETY: the ref and the answers are only ever touched through `&mut self`, so never from
    // two threads at once; moving them between tokio workers between polls is what dns_sd allows.
    unsafe impl Send for Query {}

    impl Query {
        fn start(name: &str, rrtype: u16) -> Result<Self, QueryError> {
            let name = CString::new(name).map_err(|_| QueryError::BadName)?;
            let answers = Box::into_raw(Box::new(Answers {
                rrtype,
                records: Vec::new(),
                error: None,
                done: false,
            }));
            let mut flags = FLAG_RETURN_INTERMEDIATES;
            if rrtype != RR_TXT {
                flags |= FLAG_SUPPRESS_UNUSABLE;
            }
            let mut sd_ref: DnsServiceRef = std::ptr::null_mut();
            // SAFETY: every pointer is valid for the call; `answers` outlives the ref (see Drop).
            let err = unsafe {
                DNSServiceQueryRecord(
                    &mut sd_ref,
                    flags,
                    INTERFACE_ANY,
                    name.as_ptr(),
                    rrtype,
                    CLASS_IN,
                    on_reply,
                    answers as *mut c_void,
                )
            };
            // On failure dns_sd leaves the out-parameter unspecified, so Drop must not see it.
            let mut query = Query {
                sd_ref: if err == 0 {
                    sd_ref
                } else {
                    std::ptr::null_mut()
                },
                answers,
                fd: None,
            };
            if err != 0 {
                return Err(QueryError::Start(err));
            }
            // SAFETY: `sd_ref` is a live ref that `DNSServiceQueryRecord` just returned.
            let raw = unsafe { DNSServiceRefSockFD(query.sd_ref) };
            if raw < 0 {
                return Err(QueryError::Socket(std::io::Error::other(
                    "no daemon socket",
                )));
            }
            query.fd = Some(AsyncFd::new(DaemonFd(raw)).map_err(QueryError::Socket)?);
            Ok(query)
        }

        async fn run(self) -> Result<Vec<Vec<u8>>, QueryError> {
            loop {
                let fd = self.fd.as_ref().expect("set by start");
                let mut ready = fd.readable().await.map_err(QueryError::Socket)?;
                // The registration is edge-triggered, so drain everything the daemon has sent
                // before clearing readiness, or a second reply already in the socket would sit
                // there until iroh's timeout.
                loop {
                    // SAFETY: live ref; the socket is readable, so this does not block.
                    let err = unsafe { DNSServiceProcessResult(self.sd_ref) };
                    if err != 0 {
                        return Err(QueryError::Process(err));
                    }
                    // SAFETY: no callback is running (we are not inside ProcessResult).
                    let answers = unsafe { &mut *self.answers };
                    if answers.done {
                        return match answers.error {
                            Some(code) => Err(QueryError::Answer(code)),
                            None => Ok(std::mem::take(&mut answers.records)),
                        };
                    }
                    if !pending(fd.get_ref().0) {
                        break;
                    }
                }
                ready.clear_ready();
            }
        }
    }

    impl Drop for Query {
        fn drop(&mut self) {
            // Deregister before the daemon closes the socket, then free the callback context
            // only once nothing can call into it.
            self.fd.take();
            if !self.sd_ref.is_null() {
                // SAFETY: the ref is live and deallocated exactly once, here.
                unsafe { DNSServiceRefDeallocate(self.sd_ref) };
            }
            // SAFETY: allocated by `Box::into_raw` in `start`, freed exactly once, here.
            drop(unsafe { Box::from_raw(self.answers) });
        }
    }

    fn pending(fd: RawFd) -> bool {
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd, zero timeout.
        unsafe { libc::poll(&mut poll, 1, 0) > 0 }
    }

    pub(super) async fn query(host: String, rrtype: u16) -> Result<Vec<Vec<u8>>, DnsError> {
        let result = match Query::start(&host, rrtype) {
            Ok(q) => q.run().await,
            Err(e) => Err(e),
        };
        result.map_err(|e| {
            log_failure(&host, rrtype, &e, e.is_negative());
            DnsError::from(n0_error::AnyError::from_std(e))
        })
    }

    /// mDNSResponder is always there.
    pub(super) fn backend() -> Result<&'static str, &'static str> {
        Ok("mDNSResponder")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn decodes_address_records() {
        assert_eq!(rdata::a(&[192, 0, 2, 7]), Some(Ipv4Addr::new(192, 0, 2, 7)));
        assert_eq!(rdata::a(&[192, 0, 2]), None);
        let v6 = Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1);
        assert_eq!(rdata::aaaa(&v6.octets()), Some(v6));
        assert_eq!(rdata::aaaa(&[0; 4]), None);
    }

    #[test]
    fn decodes_txt_character_strings() {
        let rdata = b"\x0crelay=https:\x00\x05a=b c";
        let strings = rdata::txt(rdata).unwrap();
        assert_eq!(
            strings,
            vec![
                b"relay=https:".to_vec().into_boxed_slice(),
                Vec::new().into_boxed_slice(),
                b"a=b c".to_vec().into_boxed_slice(),
            ]
        );
        assert_eq!(rdata::txt(b""), Some(vec![]));
    }

    #[test]
    fn refuses_a_truncated_txt_string() {
        assert_eq!(rdata::txt(b"\x05abc"), None);
    }

    #[test]
    fn names_the_errors_that_matter() {
        assert_eq!(dnssd_error_name(-65554), "NoSuchRecord");
        assert_eq!(dnssd_error_name(-65538), "NoSuchName");
        assert_eq!(dnssd_error_name(-65570), "PolicyDenied");
        assert_eq!(dnssd_error_name(1), "unrecognised");
        assert_eq!(wire::rcode_name(wire::RCODE_NXDOMAIN), "NXDomain");
        assert_eq!(wire::rcode_name(2), "ServFail");
    }

    /// `iroh-wus.streetcrypt.id. A`, answered through a CNAME, with name compression throughout
    /// — the shape a resolver behind a CDN or a captive network returns.
    fn cname_then_a() -> Vec<u8> {
        let mut m = vec![
            0x12, 0x34, // id
            0x81, 0x80, // QR RD RA, NOERROR
            0x00, 0x01, // QDCOUNT
            0x00, 0x02, // ANCOUNT
            0x00, 0x00, 0x00, 0x00, // NSCOUNT, ARCOUNT
        ];
        // Question at offset 12.
        m.extend_from_slice(b"\x08iroh-wus\x0bstreetcrypt\x02id\x00");
        m.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
        // CNAME: name = pointer to 12, rdata = "edge" + pointer to "streetcrypt.id" (offset 21).
        m.extend_from_slice(&[
            0xc0, 0x0c, 0x00, 0x05, 0x00, 0x01, 0, 0, 0x01, 0x2c, 0x00, 0x07,
        ]);
        m.extend_from_slice(b"\x04edge\xc0\x15");
        // A: name = pointer to the CNAME target.
        let target = (m.len() - 7) as u8;
        m.extend_from_slice(&[
            0xc0, target, 0x00, 0x01, 0x00, 0x01, 0, 0, 0x01, 0x2c, 0x00, 0x04,
        ]);
        m.extend_from_slice(&[20, 237, 162, 186]);
        m
    }

    #[test]
    fn reads_the_answer_through_a_cname() {
        let msg = cname_then_a();
        let response = wire::parse(&msg, RR_A).unwrap();
        assert_eq!(response.rcode, 0);
        assert_eq!(response.records, vec![vec![20, 237, 162, 186]]);
        // Asking for a type the answer does not carry is NOERROR with nothing in it.
        assert_eq!(
            wire::parse(&msg, RR_AAAA).unwrap().records,
            Vec::<Vec<u8>>::new()
        );
    }

    #[test]
    fn reads_the_rcode_of_a_negative_answer() {
        let mut msg = vec![0x12, 0x34, 0x81, 0x83, 0, 1, 0, 0, 0, 0, 0, 0];
        msg.extend_from_slice(b"\x07missing\x02id\x00\x00\x10\x00\x01");
        let response = wire::parse(&msg, RR_TXT).unwrap();
        assert_eq!(response.rcode, wire::RCODE_NXDOMAIN);
        assert!(response.records.is_empty());
    }

    #[test]
    fn refuses_a_truncated_message() {
        let msg = cname_then_a();
        // Every strict prefix is either missing the header or cuts a record short.
        for len in 0..msg.len() {
            assert_eq!(
                wire::parse(&msg[..len], RR_A),
                None,
                "prefix of {len} bytes"
            );
        }
        // A reserved label type is not a name.
        let mut bad = vec![0x12, 0x34, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0];
        bad.extend_from_slice(&[0x40, 0x00, 0x00, 0x01, 0x00, 0x01]);
        assert_eq!(wire::parse(&bad, RR_A), None);
    }
}
