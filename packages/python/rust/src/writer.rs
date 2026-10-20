use crate::text;
use multimd_table_core::{
    core::Column,
    writer::{WriteCaption, WriteCell, WriteSection, WriteTable},
};
use pyo3::{
    exceptions::{PyTypeError, PyValueError},
    prelude::*,
    types::{PyBool, PyDict, PyInt, PyList, PyString},
};
use std::borrow::Cow;

fn required<'py>(dict: &Bound<'py, PyDict>, name: &str) -> PyResult<Bound<'py, PyAny>> {
    dict.get_item(name)?
        .ok_or_else(|| PyValueError::new_err(format!("Missing field '{name}'")))
}
fn number(value: &Bound<'_, PyAny>) -> PyResult<usize> {
    if value.is_instance_of::<PyBool>() || !value.is_instance_of::<PyInt>() {
        return Err(PyTypeError::new_err(
            "Writer indices and spans must be integers",
        ));
    }
    value.extract::<u32>().map(|n| n as usize).map_err(|_| {
        PyValueError::new_err("Writer indices and spans must be between 0 and 2**32 - 1")
    })
}
fn optional_number(dict: &Bound<'_, PyDict>, key: &str, default: usize) -> PyResult<usize> {
    dict.get_item(key)?
        .map_or(Ok(default), |value| number(&value))
}
fn boolean(dict: &Bound<'_, PyDict>, key: &str) -> PyResult<bool> {
    dict.get_item(key)?
        .map_or(Ok(false), |value| value.extract())
}
fn string(value: &Bound<'_, PyAny>) -> PyResult<Cow<'static, [u16]>> {
    Ok(Cow::Owned(text::from_python(value.cast::<PyString>()?)?))
}

/// 仅转换宿主模型；网格覆盖、合并边界和内容可表示性仍由核心校验。
pub fn model(table: &Bound<'_, PyDict>) -> PyResult<WriteTable<'static>> {
    let mut columns = Vec::new();
    for column in required(table, "columns")?.cast::<PyList>()? {
        let column = column.cast::<PyDict>()?;
        let value = required(column, "align")?;
        let align = if value.is_none() {
            0
        } else {
            match value.extract::<String>()?.as_str() {
                "left" => 1,
                "center" => 2,
                "right" => 3,
                _ => return Err(PyValueError::new_err("Invalid column alignment")),
            }
        };
        columns.push(Column {
            align,
            wrap: boolean(column, "wrap")?,
        });
    }
    let mut sections = Vec::new();
    for section in required(table, "sections")?.cast::<PyList>()? {
        let section = section.cast::<PyDict>()?;
        let head = match required(section, "kind")?.extract::<String>()?.as_str() {
            "head" => true,
            "body" => false,
            _ => {
                return Err(PyValueError::new_err(
                    "Section kind must be 'head' or 'body'",
                ));
            }
        };
        let mut rows = Vec::new();
        for row in required(section, "rows")?.cast::<PyList>()? {
            let row = row.cast::<PyDict>()?;
            let mut cells = Vec::new();
            for cell in required(row, "cells")?.cast::<PyList>()? {
                let cell = cell.cast::<PyDict>()?;
                cells.push(WriteCell {
                    column: number(&required(cell, "column")?)?,
                    colspan: optional_number(cell, "colspan", 1)?,
                    rowspan: optional_number(cell, "rowspan", 1)?,
                    block: boolean(cell, "block")?,
                    value: string(&required(cell, "value")?)?,
                });
            }
            rows.push(cells);
        }
        sections.push(WriteSection { head, rows });
    }
    let caption = match table.get_item("caption")? {
        Some(value) if !value.is_none() => {
            let caption = value.cast::<PyDict>()?;
            let id = caption
                .get_item("id")?
                .map(|value| {
                    if value.is_none() {
                        Ok(None)
                    } else {
                        string(&value).map(Some)
                    }
                })
                .transpose()?;
            let bottom = match required(caption, "side")?.extract::<String>()?.as_str() {
                "top" => false,
                "bottom" => true,
                _ => {
                    return Err(PyValueError::new_err(
                        "Caption side must be 'top' or 'bottom'",
                    ));
                }
            };
            Some(WriteCaption {
                value: string(&required(caption, "value")?)?,
                id,
                bottom,
            })
        }
        _ => None,
    };
    Ok(WriteTable {
        columns,
        sections,
        caption,
    })
}
