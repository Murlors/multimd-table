//! Writer 的固定 Markdown 识别规则；直接返回原文 UTF-16 坐标，不分配中间字符串。
use crate::core::{trim, trim_end, trim_start, whitespace};

fn letter(c: u16) -> bool {
    matches!(c, 65..=90 | 97..=122)
}

fn digit(c: u16) -> bool {
    matches!(c, 48..=57)
}

fn word(c: u16) -> bool {
    letter(c) || digit(c) || c == 95
}

pub(super) fn ascii_case_eq(value: &[u16], expected: &[u8]) -> bool {
    value.len() == expected.len()
        && value.iter().zip(expected).all(|(&c, &byte)| {
            let lower = if matches!(c, 65..=90) { c + 32 } else { c };
            lower == u16::from(byte)
        })
}

/// 识别完整标签，保留属性值中的引号、空白及分隔符；不解释 HTML 内容。
pub(super) fn html_tag(s: &[u16]) -> Option<(usize, &[u16])> {
    if s.first() != Some(&60) {
        return None;
    }
    let start = if s.get(1) == Some(&47) { 2 } else { 1 };
    if !s.get(start).is_some_and(|&c| letter(c)) {
        return None;
    }
    let mut end = start + 1;
    while s
        .get(end)
        .is_some_and(|&c| letter(c) || digit(c) || c == 45)
    {
        end += 1;
    }
    let name = &s[start..end];
    loop {
        let gap = trim_start(&s[end..]);
        end += gap;
        match s.get(end) {
            Some(62) => return Some((end + 1, name)),
            Some(47) if s.get(end + 1) == Some(&62) => return Some((end + 2, name)),
            _ => (),
        }
        if gap == 0
            || !s
                .get(end)
                .is_some_and(|&c| letter(c) || matches!(c, 95 | 58))
        {
            return None;
        }
        end += 1;
        while s
            .get(end)
            .is_some_and(|&c| word(c) || matches!(c, 46 | 58 | 45))
        {
            end += 1;
        }
        let assignment = end + trim_start(&s[end..]);
        if s.get(assignment) != Some(&61) {
            continue;
        }
        end = assignment + 1;
        end += trim_start(&s[end..]);
        if let Some(&quote @ (34 | 39)) = s.get(end) {
            end += 1;
            end += s[end..].iter().position(|&c| c == quote)? + 1;
        } else {
            let start = end;
            while s
                .get(end)
                .is_some_and(|&c| !whitespace(c) && !matches!(c, 34 | 39 | 61 | 60 | 62 | 96))
            {
                end += 1;
            }
            if end == start {
                return None;
            }
        }
    }
}

pub(super) fn raw_html_end(s: &[u16], name: &[u16]) -> usize {
    let mut offset = 0;
    while let Some(next) = s[offset..].iter().position(|&c| c == 60) {
        let start = offset + next;
        offset = start + 1;
        let end = start + 2 + name.len();
        if s.get(start + 1) != Some(&47) || end > s.len() {
            continue;
        }
        // name 已由 HTML 标签识别器限定为 ASCII；按原始大小写无关地比较。
        if !s[start + 2..end]
            .iter()
            .zip(name)
            .all(|(&a, &b)| (a | 32) == (b | 32))
        {
            continue;
        }
        let end = end + trim_start(&s[end..]);
        if s.get(end) == Some(&62) {
            return end + 1;
        }
    }
    s.len()
}

pub(super) fn autolink_end(s: &[u16]) -> Option<usize> {
    if s.first() != Some(&60) {
        return None;
    }
    // 两类自动链接都不允许嵌套 '<'；立即停下，避免无效尖括号串反复扫描整段后缀。
    let end = 1 + s[1..].iter().position(|&c| matches!(c, 60 | 62))?;
    if s[end] != 62 {
        return None;
    }
    let body = &s[1..end];
    let scheme = body.iter().position(|&c| c == 58).is_some_and(|colon| {
        (2..=32).contains(&colon)
            && letter(body[0])
            && body[1..colon]
                .iter()
                .all(|&c| letter(c) || digit(c) || matches!(c, 43 | 46 | 45))
            && body[colon + 1..]
                .iter()
                .all(|&c| c > 32 && !matches!(c, 60 | 62))
    });
    let email = body
        .iter()
        .all(|&c| !whitespace(c) && !matches!(c, 60 | 62))
        && body
            .iter()
            .enumerate()
            .any(|(i, &c)| c == 64 && i + 1 < body.len());
    (scheme || email).then_some(end + 1)
}

/// 跳过引用及其后的列表前缀；识别失败时保留对应部分的原始缩进。
pub(super) fn container_start(s: &[u16]) -> usize {
    let mut end = trim_start(s);
    let mut quote = 0;
    while s.get(end) == Some(&62) {
        end += 1;
        end += trim_start(&s[end..]);
        quote = end;
    }
    end = quote + trim_start(&s[quote..]);
    if s.get(end).is_some_and(|&c| matches!(c, 45 | 43 | 42)) {
        end += 1;
    } else {
        let start = end;
        while s.get(end).is_some_and(|&c| digit(c)) {
            end += 1;
        }
        if end == start || !s.get(end).is_some_and(|&c| matches!(c, 46 | 41)) {
            return quote;
        }
        end += 1;
    }
    let gap = trim_start(&s[end..]);
    if gap == 0 { quote } else { end + gap }
}

pub(super) fn opening_fence(s: &[u16]) -> Option<(u16, usize)> {
    let s = &s[trim_start(s)..];
    let &marker @ (96 | 126) = s.first()? else {
        return None;
    };
    let length = s.iter().take_while(|&&c| c == marker).count();
    (length >= 3
        && !s[length..]
            .iter()
            .any(|&c| matches!(c, 10 | 13 | 0x2028 | 0x2029)))
    .then_some((marker, length))
}

pub(super) fn closing_fence(s: &[u16], marker: u16, length: usize) -> bool {
    let s = trim(s);
    s.len() >= length && s.iter().all(|&c| c == marker)
}

/// 保留原写出合同的最短标题捕获，拒绝被误读为显式标签的后缀。
pub(super) fn caption_value_end(s: &[u16]) -> Option<usize> {
    let s = &s[..trim_end(s)];
    for end in 2..s.len() {
        if s[end] != 93 {
            continue;
        }
        let suffix = &s[end + 1..];
        if suffix.is_empty()
            || (suffix.len() >= 3
                && suffix[0] == 91
                && suffix[suffix.len() - 1] == 93
                && !suffix[1..suffix.len() - 1]
                    .iter()
                    .any(|&c| matches!(c, 91 | 93)))
        {
            return Some(end);
        }
    }
    None
}

fn block_start(s: &[u16]) -> Option<usize> {
    let start = s.iter().take_while(|&&c| c == 32).count();
    (start <= 3).then_some(start)
}

/// 返回提升为块单元格时需转义的标记位置；有序列表转义其句点或右括号。
pub(super) fn promotion_escape(s: &[u16]) -> Option<usize> {
    let start = block_start(s)?;
    let s = &s[start..];
    let &first = s.first()?;
    if first == 62 {
        return Some(start);
    }
    if first == 35 {
        let hashes = s.iter().take_while(|&&c| c == 35).count();
        if hashes <= 6 && s.get(hashes).is_none_or(|&c| whitespace(c)) {
            return Some(start);
        }
    }
    if matches!(first, 45 | 43 | 42) && s.get(1).is_some_and(|&c| whitespace(c)) {
        return Some(start);
    }
    if digit(first) {
        let digits = s.iter().take_while(|&&c| digit(c)).count();
        if digits <= 9
            && s.get(digits).is_some_and(|&c| matches!(c, 46 | 41))
            && s.get(digits + 1).is_some_and(|&c| whitespace(c))
        {
            return Some(start + digits);
        }
    }
    if matches!(first, 42 | 45 | 95) {
        let mut count = 0;
        for &c in s {
            if c == first {
                count += 1;
            } else if !whitespace(c) {
                return None;
            }
        }
        if count >= 3 {
            return Some(start);
        }
    }
    None
}

pub(super) fn promotion_rejected(s: &[u16]) -> bool {
    let Some(start) = block_start(s) else {
        return false;
    };
    let s = &s[start..];
    if s.first() == Some(&91) {
        return s[1..]
            .iter()
            .position(|&c| c == 93)
            .is_some_and(|end| end > 0 && s.get(end + 2) == Some(&58));
    }
    if s.first() != Some(&60) {
        return false;
    }
    if matches!(s.get(1), Some(33 | 63)) {
        return true;
    }
    let start = if s.get(1) == Some(&47) { 2 } else { 1 };
    // 对应 ASCII 单词边界；连字符及非 ASCII 字符也会结束块标签名。
    let length = s[start..].iter().take_while(|&&c| word(c)).count();
    let name = &s[start..start + length];
    const BLOCKS: &[&[u8]] = &[
        b"address",
        b"article",
        b"aside",
        b"base",
        b"basefont",
        b"blockquote",
        b"body",
        b"caption",
        b"center",
        b"col",
        b"colgroup",
        b"dd",
        b"details",
        b"dialog",
        b"dir",
        b"div",
        b"dl",
        b"dt",
        b"fieldset",
        b"figcaption",
        b"figure",
        b"footer",
        b"form",
        b"frame",
        b"frameset",
        b"h1",
        b"h2",
        b"h3",
        b"h4",
        b"h5",
        b"h6",
        b"head",
        b"header",
        b"hr",
        b"html",
        b"iframe",
        b"legend",
        b"li",
        b"link",
        b"main",
        b"menu",
        b"menuitem",
        b"nav",
        b"noframes",
        b"ol",
        b"optgroup",
        b"option",
        b"p",
        b"param",
        b"search",
        b"section",
        b"summary",
        b"table",
        b"tbody",
        b"td",
        b"tfoot",
        b"th",
        b"thead",
        b"title",
        b"tr",
        b"track",
        b"ul",
    ];
    BLOCKS.iter().any(|expected| ascii_case_eq(name, expected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::text;

    #[test]
    fn html_attributes_require_complete_values_and_separators() {
        for source in [
            "<a title=\"a|b > c\" hidden data-x = '😀'>",
            "</Custom-Tag :key='value' _flag />",
            "<code value=x/>",
            "<x\u{a0}a\u{feff}=\u{2028}b>",
        ] {
            let value = text(source);
            assert_eq!(html_tag(&value).unwrap().0, value.len(), "{source}");
        }
        for source in [
            "<x a=>",
            "<x a='open>",
            "<x a=\"x\"b=y>",
            "<x\u{85}a>",
            "<x=1>",
        ] {
            assert!(html_tag(&text(source)).is_none(), "{source}");
        }
        assert!(html_tag(&[60, 120, 32, 97, 61, 34, 0xd800, 34, 62]).is_some());
    }

    #[test]
    fn raw_html_closes_only_on_the_same_tag() {
        let source = text("</style></code-x>a|b</CoDe\u{feff}>tail");
        assert_eq!(raw_html_end(&source, &text("code")), source.len() - 4);
        assert_eq!(raw_html_end(&source, &text("textarea")), source.len());
    }

    #[test]
    fn autolinks_keep_uri_and_email_character_rules_distinct() {
        for source in ["<ab:>", "<ab:a\u{a0}b>", "<@x>", "<a@b@c>", "<a:\0@b>"] {
            let value = text(source);
            assert_eq!(autolink_end(&value), Some(value.len()), "{source}");
        }
        for source in ["<a:b>", "<@>", "<a@b\u{a0}c>", "<ab:a b>", "<ab:a<b>"] {
            assert_eq!(autolink_end(&text(source)), None, "{source}");
        }
        assert!(autolink_end(&text(&format!("<{}:>", "a".repeat(32)))).is_some());
        assert!(autolink_end(&text(&format!("<{}:>", "a".repeat(33)))).is_none());
    }

    #[test]
    fn unicode_whitespace_retains_javascript_boundaries() {
        for unit in [0xa0, 0x2028, 0x2029, 0xfeff] {
            assert_eq!(container_start(&[62, unit, 45, unit, 96]), 4);
            assert_eq!(promotion_escape(&[35, unit, 120]), Some(0));
            assert_eq!(opening_fence(&[unit, 96, 96, 96]), Some((96, 3)));
            assert!(closing_fence(&[96, 96, 96, unit], 96, 3));
        }
        assert!(opening_fence(&text("```a\u{2028}b")).is_none());
        assert!(opening_fence(&text("```a\u{2029}b")).is_none());
        assert_eq!(opening_fence(&text("```a\u{a0}b")), Some((96, 3)));
        assert_eq!(container_start(&text("  not a list")), 0);
        assert_eq!(container_start(&text("> -x")), 2);
    }

    #[test]
    fn promotion_preserves_marker_limits_and_ascii_word_boundaries() {
        for (source, expected) in [
            ("######", Some(0)),
            ("####### ", None),
            ("123456789. item", Some(9)),
            ("1234567890. item", None),
            ("_ \u{a0}_ _", Some(0)),
            ("*-*", None),
            ("    >", None),
        ] {
            assert_eq!(promotion_escape(&text(source)), expected, "{source}");
        }
        for source in [
            "<DIV>",
            "</h6>",
            "<div-x>",
            "<div😀>",
            "<!anything",
            "<?",
            "[a[b]:target",
        ] {
            assert!(promotion_rejected(&text(source)), "{source}");
        }
        for source in [
            "<div_>",
            "<div1>",
            "<h7>",
            "<span>",
            "    <div>",
            "[]:target",
        ] {
            assert!(!promotion_rejected(&text(source)), "{source}");
        }
    }

    #[test]
    fn captions_select_the_first_complete_label_suffix() {
        for (source, expected) in [
            ("[a][id]", 2),
            ("[a][id][custom]", 6),
            ("[a][!]", 2),
            ("[a][]", 4),
            ("[]]", 2),
            ("[a]]\u{a0}", 3),
        ] {
            assert_eq!(caption_value_end(&text(source)), Some(expected), "{source}");
        }
    }
}
