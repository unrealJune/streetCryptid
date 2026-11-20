use std::cell::Cell;
use std::ffi::{c_char, c_void};

type CFRef = *const c_void;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(allocator: CFRef, text: *const c_char, encoding: u32) -> CFRef;
    fn CFEqual(left: CFRef, right: CFRef) -> u8;
    fn CFRelease(value: CFRef);
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPSCopyPowerSourcesInfo() -> CFRef;
    fn IOPSGetProvidingPowerSourceType(info: CFRef) -> CFRef;
    fn IOPMAssertionCreateWithName(
        kind: CFRef,
        level: u32,
        name: CFRef,
        assertion: *mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(assertion: u32) -> i32;
}

thread_local! {
    static ASSERTION: Cell<Option<u32>> = const { Cell::new(None) };
}

fn string(text: &'static [u8]) -> CFRef {
    // SAFETY: callers supply a static, NUL-terminated UTF-8 string; null is the default allocator.
    unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr().cast(), 0x0800_0100) }
}

pub fn on_ac() -> bool {
    // SAFETY: Copy returns an owned snapshot. Get's borrowed string is used before releasing it.
    unsafe {
        let info = IOPSCopyPowerSourcesInfo();
        if info.is_null() {
            return false;
        }
        let source = IOPSGetProvidingPowerSourceType(info);
        let ac = string(b"AC Power\0");
        let result = !source.is_null() && !ac.is_null() && CFEqual(source, ac) != 0;
        if !ac.is_null() {
            CFRelease(ac);
        }
        CFRelease(info);
        result
    }
}

pub fn hold_awake(wanted: bool) -> bool {
    ASSERTION.with(|slot| {
        if let Some(id) = slot.get() {
            if wanted {
                return true;
            }
            // SAFETY: this thread owns the live assertion. On failure keep reporting it held.
            if unsafe { IOPMAssertionRelease(id) } == 0 {
                slot.set(None);
            }
            return slot.get().is_some();
        }
        if !wanted {
            return false;
        }
        let kind = string(b"PreventUserIdleSystemSleep\0");
        let name = string(b"streetCryptid repeater on mains power\0");
        let mut id = 0;
        // SAFETY: strings remain alive through the call; id is writable. Level 1 is on.
        let ok = unsafe {
            let ok = !kind.is_null()
                && !name.is_null()
                && IOPMAssertionCreateWithName(kind, 1, name, &mut id) == 0;
            if !kind.is_null() {
                CFRelease(kind);
            }
            if !name.is_null() {
                CFRelease(name);
            }
            ok
        };
        if ok {
            slot.set(Some(id));
        }
        ok
    })
}
