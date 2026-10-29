//! A span's enter guard is never held across an `await`, enforced against the source.
//!
//! `Span::enter()` is a promise that the span is exited on the SAME thread, and an `await` breaks
//! it: the future can resume on another thread (UniFFI polls each foreign call on whatever Swift
//! or Kotlin pool thread the host hands it), and the guard then exits there. Beyond mis-parenting
//! spans, that is fatal here. With context activation on, `tracing-opentelemetry` pushes an
//! OpenTelemetry `ContextGuard` onto a thread-local stack on enter and pops it by span id on exit;
//! an exit on another thread finds nothing to pop, so the guard stays on the first thread's stack
//! until that thread retires. Its thread-local destructor then drops the guard, which reaches
//! for OpenTelemetry's own thread-local context — already destroyed — and panics, and a second
//! guard panicking in the same cleanup aborts the process.
//!
//! That is the 2026-10-29 06:26:21 UTC crash: an iPhone 16 Pro Max died 20 s after accepting a
//! pair, with no crash dialog, on a pool thread that held stale guards from `pair.handshake`,
//! `pair.accept` and `pair.dial`. MetricKit's stack was `libsystem_pthread` → `libdyld` (TLS
//! destructors) → the guard-stack drop → `abort`.
//!
//! **Need a span around async work?** `.instrument(span.clone())` the future (`tracing::Instrument`)
//! — it enters and exits around each poll, on the polling thread. A synchronous section may still
//! use `span.enter()` or `span.in_scope(..)`.

use std::path::{Path, PathBuf};

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_span_guard_is_held_across_an_await() {
    let mut files = Vec::new();
    rust_sources(Path::new("src"), &mut files);
    assert!(!files.is_empty(), "found no sources under src/");

    let mut offences: Vec<String> = Vec::new();
    for file in files {
        let src = std::fs::read_to_string(&file).expect("read source");
        let lines: Vec<&str> = src.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            // Only a guard BOUND to a name can outlive its statement; `drop(span.entered())` and
            // `span.in_scope(..)` cannot.
            if !(trimmed.starts_with("let ")
                && (trimmed.contains(".enter();") || trimmed.contains(".entered();")))
            {
                continue;
            }
            let indent = line.len() - trimmed.len();
            // Walk to the end of the guard's scope: the first line closing a block outside it.
            for (offset, following) in lines[index + 1..].iter().enumerate() {
                let rest = following.trim_start();
                let closes_scope = rest.starts_with('}') && (following.len() - rest.len()) < indent;
                if closes_scope {
                    break;
                }
                if following.contains(".await") {
                    offences.push(format!(
                        "{}:{}: span guard still entered at line {}: {}",
                        file.display(),
                        index + 1,
                        index + offset + 2,
                        rest
                    ));
                    break;
                }
            }
        }
    }

    assert!(
        offences.is_empty(),
        "a span guard is held across an await — the future can resume on another thread, the \
         OpenTelemetry context guard stays behind on this one, and when this thread exits the \
         process aborts. Use `.instrument(span.clone())` on the future instead.\n  {}",
        offences.join("\n  ")
    );
}
