use crate::core::*;
use crate::wire::Input;
use regex::bytes::Regex;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::OnceLock;

macro_rules! re {
    ($pattern:literal) => {{
        static RE: OnceLock<Regex> = OnceLock::new();
        RE.get_or_init(|| {
            let pattern = concat!("(?-u)", $pattern).replace(r"\s", r"[\t\n\x0b\x0c\r \x81\x82]");
            Regex::new(&pattern).unwrap()
        })
    }};
}
fn invalid(message: &str) -> String {
    format!("Cannot stringify MultiMarkdown table: {message}")
}
/// ASCII 语法正则使用等长影子字节，捕获坐标仍对应原始 UTF-16，替换只操作原文。
fn shadow(s: &[u16]) -> Vec<u8> {
    s.iter()
        .map(|&c| {
            if c < 128 {
                c as u8
            } else if matches!(c, 0x2028 | 0x2029) {
                130
            } else if whitespace(c) {
                129
            } else {
                128
            }
        })
        .collect()
}
fn append(out: &mut Text, s: &str) {
    out.extend(s.encode_utf16());
}

fn inline(value: &[u16]) -> Result<Cow<'_, [u16]>, String> {
    // 这些字符之外没有 inline 重写或拒绝规则，普通文本可直接借用。
    if !value.iter().any(|c| matches!(c, 10 | 60 | 92 | 96 | 124)) {
        return Ok(Cow::Borrowed(value));
    }
    let mut mask = None;
    let mut runs = Vec::new();
    let mut cursor = 0;
    while cursor < value.len() {
        if value[cursor] != 96 {
            cursor += 1;
            continue;
        }
        let start = cursor;
        while value.get(cursor) == Some(&96) {
            cursor += 1;
        }
        runs.push((start, cursor - start));
    }
    let mut next = vec![None; runs.len()];
    if runs.len() == 2 {
        if runs[0].1 == runs[1].1 {
            next[0] = Some(runs[1].0);
        }
    } else if runs.len() > 2 {
        let mut last = HashMap::new();
        for (index, &(start, length)) in runs.iter().enumerate().rev() {
            next[index] = last.insert(length, start);
        }
    }
    let mut run_index = 0;
    let mut out = Vec::new();
    let mut i = 0;
    while i < value.len() {
        if value[i] == 60 {
            let mask = mask.get_or_insert_with(|| shadow(value));
            let tag = re!(r#"^</?([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*/?>"#).captures(&mask[i..]);
            if let Some(tag) = tag {
                let length = tag[0].len();
                let name = tag.get(1).unwrap().as_bytes().to_ascii_lowercase();
                for &c in &value[i..i + length] {
                    if c == 124 {
                        append(&mut out, "&#124;");
                    } else {
                        out.push(c);
                    }
                }
                let raw = [b"code".as_slice(), b"pre", b"script", b"style", b"textarea"]
                    .contains(&name.as_slice());
                let opening =
                    value.get(i + 1) != Some(&47) && !mask[i..i + length].ends_with(b"/>");
                i += length;
                if raw && opening {
                    let end = re!(r"(?i)</(code|pre|script|style|textarea)\s*>")
                        .captures_iter(&mask[i..])
                        .find(|c| c.get(1).unwrap().as_bytes().eq_ignore_ascii_case(&name))
                        .map_or(value.len(), |c| i + c.get(0).unwrap().end());
                    if re!(r"[ \t]+\n").is_match(&mask[i..end]) {
                        return Err(invalid(
                            "trailing whitespace in raw HTML content is not preserved by MultiMarkdown tables",
                        ));
                    }
                    for &c in &value[i..end] {
                        if matches!(name.as_slice(), b"code" | b"pre" | b"textarea")
                            && matches!(c, 124 | 96)
                        {
                            append(&mut out, if c == 124 { "&#124;" } else { "&#96;" });
                        } else {
                            out.push(c);
                        }
                    }
                    i = end;
                }
                continue;
            }
            if let Some(link) =
                re!(r"^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20<>]*|[^<>\s]*@[^<>\s]+)>")
                    .find(&mask[i..])
            {
                let end = i + link.end();
                if value[i..end].contains(&124) {
                    return Err(invalid(
                        "autolink containing pipes must be serialized as an explicit Markdown link by the host",
                    ));
                }
                out.extend_from_slice(&value[i..end]);
                i = end;
                continue;
            }
        }
        if value[i] == 32 {
            let mut end = i + 1;
            while value.get(end) == Some(&32) {
                end += 1;
            }
            if end - i >= 2 && value.get(end) == Some(&10) {
                out.push(92);
            } else {
                out.extend_from_slice(&value[i..end]);
            }
            i = end;
            continue;
        }
        if value[i] == 92 {
            let mut end = i + 1;
            while value.get(end) == Some(&92) {
                end += 1;
            }
            let count = end - i;
            if matches!(value.get(end), Some(124 | 96)) {
                for _ in 0..count / 2 {
                    append(&mut out, "&#92;");
                }
                if count % 2 != 0 {
                    out.extend_from_slice(&[92, value[end]]);
                    i = end + 1;
                    continue;
                }
            } else {
                out.extend_from_slice(&value[i..end]);
            }
            i = end;
            continue;
        }
        if value[i] == 96 {
            let mut end = i + 1;
            while value.get(end) == Some(&96) {
                end += 1;
            }
            while runs.get(run_index).is_some_and(|&(start, _)| start < i) {
                run_index += 1;
            }
            let closing = runs
                .get(run_index)
                .filter(|&&(start, _)| start == i)
                .and_then(|_| next[run_index]);
            let Some(closing) = closing else {
                for _ in i..end {
                    out.extend_from_slice(&[92, 96]);
                }
                i = end;
                continue;
            };
            let content: Text = value[end..closing]
                .iter()
                .map(|&c| if c == 10 { 32 } else { c })
                .collect();
            let mut size = end - i;
            if content.contains(&124) && size > 1 {
                if content.contains(&96) {
                    return Err(invalid(
                        "code span containing pipes and backticks cannot be represented by the table delimiter syntax",
                    ));
                }
                size = 1;
            }
            out.extend(std::iter::repeat_n(96, size));
            out.extend(content);
            out.extend(std::iter::repeat_n(96, size));
            i = closing + end - i;
            continue;
        }
        if value[i] == 124 {
            out.push(92);
        }
        out.push(value[i]);
        i += 1;
    }
    Ok(Cow::Owned(out))
}

pub struct WriteCell<'a> {
    pub column: usize,
    pub colspan: usize,
    pub rowspan: usize,
    pub block: bool,
    pub value: Cow<'a, [u16]>,
}
pub struct WriteSection<'a> {
    pub head: bool,
    pub rows: Vec<Vec<WriteCell<'a>>>,
}
pub struct WriteCaption<'a> {
    pub value: Cow<'a, [u16]>,
    pub id: Option<Option<Cow<'a, [u16]>>>,
    pub bottom: bool,
}
pub struct WriteTable<'a> {
    pub columns: Vec<Column>,
    pub sections: Vec<WriteSection<'a>>,
    pub caption: Option<WriteCaption<'a>>,
}

struct Content<'a> {
    first: Cow<'a, [u16]>,
    following: Vec<Text>,
}
impl Content<'_> {
    fn len(&self) -> usize {
        1 + self.following.len()
    }
    fn get(&self, index: usize) -> Option<&[u16]> {
        if index == 0 {
            Some(&self.first)
        } else {
            self.following.get(index - 1).map(Vec::as_slice)
        }
    }
}
fn content<'a>(cell: &'a WriteCell<'_>) -> Result<Content<'a>, String> {
    if !cell.block && !cell.value.iter().any(|c| matches!(c, 10 | 13)) {
        return Ok(Content {
            first: inline(&cell.value)?,
            following: Vec::new(),
        });
    }
    let mut lines = content_lines(cell)?.into_iter();
    Ok(Content {
        first: Cow::Owned(lines.next().unwrap_or_default()),
        following: lines.collect(),
    })
}

fn content_lines(cell: &WriteCell<'_>) -> Result<Vec<Text>, String> {
    let mut value = Vec::with_capacity(cell.value.len());
    let mut i = 0;
    while i < cell.value.len() {
        if cell.value[i] == 13 {
            value.push(10);
            if cell.value.get(i + 1) == Some(&10) {
                i += 1;
            }
        } else {
            value.push(cell.value[i]);
        }
        i += 1;
    }
    if !cell.block {
        return Ok(inline(&value)?
            .split(|&c| c == 10)
            .map(<[u16]>::to_vec)
            .collect());
    }
    let mut output = Vec::new();
    let mut prose = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    fn flush(prose: &mut Text, pending: &mut bool, output: &mut Vec<Text>) -> Result<(), String> {
        if *pending {
            output.extend(inline(prose)?.split(|&c| c == 10).map(<[u16]>::to_vec));
            prose.clear();
            *pending = false;
        }
        Ok(())
    }
    let mut pending = false;
    for line in value.split(|&c| c == 10) {
        let mask = shadow(line);
        let quote = re!(r"^\s*(?:>\s*)+").find(&mask).map_or(0, |m| m.end());
        let list = re!(r"^\s*(?:[-+*]|\d+[.)])\s+")
            .find(&mask[quote..])
            .map_or(0, |m| m.end());
        let candidate = &mask[quote + list..];
        let opening = re!(r"^\s*(`{3,}|~{3,})([^\r\n\x82]*)$").captures(candidate);
        let code = fence.is_some()
            || opening.is_some()
            || mask.starts_with(b"    ")
            || mask.starts_with(b"\t");
        if code {
            flush(&mut prose, &mut pending, &mut output)?;
            let mut wrapped = vec![124];
            wrapped.extend_from_slice(line);
            wrapped.extend_from_slice(&[32, 124]);
            if scan_bounds(&wrapped).len() != 2 {
                return Err(invalid(
                    "pipe or backtick in block code cannot be represented without changing its content",
                ));
            }
            if line.last().is_some_and(|&c| whitespace(c)) {
                return Err(invalid(
                    "trailing whitespace in block code is not preserved by MultiMarkdown tables",
                ));
            }
            output.push(line.to_vec());
            if let Some((marker, length)) = fence {
                if let Some(closing) = re!(r"^\s*(`+|~+)\s*$").captures(candidate) {
                    if closing[1][0] == marker && closing[1].len() >= length {
                        fence = None;
                    }
                }
            } else if let Some(opening) = opening {
                fence = Some((opening[1][0], opening[1].len()));
            }
        } else {
            if pending {
                prose.push(10);
            }
            prose.extend_from_slice(line);
            pending = true;
        }
    }
    flush(&mut prose, &mut pending, &mut output)?;
    Ok(output)
}

fn caption(c: &WriteCaption<'_>) -> Result<Text, String> {
    if trim(&c.value).is_empty()
        || c.value
            .iter()
            .any(|c| matches!(c, 10 | 13 | 0x2028 | 0x2029))
    {
        return Err(invalid(
            "caption must contain nonempty single-line Markdown",
        ));
    }
    let automatic = label(&c.value);
    let explicit =
        c.id.as_ref()
            .and_then(Option::as_ref)
            .filter(|id| id.as_ref() != automatic.as_slice());
    if explicit.is_some_and(|s| !s.iter().all(|&c| matches!(c, 97..=122 | 48..=57 | 95))) {
        return Err(invalid("caption ID must be normalized"));
    }
    let mut source = vec![91];
    source.extend_from_slice(&c.value);
    source.push(93);
    if let Some(id) = explicit {
        source.push(91);
        if id.is_empty() {
            source.push(33);
        } else {
            source.extend_from_slice(id);
        }
        source.push(93);
    }
    let mask = shadow(&source);
    let parsed = re!(r"^\s*\[([^\r\n\x82]+?)\](\[([^\[\]]+)\])?\s*$")
        .captures(&mask)
        .ok_or_else(|| invalid("caption Markdown is ambiguous with an explicit label"))?;
    let capture = parsed.get(1).unwrap();
    if &source[capture.start()..capture.end()] != c.value.as_ref() {
        return Err(invalid(
            "caption Markdown is ambiguous with an explicit label",
        ));
    }
    Ok(source)
}

pub fn stringify(table: &WriteTable<'_>) -> Result<Text, String> {
    let width = table.columns.len();
    if width == 0 || table.sections.is_empty() {
        return Err(invalid(
            "at least one column and nonempty section are required",
        ));
    }
    let mut delimiter = vec![124];
    for column in &table.columns {
        if column.align > 3 {
            return Err(invalid("invalid column alignment"));
        }
        if matches!(column.align, 1 | 2) {
            delimiter.push(58);
        }
        append(&mut delimiter, "---");
        if matches!(column.align, 2 | 3) {
            delimiter.push(58);
        }
        if column.wrap {
            delimiter.push(43);
        }
        delimiter.push(124);
    }
    let mut output: Vec<Text> = Vec::new();
    if let Some(c) = &table.caption {
        if !c.bottom {
            output.push(caption(c)?);
        }
    }
    let mut separated = false;
    for (section_index, section) in table.sections.iter().enumerate() {
        if section.head && section_index != 0 {
            return Err(invalid("a single head section must precede all bodies"));
        }
        if section.rows.is_empty() {
            return Err(invalid("section has no rows"));
        }
        if !section.head {
            if !separated {
                output.push(delimiter.clone());
                separated = true;
            } else {
                output.push(Vec::new());
            }
        }
        let mut slots = vec![vec![None; width]; section.rows.len()];
        for (r, row) in section.rows.iter().enumerate() {
            for (index, c) in row.iter().enumerate() {
                let end_c = c
                    .column
                    .checked_add(c.colspan)
                    .ok_or_else(|| invalid("span overflow"))?;
                let end_r = r
                    .checked_add(c.rowspan)
                    .ok_or_else(|| invalid("span overflow"))?;
                if c.colspan == 0 || c.rowspan == 0 || end_c > width || end_r > slots.len() {
                    return Err(invalid("span exceeds its section or columns"));
                }
                for line in &mut slots[r..end_r] {
                    for slot in &mut line[c.column..end_c] {
                        if slot.is_some() {
                            return Err(invalid("overlapping spans"));
                        }
                        *slot = Some((r, index));
                    }
                }
            }
        }
        if slots.iter().flatten().any(Option::is_none) {
            return Err(invalid("uncovered position; use an explicit empty cell"));
        }
        for (r, row) in section.rows.iter().enumerate() {
            let values = row.iter().map(content).collect::<Result<Vec<_>, _>>()?;
            let block = row
                .iter()
                .zip(&values)
                .any(|(c, lines)| c.block || lines.len() > 1);
            let count = values
                .iter()
                .map(Content::len)
                .max()
                .unwrap_or(1)
                .max(if block { 2 } else { 1 });
            let mut physical = Vec::new();
            for line in 0..count {
                let mut source = vec![124];
                for col in 0..width {
                    let (origin_row, index) = slots[r][col].unwrap();
                    let origin = &section.rows[origin_row][index];
                    if col != origin.column {
                        source.push(124);
                        continue;
                    }
                    if origin_row != r {
                        append(&mut source, if line == 0 { " ^^ |" } else { " |" });
                        continue;
                    }
                    let mut value = Cow::Borrowed(values[index].get(line).unwrap_or(&[]));
                    if line == 0 && ascii_eq(trim(&value), "^^") {
                        let pos = value.iter().position(|&c| c == 94).unwrap();
                        value.to_mut().insert(pos, 92);
                    }
                    if block && !origin.block && values[index].len() == 1 {
                        if matches!(value.first(), Some(32 | 9)) && !trim(&value).is_empty() {
                            let mut replacement =
                                text(if value[0] == 9 { "&#9;" } else { "&#32;" });
                            replacement.extend_from_slice(&value[1..]);
                            value = Cow::Owned(replacement);
                        }
                        let mask = shadow(&value);
                        if re!(r"^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d{1,9}[.)]\s)").is_match(&mask)
                            || re!(r"^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$")
                                .is_match(&mask)
                        {
                            if let Some(m) = re!(r"^([ ]{0,3})([#>+*_-]|\d+[.)])").captures(&mask) {
                                value.to_mut().insert(m.get(2).unwrap().end() - 1, 92);
                            }
                        }
                        if re!(r"(?i)^ {0,3}(?:<(?:!--|!|\?|/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)\b)|\[[^\]]+\]:)").is_match(&shadow(&value)) {
                            return Err(invalid("inline HTML block or reference definition cannot be promoted to a multiline block row without changing semantics"));
                        }
                    }
                    if !block && delimiter_value(trim(&value)) {
                        if let Some(pos) = value.iter().position(|c| matches!(c, 45 | 61 | 58)) {
                            value.to_mut().insert(pos, 92);
                        }
                    }
                    if !block {
                        source.push(32);
                    }
                    source.extend_from_slice(&value);
                    source.extend_from_slice(&[32, 124]);
                }
                if scan_bounds(&source).len() != width + 1 {
                    return Err(invalid("cell Markdown hides a table delimiter"));
                }
                physical.push(source);
            }
            let parts: Vec<_> = physical[0].split(|&c| c == 124).collect();
            if block
                && parts[1..parts.len() - 1]
                    .iter()
                    .all(|s| delimiter_value(trim(s)))
            {
                let mut blank = vec![124];
                for col in 0..width {
                    let (origin_row, index) = slots[r][col].unwrap();
                    if col == section.rows[origin_row][index].column {
                        blank.push(32);
                    }
                    blank.push(124);
                }
                physical.insert(0, blank);
            }
            let last = physical.len() - 1;
            for (index, mut line) in physical.into_iter().enumerate() {
                if index != last {
                    line.push(92);
                }
                output.push(line);
            }
        }
    }
    if !separated {
        output.push(delimiter);
    }
    if let Some(c) = &table.caption {
        if c.bottom {
            output.push(caption(c)?);
        }
    }
    let mut result = Vec::new();
    for (index, line) in output.iter().enumerate() {
        if index > 0 {
            result.push(10);
        }
        result.extend(line);
    }
    Ok(result)
}

pub fn decode(bytes: &[u8]) -> Result<WriteTable<'_>, String> {
    let mut input = Input::new(bytes);
    let mut columns = Vec::new();
    for _ in 0..input.count()? {
        columns.push(Column {
            align: input.number()? as u32,
            wrap: input.number()? != 0,
        });
    }
    let mut sections = Vec::new();
    for _ in 0..input.count()? {
        let kind = input.number()?;
        if kind > 1 {
            return Err(invalid("invalid section kind"));
        }
        let mut rows = Vec::new();
        for _ in 0..input.count()? {
            let mut cells = Vec::new();
            for _ in 0..input.count()? {
                cells.push(WriteCell {
                    column: input.number()?,
                    colspan: input.number()?,
                    rowspan: input.number()?,
                    block: input.number()? != 0,
                    value: input.borrowed_text()?,
                });
            }
            rows.push(cells);
        }
        sections.push(WriteSection {
            head: kind == 0,
            rows,
        });
    }
    let caption = if input.number()? == 0 {
        None
    } else {
        let value = input.borrowed_text()?;
        let mode = input.number()?;
        let id = match mode {
            0 => None,
            1 => Some(None),
            2 => Some(Some(input.borrowed_text()?)),
            _ => return Err(invalid("invalid caption ID")),
        };
        let side = input.number()?;
        if side > 1 {
            return Err(invalid("invalid caption side"));
        }
        Some(WriteCaption {
            value,
            id,
            bottom: side == 1,
        })
    };
    input.finish()?;
    Ok(WriteTable {
        columns,
        sections,
        caption,
    })
}

pub fn decode_and_write(bytes: &[u8]) -> Result<Text, String> {
    stringify(&decode(bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn javascript_unicode_whitespace_is_not_ascii_padding() {
        for unit in [0xa0, 0x2028, 0x2029, 0xfeff] {
            let mask = shadow(&[unit]);
            assert!(re!(r"^\s$").is_match(&mask));
            assert!(!re!(r"^[ \t]$").is_match(&mask));
            assert!(!re!(r"^[^\s]$").is_match(&mask));
            assert!(re!(r"^[^\x00-\x20]$").is_match(&mask));
        }
        assert!(!re!(r"^(`{3,})([^\r\n\x82]*)$").is_match(&shadow(&text("```a\u{2028}b"))));
    }
}
