use crate::core::*;
use std::io::Write;

/// 只序列化已验证的核心模型；孤立代理字符写成 JSON 转义，JS 原生解析器可无损还原。
struct Json(Vec<u8>);
impl Json {
    fn raw(&mut self, value: &str) {
        self.0.extend_from_slice(value.as_bytes());
    }
    fn number(&mut self, mut value: usize) {
        let mut digits = [0; 20];
        let mut start = digits.len();
        loop {
            start -= 1;
            digits[start] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 {
                break;
            }
        }
        self.0.extend_from_slice(&digits[start..]);
    }
    fn boolean(&mut self, value: bool) {
        self.raw(if value { "true" } else { "false" });
    }
    fn string(&mut self, value: &[u16]) {
        self.string_units(value.iter().copied());
    }
    fn string_units(&mut self, units: impl Iterator<Item = u16>) {
        self.0.push(b'"');
        for c in char::decode_utf16(units) {
            match c {
                Err(error) => {
                    write!(self.0, "\\u{:04x}", error.unpaired_surrogate()).unwrap();
                }
                Ok('"') => self.raw("\\\""),
                Ok('\\') => self.raw("\\\\"),
                Ok(c) if c < ' ' => {
                    write!(self.0, "\\u{:04x}", c as u16).unwrap();
                }
                Ok(c) => {
                    let mut bytes = [0; 4];
                    self.raw(c.encode_utf8(&mut bytes));
                }
            }
        }
        self.0.push(b'"');
    }
    fn range(&mut self, range: Range) {
        self.raw("{\"start\":");
        self.number(range.start);
        self.raw(",\"end\":");
        self.number(range.end);
        self.raw("}");
    }
    fn align(&mut self, value: u32) {
        self.raw(match value {
            1 => "\"left\"",
            2 => "\"center\"",
            3 => "\"right\"",
            _ => "null",
        });
    }
    fn table(&mut self, table: &Table, source: &[u16]) {
        self.raw("{\"type\":\"multimdTable\",\"columns\":[");
        for (i, column) in table.columns.iter().enumerate() {
            if i > 0 {
                self.raw(",");
            }
            self.raw("{\"align\":");
            self.align(column.align);
            self.raw(",\"wrap\":");
            self.boolean(column.wrap);
            self.raw("}");
        }
        self.raw("],\"caption\":");
        if let Some(c) = &table.caption {
            self.raw("{\"value\":");
            self.string(&c.value);
            self.raw(",\"id\":");
            if let Some(id) = &c.id {
                self.string(id);
            } else {
                self.raw("null");
            }
            self.raw(",\"side\":");
            self.raw(if c.bottom { "\"bottom\"" } else { "\"top\"" });
            self.raw(",\"range\":");
            self.range(c.range);
            self.raw(",\"contentRange\":");
            self.range(c.content_range);
            self.raw("}");
        } else {
            self.raw("null");
        }
        self.raw(",\"sections\":[");
        for (i, section) in table.sections.iter().enumerate() {
            if i > 0 {
                self.raw(",");
            }
            self.raw("{\"kind\":");
            self.raw(if section.head { "\"head\"" } else { "\"body\"" });
            self.raw(",\"range\":");
            self.range(section.range);
            self.raw(",\"rows\":[");
            for (i, row) in section.rows.iter().enumerate() {
                if i > 0 {
                    self.raw(",");
                }
                self.raw("{\"range\":");
                self.range(row.range);
                self.raw(",\"cells\":[");
                for (i, cell) in table.cells[row.cells.clone()].iter().enumerate() {
                    if i > 0 {
                        self.raw(",");
                    }
                    self.raw("{\"column\":");
                    self.number(cell.column);
                    self.raw(",\"colspan\":");
                    self.number(cell.colspan);
                    self.raw(",\"rowspan\":");
                    self.number(cell.rowspan);
                    self.raw(",\"align\":");
                    self.align(cell.align);
                    self.raw(",\"wrap\":");
                    self.boolean(cell.wrap);
                    self.raw(",\"block\":");
                    self.boolean(cell.block);
                    self.raw(",\"value\":");
                    self.string_units(cell.segments.iter().enumerate().flat_map(|(i, range)| {
                        (i > 0)
                            .then_some(10)
                            .into_iter()
                            .chain(source[range.start..range.end].iter().copied())
                    }));
                    self.raw(",\"range\":");
                    self.range(cell.range);
                    self.raw(",\"segments\":[");
                    for (i, &range) in cell.segments.iter().enumerate() {
                        if i > 0 {
                            self.raw(",");
                        }
                        self.range(range);
                    }
                    self.raw("]}");
                }
                self.raw("]}");
            }
            self.raw("]}");
        }
        self.raw("],\"range\":");
        self.range(table.range);
        self.raw("}");
    }
}
pub fn encode(table: &Option<Table>, source: &[u16]) -> Vec<u8> {
    let mut output = Json(Vec::new());
    if let Some(table) = table {
        output.table(table, source);
    } else {
        output.raw("null");
    }
    output.0
}
