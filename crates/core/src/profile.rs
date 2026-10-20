//! 分阶段诊断使用的借用句柄；不参与普通解析、扫描和写回调用。

use crate::core::{self, Options, Scanner};
use crate::wire::Output;
use crate::{Buffer, result, writer};

// 模型借用请求缓冲区；释放模型后才能释放或改写请求。
pub struct WriteModel(Result<writer::WriteTable<'static>, String>);

#[cfg_attr(feature = "c-abi", unsafe(no_mangle))]
pub unsafe extern "C" fn mm_profile_write_new(
    pointer: *const u16,
    length: usize,
) -> *mut WriteModel {
    let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length * 2) };
    Box::into_raw(Box::new(WriteModel(writer::decode(bytes))))
}

#[cfg_attr(feature = "c-abi", unsafe(no_mangle))]
pub unsafe extern "C" fn mm_profile_write_free(model: *mut WriteModel) {
    unsafe { drop(Box::from_raw(model)) };
}

#[cfg_attr(feature = "c-abi", unsafe(no_mangle))]
pub unsafe extern "C" fn mm_profile_write_core(model: *const WriteModel) -> usize {
    match &unsafe { &*model }.0 {
        Ok(table) => std::hint::black_box(writer::stringify(table)).map_or(0, |text| text.len()),
        Err(_) => 0,
    }
}

// 扫描器借用原始 UTF-16 缓冲区，调用方须保持它有效直到释放 scanner。
#[cfg_attr(feature = "c-abi", unsafe(no_mangle))]
pub unsafe extern "C" fn mm_profile_scan(
    pointer: *const u16,
    length: usize,
    flags: u32,
) -> *mut Scanner<'static> {
    let source = unsafe { std::slice::from_raw_parts(pointer, length) };
    Box::into_raw(Box::new(core::scan_table(source, Options(flags))))
}

#[cfg_attr(feature = "c-abi", unsafe(no_mangle))]
pub unsafe extern "C" fn mm_profile_finish(
    scanner: *const Scanner<'static>,
) -> *mut Option<core::Table> {
    Box::into_raw(Box::new(unsafe { &*scanner }.finish()))
}

#[cfg_attr(feature = "c-abi", unsafe(no_mangle))]
pub unsafe extern "C" fn mm_profile_model_free(table: *mut Option<core::Table>) {
    unsafe { drop(Box::from_raw(table)) };
}

#[cfg_attr(feature = "c-abi", unsafe(no_mangle))]
pub unsafe extern "C" fn mm_profile_encode(table: *const Option<core::Table>) -> *mut Buffer {
    let mut output = Output::new();
    output.compact_table(unsafe { &*table });
    result(output)
}
