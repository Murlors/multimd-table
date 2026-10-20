use crate::{
    flags,
    model::{self, Source},
    text,
};
use multimd_table_core::core::{Options, Scanner};
use pyo3::{
    class::gc::{PyTraverseError, PyVisit},
    exceptions::{PyRuntimeError, PyValueError},
    prelude::*,
    types::{PyAny, PyBool, PyDict, PyInt, PyString},
};

const NAMES: [&str; 5] = [
    "multiline",
    "rowspan",
    "headerless",
    "multibody",
    "autolabel",
];

#[pyclass(module = "multimd_table", name = "TableScanner")]
pub struct TableScanner {
    inner: Option<Scanner<'static>>,
    options: Option<Py<PyDict>>,
    source: Vec<u16>,
    offsets: Vec<(usize, usize)>,
    bits: u32,
}
impl TableScanner {
    fn configure(&mut self, py: Python<'_>) -> PyResult<()> {
        let options = self
            .options
            .as_ref()
            .ok_or_else(|| PyRuntimeError::new_err("Scanner is disposed"))?
            .bind(py);
        let mut bits = 0;
        for (index, name) in NAMES.iter().enumerate() {
            let value = options
                .get_item(name)?
                .ok_or_else(|| PyValueError::new_err(format!("Missing option '{name}'")))?;
            bits |= u32::from(value.extract::<bool>()?) << index;
        }
        self.inner
            .as_mut()
            .ok_or_else(|| PyRuntimeError::new_err("Scanner is disposed"))?
            .options = Options(bits);
        Ok(())
    }
}

#[pymethods]
impl TableScanner {
    #[new]
    #[pyo3(signature = (*, multiline=false, rowspan=false, headerless=false, multibody=true, autolabel=true))]
    fn new(
        py: Python<'_>,
        multiline: bool,
        rowspan: bool,
        headerless: bool,
        multibody: bool,
        autolabel: bool,
    ) -> PyResult<Self> {
        let settings = [multiline, rowspan, headerless, multibody, autolabel];
        let options = PyDict::new(py);
        for (name, value) in NAMES.iter().zip(settings) {
            options.set_item(name, value)?;
        }
        Ok(Self {
            inner: Some(Scanner::new(flags(settings))),
            options: Some(options.unbind()),
            source: Vec::new(),
            offsets: Vec::new(),
            bits: 0,
        })
    }
    #[getter]
    fn options(&self, py: Python<'_>) -> PyResult<Py<PyDict>> {
        self.options
            .as_ref()
            .map(|options| options.clone_ref(py))
            .ok_or_else(|| PyRuntimeError::new_err("Scanner is disposed"))
    }
    #[getter]
    fn accepted(&self) -> bool {
        self.bits & 1 != 0
    }
    #[getter]
    fn committed(&self) -> bool {
        self.bits & 2 != 0
    }
    #[getter]
    fn finished(&self) -> bool {
        self.bits & 4 != 0
    }
    #[getter]
    fn disposed(&self) -> bool {
        self.inner.is_none()
    }

    /// 行输入不含换行符；offset 与所有公开范围均按 UTF-16 单元计数。
    fn push(
        &mut self,
        py: Python<'_>,
        line: &Bound<'_, PyAny>,
        offset: &Bound<'_, PyAny>,
    ) -> PyResult<bool> {
        if self.inner.is_none() {
            return Err(PyRuntimeError::new_err("Scanner is disposed"));
        }
        if self.finished() {
            return Ok(false);
        }
        let line = text::from_python(line.cast::<PyString>()?)?;
        let invalid = || PyValueError::new_err("Expected a nonnegative safe UTF-16 offset");
        if offset.is_instance_of::<PyBool>() || !offset.is_instance_of::<PyInt>() {
            return Err(invalid());
        }
        let offset = offset.extract::<usize>().map_err(|_| invalid())?;
        if offset
            .checked_add(line.len())
            .is_none_or(|end| end > 9_007_199_254_740_991)
        {
            return Err(invalid());
        }
        let local = self.source.len();
        if local
            .checked_add(line.len())
            .is_none_or(|end| end > u32::MAX as usize)
        {
            return Err(PyValueError::new_err(
                "Table input exceeds the shared 32-bit local coordinate space",
            ));
        }
        self.configure(py)?;
        let inner = self.inner.as_mut().unwrap();
        let accepted = inner.push(&line, local);
        self.bits = inner.flags();
        if accepted {
            self.offsets.push((local, offset));
            self.source.extend_from_slice(&line);
            self.source.push(10);
        }
        Ok(accepted)
    }
    /// 返回独立快照，不结束扫描；后续 push 不修改已经返回的模型。
    fn finish(&mut self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        self.configure(py)?;
        let table = self.inner.as_ref().unwrap().finish();
        model::table(
            py,
            table.as_ref(),
            Source {
                units: &self.source,
                offsets: &self.offsets,
            },
        )
    }
    /// 显式、幂等释放原生状态和源文本；已有快照继续有效。
    fn dispose(&mut self) {
        self.inner = None;
        self.source = Vec::new();
        self.offsets = Vec::new();
    }
    fn __enter__(slf: PyRef<'_, Self>) -> PyResult<PyRef<'_, Self>> {
        if slf.disposed() {
            return Err(PyRuntimeError::new_err("Scanner is disposed"));
        }
        Ok(slf)
    }
    fn __exit__(
        &mut self,
        _kind: &Bound<'_, PyAny>,
        _value: &Bound<'_, PyAny>,
        _traceback: &Bound<'_, PyAny>,
    ) -> bool {
        self.dispose();
        false
    }
    fn __traverse__(&self, visit: PyVisit<'_>) -> Result<(), PyTraverseError> {
        if let Some(options) = &self.options {
            visit.call(options)?;
        }
        Ok(())
    }
    fn __clear__(&mut self) {
        self.dispose();
        self.options = None;
    }
}
