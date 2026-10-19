pub mod core;
#[cfg(not(target_arch = "wasm32"))]
mod json;
mod profile;
pub mod wire;
pub mod writer;

// 保留已有 Rust 路径和 C ABI 符号，诊断实现独立维护。
pub use profile::*;

use core::{Options, Scanner};
use wire::Output;

pub struct Buffer(Vec<u8>);
fn result(output: Output) -> *mut Buffer {
    Box::into_raw(Box::new(Buffer(output.0)))
}
fn text_result(value: Result<Vec<u16>, String>) -> *mut Buffer {
    let mut out = Output::new();
    match value {
        Ok(value) => {
            out.number(0);
            out.text(&value);
        }
        Err(error) => {
            out.number(1);
            out.text(&core::text(&error));
        }
    }
    result(out)
}

// 此 ABI 只供受控绑定调用。分配与释放必须配对，指针/长度由绑定负责保存。
#[unsafe(no_mangle)]
pub extern "C" fn mm_alloc(length: usize) -> *mut u16 {
    Box::into_raw(vec![0_u16; length].into_boxed_slice()) as *mut u16
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_free(pointer: *mut u16, length: usize) {
    unsafe {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_result_ptr(buffer: *const Buffer) -> *const u8 {
    unsafe { (*buffer).0.as_ptr() }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_result_len(buffer: *const Buffer) -> usize {
    unsafe { (*buffer).0.len() }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_result_free(buffer: *mut Buffer) {
    unsafe {
        drop(Box::from_raw(buffer));
    }
}

#[unsafe(no_mangle)]
#[cfg(not(target_arch = "wasm32"))]
pub unsafe extern "C" fn mm_parse_json(
    pointer: *const u16,
    length: usize,
    flags: u32,
) -> *mut Buffer {
    let source = unsafe { std::slice::from_raw_parts(pointer, length) };
    Box::into_raw(Box::new(Buffer(json::encode(
        &core::parse_table(source, Options(flags)),
        source,
    ))))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_parse_compact(
    pointer: *const u16,
    length: usize,
    flags: u32,
) -> *mut Buffer {
    let source = unsafe { std::slice::from_raw_parts(pointer, length) };
    let mut output = Output::new();
    output.compact_table(&core::parse_table(source, Options(flags)));
    result(output)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_bounds(pointer: *const u16, length: usize) -> *mut Buffer {
    let source = unsafe { std::slice::from_raw_parts(pointer, length) };
    let bounds = core::cell_bounds(source);
    let mut out = Output::new();
    out.number(bounds.len());
    for bound in bounds {
        out.number(bound as usize);
    }
    result(out)
}
#[unsafe(no_mangle)]
pub extern "C" fn mm_scanner_new(flags: u32) -> *mut Scanner<'static> {
    Box::into_raw(Box::new(Scanner::new(Options(flags))))
}
/// 与 JS 扫描器的可变 options 保持一致，不改写已经接受的物理行。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_scanner_options(scanner: *mut Scanner<'static>, flags: u32) {
    unsafe {
        (*scanner).options = Options(flags);
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_scanner_free(scanner: *mut Scanner<'static>) {
    unsafe {
        drop(Box::from_raw(scanner));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_scanner_push(
    scanner: *mut Scanner<'static>,
    pointer: *const u16,
    length: usize,
    offset: usize,
) -> u32 {
    let scanner = unsafe { &mut *scanner };
    let accepted = scanner.push(
        unsafe { std::slice::from_raw_parts(pointer, length) },
        offset,
    );
    (scanner.flags() << 1) | u32::from(accepted)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_scanner_finish_compact(
    scanner: *const Scanner<'static>,
) -> *mut Buffer {
    let mut output = Output::new();
    output.compact_table(&unsafe { &*scanner }.finish());
    result(output)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mm_write(pointer: *const u16, length: usize) -> *mut Buffer {
    // Writer 请求是字节协议，length 仍按分配时的 UTF-16 单元数传入。
    let bytes = unsafe { std::slice::from_raw_parts(pointer as *const u8, length * 2) };
    text_result(writer::decode_and_write(bytes))
}
