use crate::core::*;
use std::borrow::Cow;

const TABLE_FORMAT: usize = 1;

/// 验证版协议：小端整数和带长度的 UTF-16 文本，所有边界在解码时检查。
pub struct Output(pub Vec<u8>);
impl Output {
    pub fn new() -> Self {
        Self(Vec::new())
    }
    pub fn number(&mut self, n: usize) {
        self.0.extend_from_slice(&(n as u32).to_le_bytes());
    }
    /// 固定记录一次扩容检查；u32 数组无填充，转成小端后可按连续字节复制。
    #[inline]
    fn record<const N: usize>(&mut self, values: [u32; N]) {
        let values = values.map(u32::to_le);
        let bytes = unsafe {
            std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(&values))
        };
        self.0.extend_from_slice(bytes);
    }
    pub fn text(&mut self, s: &[u16]) {
        self.number(s.len());
        #[cfg(target_endian = "little")]
        {
            // u16 切片已初始化；小端内存布局与协议一致，可整段复制而不逐单元扩容。
            let bytes = unsafe {
                std::slice::from_raw_parts(s.as_ptr().cast::<u8>(), std::mem::size_of_val(s))
            };
            self.0.extend_from_slice(bytes);
        }
        #[cfg(not(target_endian = "little"))]
        for c in s {
            self.0.extend_from_slice(&c.to_le_bytes());
        }
    }
    fn range(&mut self, range: Range) {
        self.record([range.start as u32, range.end as u32]);
    }
    /// JS 已持有源文：只传结构与片段坐标，避免重复搬运同一份单元格文本。
    pub fn compact_table(&mut self, table: &Option<Table>) {
        self.number(if table.is_some() { TABLE_FORMAT } else { 0 });
        let Some(table) = table else {
            return;
        };
        let rows: usize = table.sections.iter().map(|s| s.rows.len()).sum();
        let caption_bytes = table
            .caption
            .as_ref()
            .and_then(|c| c.id.as_ref())
            .map_or(0, |s| s.len() * 2);
        self.0.reserve(
            table.cells.len() * 36
                + rows * 12
                + table.columns.len() * 8
                + table.sections.len() * 16
                + caption_bytes
                + 64,
        );
        self.number(table.columns.len());
        for c in &table.columns {
            self.record([c.align, c.wrap as u32]);
        }
        self.number(usize::from(table.caption.is_some()));
        if let Some(caption) = &table.caption {
            self.number(usize::from(caption.id.is_some()));
            if let Some(id) = &caption.id {
                self.text(id);
            }
            self.number(caption.bottom as usize);
            self.range(caption.range);
            self.range(caption.content_range);
        }
        self.number(table.sections.len());
        for section in &table.sections {
            self.record([
                u32::from(!section.head),
                section.range.start as u32,
                section.range.end as u32,
                section.rows.len() as u32,
            ]);
            for row in &section.rows {
                self.record([
                    row.range.start as u32,
                    row.range.end as u32,
                    row.cells.len() as u32,
                ]);
                for cell in &table.cells[row.cells.clone()] {
                    // Segments 类型保证至少有首片段；所有单元格共用同一条记录路径。
                    let mut segments = cell.segments.iter();
                    let first = segments.next().unwrap();
                    self.record([
                        cell.column as u32,
                        cell.colspan as u32,
                        cell.rowspan as u32,
                        cell.block as u32,
                        cell.range.start as u32,
                        cell.range.end as u32,
                        cell.segments.len() as u32,
                        first.start as u32,
                        first.end as u32,
                    ]);
                    for &segment in segments {
                        self.range(segment);
                    }
                }
            }
        }
        self.range(table.range);
    }
}

pub struct Input<'a> {
    pub bytes: &'a [u8],
    offset: usize,
}
impl<'a> Input<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    pub fn number(&mut self) -> Result<usize, String> {
        let end = self.offset.checked_add(4).ok_or("invalid request length")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("truncated request")?;
        self.offset = end;
        Ok(u32::from_le_bytes(value.try_into().unwrap()) as usize)
    }
    pub fn count(&mut self) -> Result<usize, String> {
        let n = self.number()?;
        if n > self.bytes.len() {
            return Err("request count exceeds buffer".into());
        }
        Ok(n)
    }
    pub fn text(&mut self) -> Result<Text, String> {
        Ok(self.borrowed_text()?.into_owned())
    }
    /// 输入有效期内可借用对齐的小端 UTF-16；未对齐或大端环境仍逐单元复制。
    pub fn borrowed_text(&mut self) -> Result<Cow<'a, [u16]>, String> {
        let length = self.count()?;
        let end = self
            .offset
            .checked_add(length.checked_mul(2).ok_or("invalid text length")?)
            .ok_or("invalid text length")?;
        let bytes = self.bytes.get(self.offset..end).ok_or("truncated text")?;
        self.offset = end;
        #[cfg(target_endian = "little")]
        {
            // 字节已初始化且长度已检查；u16 所有位模式有效，align_to 验证对齐。
            let (prefix, units, suffix) = unsafe { bytes.align_to::<u16>() };
            if prefix.is_empty() && suffix.is_empty() {
                return Ok(Cow::Borrowed(units));
            }
        }
        Ok(Cow::Owned(
            bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect(),
        ))
    }
    pub fn finish(&self) -> Result<(), String> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err("trailing request bytes".into())
        }
    }
}
