mod model;
mod scanner;
mod text;
mod writer;

use multimd_table_core::core::{self, Options};
use pyo3::{
    exceptions::PyValueError,
    prelude::*,
    types::{PyDict, PyString},
};

fn flags(settings: [bool; 5]) -> Options {
    Options(
        settings
            .into_iter()
            .enumerate()
            .fold(0, |bits, (index, value)| bits | (u32::from(value) << index)),
    )
}

/// 只解析源文本开头的表格；未识别到表格返回 None。
#[pyfunction]
#[pyo3(signature = (source, *, multiline=false, rowspan=false, headerless=false, multibody=true, autolabel=true))]
fn parse_table(
    py: Python<'_>,
    source: &Bound<'_, PyString>,
    multiline: bool,
    rowspan: bool,
    headerless: bool,
    multibody: bool,
    autolabel: bool,
) -> PyResult<Py<PyAny>> {
    let source = text::from_python(source)?;
    let options = flags([multiline, rowspan, headerless, multibody, autolabel]);
    let table = py.detach(|| core::parse_table(&source, options));
    model::table(
        py,
        table.as_ref(),
        model::Source {
            units: &source,
            offsets: &[],
        },
    )
}

/// 返回未被转义或代码片段遮蔽的管道边界，坐标按 UTF-16 单元计数。
#[pyfunction]
fn cell_bounds(line: &Bound<'_, PyString>) -> PyResult<Vec<isize>> {
    Ok(core::cell_bounds(&text::from_python(line)?))
}

/// 写出无尾换行的规范表格；无法无损表示的内容抛出 ValueError。
#[pyfunction]
fn stringify_table(py: Python<'_>, table: &Bound<'_, PyDict>) -> PyResult<Py<PyAny>> {
    let table = writer::model(table)?;
    let written = py
        .detach(|| multimd_table_core::writer::stringify(&table))
        .map_err(PyValueError::new_err)?;
    Ok(text::to_python(py, &written)?.unbind())
}

#[pymodule]
fn _native(module: &Bound<'_, pyo3::types::PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(parse_table, module)?)?;
    module.add_function(wrap_pyfunction!(stringify_table, module)?)?;
    module.add_function(wrap_pyfunction!(cell_bounds, module)?)?;
    module.add_class::<scanner::TableScanner>()?;
    Ok(())
}
