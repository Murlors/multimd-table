use crate::text;
use multimd_table_core::core::{self, Range};
use pyo3::{
    exceptions::PyRuntimeError,
    intern,
    prelude::*,
    types::{PyDict, PyList},
};

// 对象字段在一个位置直写；固定键由 PyO3 缓存，避免每个单元格重复分配。
macro_rules! object {
    ($py:expr, {$($key:literal: $value:expr),* $(,)?}) => {{
        let dict = PyDict::new($py);
        $(dict.set_item(intern!($py, $key), $value)?;)*
        dict
    }};
}

/// Scanner 使用连续局部位置解析，独立映射宿主的重复、乱序和大偏移。
pub struct Source<'a> {
    pub units: &'a [u16],
    pub offsets: &'a [(usize, usize)],
}
impl Source<'_> {
    fn translate(&self, position: usize) -> PyResult<usize> {
        if self.offsets.is_empty() {
            return Ok(position);
        }
        let index = self
            .offsets
            .partition_point(|&(local, _)| local <= position)
            .saturating_sub(1);
        let (local, external) = self.offsets[index];
        let end = self
            .offsets
            .get(index + 1)
            .map_or(self.units.len() - 1, |&(next, _)| next - 1);
        if position < local || position > end {
            return Err(PyRuntimeError::new_err("Invalid core source position"));
        }
        Ok(external + position - local)
    }
    fn range<'py>(&self, py: Python<'py>, range: Range) -> PyResult<Bound<'py, PyDict>> {
        Ok(object!(py, {"start": self.translate(range.start)?, "end": self.translate(range.end)?}))
    }
}
fn align(value: u32) -> Option<&'static str> {
    match value {
        1 => Some("left"),
        2 => Some("center"),
        3 => Some("right"),
        _ => None,
    }
}

pub fn table(
    py: Python<'_>,
    table: Option<&core::Table>,
    source: Source<'_>,
) -> PyResult<Py<PyAny>> {
    let Some(table) = table else {
        return Ok(py.None());
    };
    let columns = PyList::empty(py);
    for column in &table.columns {
        columns.append(object!(py, {"align": align(column.align), "wrap": column.wrap}))?;
    }
    let caption = if let Some(caption) = &table.caption {
        object!(py, {
            "value": text::to_python(py, &caption.value)?,
            "id": match &caption.id { Some(id) => text::to_python(py, id)?.unbind(), None => py.None() },
            "side": if caption.bottom { "bottom" } else { "top" },
            "range": source.range(py, caption.range)?,
            "contentRange": source.range(py, caption.content_range)?,
        }).into_any().unbind()
    } else {
        py.None()
    };
    let sections = PyList::empty(py);
    for section in &table.sections {
        let rows = PyList::empty(py);
        for row in &section.rows {
            let cells = PyList::empty(py);
            for cell in &table.cells[row.cells.clone()] {
                let segments = PyList::empty(py);
                for segment in cell.segments.iter() {
                    segments.append(source.range(py, *segment)?)?;
                }
                let value = if cell.segments.len() == 1 {
                    let range = cell.segments.iter().next().unwrap();
                    text::to_python(py, &source.units[range.start..range.end])?
                } else {
                    let mut value = Vec::new();
                    for (index, range) in cell.segments.iter().enumerate() {
                        if index > 0 {
                            value.push(10);
                        }
                        value.extend_from_slice(&source.units[range.start..range.end]);
                    }
                    text::to_python(py, &value)?
                };
                cells.append(object!(py, {
                    "column": cell.column, "colspan": cell.colspan, "rowspan": cell.rowspan,
                    "align": align(cell.align), "wrap": cell.wrap, "block": cell.block,
                    "value": value, "range": source.range(py, cell.range)?, "segments": segments,
                }))?;
            }
            rows.append(object!(py, {"cells": cells, "range": source.range(py, row.range)?}))?;
        }
        sections.append(object!(py, {
            "kind": if section.head { "head" } else { "body" },
            "range": source.range(py, section.range)?, "rows": rows,
        }))?;
    }
    Ok(object!(py, {
        "type": "multimdTable", "columns": columns, "caption": caption,
        "sections": sections, "range": source.range(py, table.range)?,
    })
    .into_any()
    .unbind())
}
