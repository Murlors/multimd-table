use std::borrow::Cow;
use std::collections::HashMap;

pub type Text = Vec<u16>;
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Column {
    pub align: u32,
    pub wrap: bool,
}
/// 单行单元格内联保存唯一片段；只有续行才需要额外堆分配。
#[derive(Clone, Debug, PartialEq)]
pub struct Segments {
    first: Range,
    following: Vec<Range>,
}
impl Segments {
    fn new(first: Range) -> Self {
        Self {
            first,
            following: Vec::new(),
        }
    }
    pub fn len(&self) -> usize {
        1 + self.following.len()
    }
    pub fn iter(&self) -> impl Iterator<Item = &Range> {
        std::iter::once(&self.first).chain(&self.following)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub column: usize,
    pub colspan: usize,
    pub rowspan: usize,
    pub align: u32,
    pub wrap: bool,
    pub block: bool,
    pub segments: Segments,
    pub range: Range,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub cells: std::ops::Range<usize>,
    pub range: Range,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub head: bool,
    pub rows: Vec<Row>,
    pub range: Range,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Caption {
    pub value: Text,
    pub id: Option<Text>,
    pub bottom: bool,
    pub range: Range,
    pub content_range: Range,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    /// 所有行共用连续单元格存储；行仅保存索引，不逐行分配或复制单元格。
    pub cells: Vec<Cell>,
    pub columns: Vec<Column>,
    pub caption: Option<Caption>,
    pub sections: Vec<Section>,
    pub range: Range,
}

/// 固定比特位对应 JS 五个显式选项；默认值由绑定编码为 24。
#[derive(Clone, Copy, Debug)]
pub struct Options(pub u32);
impl Options {
    pub fn multiline(self) -> bool {
        self.0 & 1 != 0
    }
    pub fn rowspan(self) -> bool {
        self.0 & 2 != 0
    }
    pub fn headerless(self) -> bool {
        self.0 & 4 != 0
    }
    pub fn multibody(self) -> bool {
        self.0 & 8 != 0
    }
    pub fn autolabel(self) -> bool {
        self.0 & 16 != 0
    }
}

/// ECMAScript WhiteSpace/LineTerminator，不能用 Rust 的 Unicode trim 默认集合替代。
pub fn whitespace(c: u16) -> bool {
    matches!(c, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
pub fn trim_start(s: &[u16]) -> usize {
    s.iter().position(|&c| !whitespace(c)).unwrap_or(s.len())
}
pub fn trim_end(s: &[u16]) -> usize {
    s.iter().rposition(|&c| !whitespace(c)).map_or(0, |i| i + 1)
}
pub fn trim(s: &[u16]) -> &[u16] {
    let start = trim_start(s);
    &s[start..trim_end(s).max(start)]
}
pub fn text(s: &str) -> Text {
    s.encode_utf16().collect()
}
pub fn ascii_eq(s: &[u16], expected: &str) -> bool {
    s.iter().copied().eq(expected.bytes().map(u16::from))
}

struct CodeSpans<'a> {
    source: &'a [u16],
    complete: bool,
    last: Option<HashMap<usize, usize>>,
}
impl<'a> CodeSpans<'a> {
    fn new(source: &'a [u16]) -> Self {
        Self {
            source,
            complete: false,
            last: None,
        }
    }
    fn end(&mut self, start: usize) -> usize {
        let mut end = start + 1;
        while self.source.get(end) == Some(&96) {
            end += 1;
        }
        let size = end - start;
        if self.complete
            && self
                .last
                .as_ref()
                .and_then(|last| last.get(&size))
                .is_none_or(|&last| last <= start)
        {
            return end;
        }
        let mut cursor = end;
        while cursor < self.source.len() {
            if self.source[cursor] != 96 {
                cursor += 1;
                continue;
            }
            let mut next = cursor + 1;
            while self.source.get(next) == Some(&96) {
                next += 1;
            }
            if next - cursor == size {
                return next;
            }
            if !self.complete {
                // 常见行及直接闭合的代码跨度不需要创建哈希状态。
                self.last
                    .get_or_insert_with(HashMap::new)
                    .insert(next - cursor, cursor);
            }
            cursor = next;
        }
        self.complete = true;
        end
    }
}

/// 直接扫描 UTF-16 单元，保留 JS 索引与非法代理字符，无 UTF-8 往返。
pub fn cell_bounds(s: &[u16]) -> Vec<isize> {
    scan_bounds(s).to_vec()
}

/// 常见窄表的边界随行内联保存，宽表溢出后使用 Vec；公开 API 仍返回普通 Vec。
#[derive(Default)]
pub(crate) struct Bounds {
    inline: [isize; 8],
    spilled: Vec<isize>,
    length: usize,
}
impl std::ops::Deref for Bounds {
    type Target = [isize];
    fn deref(&self) -> &[isize] {
        if self.length <= 8 {
            &self.inline[..self.length]
        } else {
            &self.spilled
        }
    }
}
impl Bounds {
    #[inline(always)]
    fn push(&mut self, bound: isize) {
        if self.length < 8 {
            self.inline[self.length] = bound;
        } else {
            if self.length == 8 {
                self.spilled.reserve(16);
                self.spilled.extend_from_slice(&self.inline);
            }
            self.spilled.push(bound);
        }
        self.length += 1;
    }
}
pub(crate) fn scan_bounds(s: &[u16]) -> Bounds {
    let mut pipes = Bounds::default();
    let mut spans = CodeSpans::new(s);
    let mut i = 0;
    while i < s.len() {
        match s[i] {
            92 => {
                i += 2;
                continue;
            }
            96 => {
                i = spans.end(i);
                continue;
            }
            124 => {
                if pipes.is_empty() {
                    if i != 0 {
                        pipes.push(-1);
                    }
                }
                pipes.push(i as isize);
            }
            _ => (),
        }
        i += 1;
    }
    if pipes.is_empty() {
        return pipes;
    }
    let end = trim_end(s) as isize;
    if pipes.last().copied() != Some(end - 1) {
        pipes.push(end);
    }
    pipes
}

pub fn delimiter_value(s: &[u16]) -> bool {
    let mut end = s.len();
    if end > 0 && s[end - 1] == 43 {
        end -= 1;
    }
    if end > 0 && s[end - 1] == 58 {
        end -= 1;
    }
    let start = usize::from(s.first() == Some(&58));
    start < end && matches!(s[start], 45 | 61) && s[start..end].iter().all(|&c| c == s[start])
}
fn delimiter(s: &[u16], bounds: &[isize]) -> Option<Vec<Column>> {
    let mut indent = 0;
    for &c in s {
        match c {
            32 => indent += 1,
            9 => indent += 4 - indent % 4,
            _ => break,
        }
    }
    if indent >= 4 || bounds.is_empty() {
        return None;
    }
    let mut columns = Vec::new();
    for pair in bounds.windows(2) {
        let value = trim(&s[(pair[0] + 1) as usize..pair[1] as usize]);
        if !delimiter_value(value) {
            return None;
        }
        let wrap = value.last() == Some(&43);
        let marker = if wrap {
            &value[..value.len() - 1]
        } else {
            value
        };
        let align = match (marker.first() == Some(&58), marker.last() == Some(&58)) {
            (true, true) => 2,
            (true, false) => 1,
            (false, true) => 3,
            _ => 0,
        };
        columns.push(Column { align, wrap });
    }
    Some(columns)
}

pub fn label(s: &[u16]) -> Text {
    char::decode_utf16(s.iter().copied())
        .filter_map(Result::ok)
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .map(|c| c as u16)
        .collect()
}
fn caption_at(s: &[u16], offset: usize, autolabel: bool) -> Option<Caption> {
    let start = trim_start(s);
    if s.get(start) != Some(&91) {
        return None;
    }
    let mut depth = 1;
    let mut end = start + 1;
    let mut spans = CodeSpans::new(s);
    while end < s.len() {
        match s[end] {
            92 => {
                end += 2;
                continue;
            }
            96 => {
                end = spans.end(end);
                continue;
            }
            91 => depth += 1,
            93 => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => (),
        }
        end += 1;
    }
    if depth != 0 {
        return None;
    }
    let suffix = trim(&s[end + 1..]);
    if !suffix.is_empty()
        && (suffix.len() < 3
            || suffix[0] != 91
            || *suffix.last()? != 93
            || suffix[1..suffix.len() - 1]
                .iter()
                .any(|c| matches!(c, 91 | 93 | 10 | 13)))
    {
        return None;
    }
    let content = &s[start + 1..end];
    if trim(content).is_empty() {
        return None;
    }
    let id = if !suffix.is_empty() {
        Some(label(&suffix[1..suffix.len() - 1]))
    } else if autolabel {
        Some(label(content))
    } else {
        None
    };
    Some(Caption {
        value: content.to_vec(),
        id,
        bottom: false,
        range: Range {
            start: offset,
            end: offset + s.len(),
        },
        content_range: Range {
            start: offset + start + 1,
            end: offset + end,
        },
    })
}

#[derive(Clone)]
struct Physical<'a> {
    text: Cow<'a, [u16]>,
    offset: usize,
    continued: bool,
    bounds: std::ops::Range<usize>,
}
struct Logical<'a> {
    first: Physical<'a>,
    following: Vec<Physical<'a>>,
}
struct Group<'a> {
    head: bool,
    rows: Vec<Logical<'a>>,
}

pub struct Scanner<'a> {
    pub options: Options,
    columns: Option<Vec<Column>>,
    groups: Vec<Group<'a>>,
    // 行仅保存边界索引；连续存储避免每行分配，也避免在行移动时复制内联数组。
    bounds: Vec<isize>,
    continuation: bool,
    caption: Option<Caption>,
    gap: bool,
    first_offset: Option<usize>,
    end_offset: usize,
    closed: bool,
}
impl<'a> Scanner<'a> {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            columns: None,
            groups: Vec::new(),
            bounds: Vec::new(),
            continuation: false,
            caption: None,
            gap: false,
            first_offset: None,
            end_offset: 0,
            closed: false,
        }
    }
    pub fn committed(&self) -> bool {
        self.columns.is_some()
    }
    pub fn accepted(&self) -> bool {
        self.committed() && !self.groups.is_empty()
    }
    pub fn flags(&self) -> u32 {
        u32::from(self.accepted())
            | (u32::from(self.committed()) << 1)
            | (u32::from(self.closed) << 2)
    }
    fn extent(&mut self, offset: usize, length: usize) {
        self.first_offset.get_or_insert(offset);
        self.end_offset = offset + length;
    }
    pub fn push(&mut self, s: &[u16], offset: usize) -> bool {
        self.push_with(s, offset, || Cow::Owned(s.to_vec()))
    }
    // 整段解析借用调用期间有效的输入；增量扫描仍拥有每次接受的行。
    fn push_borrowed(&mut self, s: &'a [u16], offset: usize) -> bool {
        self.push_with(s, offset, || Cow::Borrowed(s))
    }
    fn push_with(
        &mut self,
        s: &[u16],
        offset: usize,
        retain: impl FnOnce() -> Cow<'a, [u16]>,
    ) -> bool {
        if self.closed {
            return false;
        }
        let start = trim_start(s);
        if start == s.len() {
            if !self.options.multibody()
                || self.gap
                || self.continuation
                || self.groups.last().is_none_or(|g| g.head)
            {
                return false;
            }
            self.gap = true;
            return true;
        }
        let mut bounds = None;
        if !self.committed() {
            let found = scan_bounds(s);
            if let Some(columns) = delimiter(s, &found) {
                if self.groups.is_empty() && !self.options.headerless() {
                    return false;
                }
                self.continuation = false;
                self.columns = Some(columns);
                self.extent(offset, s.len());
                return true;
            }
            bounds = Some(found);
        }
        if !self.continuation && s[start] == 91 {
            if let Some(mut caption) = caption_at(s, offset, self.options.autolabel()) {
                if self.caption.is_some()
                    || self.gap
                    || (!self.committed() && !self.groups.is_empty())
                    || (self.committed() && !self.accepted())
                {
                    return false;
                }
                caption.bottom = self.committed();
                self.closed = self.committed();
                self.caption = Some(caption);
                self.extent(offset, s.len());
                return true;
            }
        }
        let bounds = bounds.unwrap_or_else(|| scan_bounds(s));
        if bounds.len() < 2 {
            return false;
        }
        let continued = self.options.multiline() && s.last() == Some(&92);
        let bounds = if continued {
            scan_bounds(&s[..s.len() - 1])
        } else {
            bounds
        };
        let bounds_start = self.bounds.len();
        self.bounds.extend_from_slice(&bounds);
        let physical = Physical {
            text: retain(),
            offset,
            continued,
            bounds: bounds_start..self.bounds.len(),
        };
        if self.continuation {
            self.groups
                .last_mut()
                .unwrap()
                .rows
                .last_mut()
                .unwrap()
                .following
                .push(physical);
            if !continued {
                self.continuation = false;
            }
        } else {
            let head = !self.committed();
            if self.groups.last().is_none_or(|g| g.head != head) || self.gap {
                self.groups.push(Group {
                    head,
                    rows: Vec::new(),
                });
            }
            self.groups.last_mut().unwrap().rows.push(Logical {
                first: physical,
                following: Vec::new(),
            });
            if continued {
                self.continuation = true;
            }
        }
        self.gap = false;
        self.extent(offset, s.len());
        true
    }
    pub fn finish(&self) -> Option<Table> {
        if !self.accepted() {
            return None;
        }
        let columns = self.columns.as_ref().unwrap();
        let mut sections = Vec::new();
        let capacity = self
            .groups
            .iter()
            .flat_map(|group| &group.rows)
            .map(|row| {
                if row.following.last().unwrap_or(&row.first).continued {
                    std::iter::once(&row.first)
                        .chain(&row.following)
                        .map(|line| line.bounds.len().saturating_sub(1))
                        .sum()
                } else {
                    row.first.bounds.len().saturating_sub(1)
                }
            })
            .sum();
        let mut cells = Vec::with_capacity(capacity);
        for group in &self.groups {
            let mut rows = Vec::<Row>::with_capacity(group.rows.len());
            let mut previous = Vec::<Option<usize>>::new();
            let mut extended = HashMap::new();
            for logical in &group.rows {
                let last = logical.following.last().unwrap_or(&logical.first);
                if last.continued {
                    for first in std::iter::once(&logical.first).chain(&logical.following) {
                        let row = materialize(
                            first,
                            &[],
                            columns,
                            &self.bounds,
                            self.options.rowspan(),
                            rows.len(),
                            &mut cells,
                            &mut previous,
                            &mut extended,
                        );
                        rows.push(row);
                    }
                } else {
                    let row = materialize(
                        &logical.first,
                        &logical.following,
                        columns,
                        &self.bounds,
                        self.options.rowspan(),
                        rows.len(),
                        &mut cells,
                        &mut previous,
                        &mut extended,
                    );
                    rows.push(row);
                }
            }
            let range = Range {
                start: rows.first().unwrap().range.start,
                end: rows.last().unwrap().range.end,
            };
            sections.push(Section {
                head: group.head,
                rows,
                range,
            });
        }
        Some(Table {
            cells,
            columns: columns.clone(),
            caption: self.caption.clone(),
            sections,
            range: Range {
                start: self.first_offset.unwrap(),
                end: self.end_offset,
            },
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn materialize(
    first: &Physical<'_>,
    following: &[Physical<'_>],
    columns: &[Column],
    bounds: &[isize],
    rowspan: bool,
    row_index: usize,
    cells: &mut Vec<Cell>,
    previous: &mut Vec<Option<usize>>,
    extended: &mut HashMap<usize, usize>,
) -> Row {
    let last = following.last().unwrap_or(first);
    let block = !following.is_empty();
    let width = first.bounds.len().saturating_sub(1);
    let first_bounds = &bounds[first.bounds.clone()];
    let last_bounds = &bounds[last.bounds.clone()];
    if rowspan {
        previous.resize(width.max(previous.len()), None);
    }
    let cell_start = cells.len();
    let mut column = 0;
    while column < width {
        let begin = (first_bounds[column] + 1) as usize;
        let end = first_bounds[column + 1] as usize;
        let raw = &first.text[begin..end];
        if raw.is_empty() {
            if rowspan {
                previous[column] = None;
            }
            column += 1;
            continue;
        }
        let mut next = column + 1;
        while next < width && first_bounds[next] + 1 == first_bounds[next + 1] {
            next += 1;
        }
        let leading = if block { 0 } else { trim_start(raw) };
        let start = first.offset + begin + leading;
        let end = trim_end(raw).max(leading) - leading;
        let mut segments = Segments::new(Range {
            start,
            end: start + end,
        });
        let mut marker = rowspan && ascii_eq(trim(raw), "^^");
        if block {
            // trim(join(parts, "\n")) 为 ^^，当且仅当唯一非空白片段为 ^^。
            let mut nonempty = usize::from(!trim(raw).is_empty());
            for line in following {
                let line_bounds = &bounds[line.bounds.clone()];
                if let Some(&end) = line_bounds.get(column + 1) {
                    let begin = (line_bounds[column] + 1) as usize;
                    let source = &line.text[begin..end as usize];
                    let end = trim_end(source);
                    if rowspan && !trim(source).is_empty() {
                        nonempty += 1;
                        marker = ascii_eq(trim(source), "^^");
                    }
                    segments.following.push(Range {
                        start: line.offset + begin,
                        end: line.offset + begin + end,
                    });
                }
            }
            marker &= nonempty == 1;
        }
        let inherited = if marker { previous[column] } else { None };
        let origin = if let Some(origin) = inherited {
            if extended.insert(origin, row_index) != Some(row_index) {
                cells[origin].rowspan += 1;
            }
            origin
        } else {
            let origin = cells.len();
            cells.push(Cell {
                column,
                colspan: next - column,
                rowspan: 1,
                align: columns.get(column).map_or(0, |c| c.align),
                wrap: columns.get(column).is_some_and(|c| c.wrap),
                block,
                segments,
                range: Range {
                    start: first.offset + begin,
                    end: last.offset
                        + last_bounds
                            .get(column + 1)
                            .map_or(last.text.len(), |&n| n as usize),
                },
            });
            origin
        };
        if rowspan {
            previous[column..next].fill(Some(origin));
        }
        column = next;
    }
    if rowspan {
        previous.truncate(width);
    }
    Row {
        cells: cell_start..cells.len(),
        range: Range {
            start: first.offset,
            end: last.offset + last.text.len(),
        },
    }
}

pub fn parse_table(source: &[u16], options: Options) -> Option<Table> {
    scan_table(source, options).finish()
}

/// 与完整解析共用的扫描阶段，供实验性能探针单独测量。
pub fn scan_table(source: &[u16], options: Options) -> Scanner<'_> {
    let mut scanner = Scanner::new(options);
    let mut offset = 0;
    while offset < source.len() {
        let end = source[offset..]
            .iter()
            .position(|c| matches!(c, 10 | 13))
            .map_or(source.len(), |n| offset + n);
        if !scanner.push_borrowed(&source[offset..end], offset) || scanner.closed {
            break;
        }
        offset = end
            + if source.get(end) == Some(&13) && source.get(end + 1) == Some(&10) {
                2
            } else {
                1
            };
    }
    scanner
}
