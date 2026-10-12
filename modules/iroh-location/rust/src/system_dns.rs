//! iroh's DNS, answered by the operating system's resolver on Apple platforms.
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
//! A failure names its cause in the log MESSAGE (`iroh_location::system_dns`), because Loki keeps
//! the message and drops the fields, and iroh's own `Failed to resolve` hides the source chain.
//! That opacity is why the phone above took weeks to explain.
//!
//! [`DnsResolver`]: iroh::dns::DnsResolver

// Off Apple only the tests reach the pure half; Android reads the real system DNS over JNI.
#![cfg_attr(not(target_vendor = "apple"), allow(dead_code))]

/// RR types this module asks for.
pub(crate) const RR_A: u16 = 1;
pub(crate) const RR_AAAA: u16 = 28;
pub(crate) const RR_TXT: u16 = 16;

/// Decoders for the raw RDATA mDNSResponder hands back. Pure, so they are tested on every host.
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

#[cfg(target_vendor = "apple")]
pub(crate) use apple::resolver;

#[cfg(target_vendor = "apple")]
mod apple {
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::fmt;
    use std::future::Future;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::os::fd::{AsRawFd, RawFd};
    use std::pin::Pin;

    use iroh::dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData};
    use tokio::io::unix::AsyncFd;

    use super::{dnssd_error_name, rdata, RR_A, RR_AAAA, RR_TXT};

    type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

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
        Malformed,
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
                QueryError::Malformed => write!(f, "malformed record data"),
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

    fn rr_name(rrtype: u16) -> &'static str {
        match rrtype {
            RR_A => "A",
            RR_AAAA => "AAAA",
            RR_TXT => "TXT",
            _ => "?",
        }
    }

    async fn query(host: String, rrtype: u16) -> Result<Vec<Vec<u8>>, DnsError> {
        let result = match Query::start(&host, rrtype) {
            Ok(q) => q.run().await,
            Err(e) => Err(e),
        };
        result.map_err(|e| {
            // Fields don't survive Loki, so the message carries everything.
            let msg = format!("system dns: {} {host} failed: {e}", rr_name(rrtype));
            if e.is_negative() {
                tracing::trace!("{msg}");
            } else {
                tracing::debug!("{msg}");
            }
            DnsError::from(n0_error::AnyError::from_std(e))
        })
    }

    fn decode<T>(records: Vec<Vec<u8>>, f: fn(&[u8]) -> Option<T>) -> Result<Vec<T>, DnsError> {
        records
            .iter()
            .map(|r| f(r.as_slice()))
            .collect::<Option<Vec<T>>>()
            .ok_or_else(|| DnsError::from(n0_error::AnyError::from_std(QueryError::Malformed)))
    }

    /// iroh's [`Resolver`], answered by mDNSResponder.
    #[derive(Debug, Default)]
    struct SystemResolver;

    impl Resolver for SystemResolver {
        fn lookup_ipv4(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv4Addr>, DnsError>> {
            Box::pin(async move {
                let addrs = decode(query(host, RR_A).await?, rdata::a)?;
                Ok(Box::new(addrs.into_iter()) as BoxIter<Ipv4Addr>)
            })
        }

        fn lookup_ipv6(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv6Addr>, DnsError>> {
            Box::pin(async move {
                let addrs = decode(query(host, RR_AAAA).await?, rdata::aaaa)?;
                Ok(Box::new(addrs.into_iter()) as BoxIter<Ipv6Addr>)
            })
        }

        fn lookup_txt(&self, host: String) -> BoxFuture<Result<BoxIter<TxtRecordData>, DnsError>> {
            Box::pin(async move {
                let records = decode(query(host, RR_TXT).await?, rdata::txt)?;
                Ok(Box::new(records.into_iter().map(TxtRecordData::from))
                    as BoxIter<TxtRecordData>)
            })
        }

        /// mDNSResponder owns the cache, and it is shared with every other process.
        fn clear_cache(&self) {}

        /// Nothing to rebind: each query opens its own daemon connection, and mDNSResponder
        /// tracks network changes itself.
        fn reset(&self) -> Box<dyn Resolver> {
            Box::new(SystemResolver)
        }
    }

    /// The resolver `LocationNode::start` hands the endpoint on Apple platforms.
    pub(crate) fn resolver() -> DnsResolver {
        tracing::info!("system dns: iroh lookups go through mDNSResponder");
        DnsResolver::custom(SystemResolver)
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
    }
}
