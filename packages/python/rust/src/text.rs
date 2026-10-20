use pyo3::{exceptions::PyOverflowError, ffi, prelude::*, types::PyBytes};

/// 保留孤立代理项；不经过只能表示 Unicode 标量值的 Rust String。
pub fn from_python(value: &Bound<'_, pyo3::types::PyString>) -> PyResult<Vec<u16>> {
    // CPython 返回新的 bytes 引用；Bound 负责在复制结束后释放。
    let encoded = unsafe {
        Bound::from_owned_ptr_or_err(
            value.py(),
            ffi::PyUnicode_AsEncodedString(
                value.as_ptr(),
                c"utf-16-le".as_ptr(),
                c"surrogatepass".as_ptr(),
            ),
        )?
    };
    let bytes = encoded.cast::<PyBytes>()?.as_bytes();
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

/// CPython 直接从 UTF-16 构建 str，避免逐单元格产生 UTF-8 中间字符串。
pub fn to_python<'py>(py: Python<'py>, units: &[u16]) -> PyResult<Bound<'py, PyAny>> {
    let length = units
        .len()
        .checked_mul(2)
        .and_then(|n| isize::try_from(n).ok())
        .ok_or_else(|| PyOverflowError::new_err("Text exceeds the Python string size limit"))?;
    let mut order = if cfg!(target_endian = "little") {
        -1
    } else {
        1
    };
    // units 在解码期间有效；CPython 复制结果，返回对象不借用 Rust 内存。
    unsafe {
        Bound::from_owned_ptr_or_err(
            py,
            ffi::PyUnicode_DecodeUTF16(
                units.as_ptr().cast(),
                length,
                c"surrogatepass".as_ptr(),
                &mut order,
            ),
        )
    }
}
