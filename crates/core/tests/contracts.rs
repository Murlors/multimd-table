use multimd_table_core::core::{Options, Scanner, parse_table, text};
use multimd_table_core::wire::{Input, Output};
use multimd_table_core::writer::decode_and_write;

#[test]
fn snapshots_do_not_change_after_rowspan_extension() {
    let mut scanner = Scanner::new(Options(26));
    assert!(scanner.push(&text("A|B"), 0));
    assert!(scanner.push(&text("-|-"), 4));
    assert!(scanner.push(&text("x||"), 8));
    let first = scanner.finish().unwrap();
    assert!(scanner.push(&text("^^||"), 12));
    assert_eq!(
        first.cells[first.sections[1].rows[0].cells.start].rowspan,
        1
    );
    let second = scanner.finish().unwrap();
    assert_eq!(
        second.cells[second.sections[1].rows[0].cells.start].rowspan,
        2
    );
    let before = scanner.finish();
    assert!(!scanner.push(&text("rejected"), 17));
    assert_eq!(scanner.finish(), before);
}

#[test]
fn empty_and_mixed_eol_inputs_are_safe() {
    assert!(parse_table(&[], Options(24)).is_none());
    let model = parse_table(&text("A|B\r\n-|-\rx|y"), Options(24)).unwrap();
    assert_eq!(model.sections[1].rows[0].range.start, 9);
    assert_eq!(model.range.end, 12);
}

#[test]
fn inline_boundaries_and_spilled_boundaries_preserve_columns() {
    use multimd_table_core::core::cell_bounds;
    for width in 2..=20 {
        for outer in [false, true] {
            let mut row = vec!["a"; width].join("|");
            if outer {
                row = format!("|{row}|");
            }
            let units = text(&row);
            let expected: Vec<_> = if outer {
                (0..=width).map(|i| (i * 2) as isize).collect()
            } else {
                std::iter::once(-1)
                    .chain((1..width).map(|i| (i * 2 - 1) as isize))
                    .chain(std::iter::once(units.len() as isize))
                    .collect()
            };
            assert_eq!(cell_bounds(&units), expected);
            let source = text(&format!("{row}\n{}\n{row}", vec!["-"; width].join("|")));
            let table = parse_table(&source, Options(24)).unwrap();
            assert_eq!(table.columns.len(), width);
            assert_eq!(table.sections[1].rows[0].cells.len(), width);
        }
    }
}

#[test]
fn multiline_rowspan_markers_use_joined_trimmed_content() {
    for (first, second, merged) in [
        (" ^^ ", "   ", true),
        ("   ", " ^^ ", true),
        (" ^ ", " ^ ", false),
        (" ^^ ", " x ", false),
    ] {
        let source = text(&format!("A|B\n-|-\nx|y\n|{first}| z |\\\n|{second}| q |"));
        let table = parse_table(&source, Options(27)).unwrap();
        let rows = &table.sections[1].rows;
        assert_eq!(
            table.cells[rows[0].cells.start].rowspan,
            if merged { 2 } else { 1 }
        );
        assert_eq!(rows[1].cells.len(), if merged { 1 } else { 2 });
        let cell = &table.cells[rows[1].cells.end - 1];
        assert_eq!(cell.segments.len(), 2);
        assert_eq!(
            cell.segments
                .iter()
                .map(|r| &source[r.start..r.end])
                .collect::<Vec<_>>(),
            vec![&text(" z")[..], &text(" q")[..]]
        );
    }
}

#[test]
fn writer_requests_reject_every_truncation_and_trailing_bytes() {
    let mut output = Output::new();
    for n in [1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 0] {
        output.number(n);
    }
    output.text(&text("hello"));
    output.number(0);
    assert_eq!(
        decode_and_write(&output.0).unwrap(),
        text("|---|\n| hello |")
    );
    let mut unaligned = vec![0];
    unaligned.extend_from_slice(&output.0);
    assert_eq!(
        decode_and_write(&unaligned[1..]).unwrap(),
        text("|---|\n| hello |")
    );
    for end in 0..output.0.len() {
        assert!(decode_and_write(&output.0[..end]).is_err(), "prefix {end}");
    }
    output.0.extend_from_slice(&[0, 0]);
    assert!(decode_and_write(&output.0).is_err());
}

#[test]
fn wire_lengths_cannot_read_outside_the_request() {
    for bytes in [&[255, 255, 255, 255][..], &[1, 0, 0, 0, 0][..]] {
        assert!(Input::new(bytes).text().is_err());
    }
}

#[test]
fn ffi_returns_owned_json_preserving_surrogates_and_controls() {
    use multimd_table_core::{mm_parse_json, mm_result_free, mm_result_len, mm_result_ptr};
    let mut source = text("A|B\n-|-\n");
    source.extend([0xd800, 0, 124, 0xd83d, 0xde00]);
    unsafe {
        let response = mm_parse_json(source.as_ptr(), source.len(), 24);
        let bytes = std::slice::from_raw_parts(mm_result_ptr(response), mm_result_len(response));
        let json = std::str::from_utf8(bytes).unwrap();
        assert!(json.contains("\\ud800\\u0000"));
        assert!(json.contains('😀'));
        mm_result_free(response);
    }
}
