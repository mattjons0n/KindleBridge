//! KFX must preserve table cell spans and ordered-list start values.
//!
//! These live in the IR `SemanticMap` (`col_span`, `row_span`, `list_start`)
//! and are emitted as Ion integers on the storyline element. Before the
//! carriers existed, KFX export dropped them: spanned cells collapsed to 1x1
//! and `<ol start=N>` lost its numbering.

mod common;

use boko::model::{Format, Role};

#[test]
fn kfx_preserves_table_spans_and_ol_start() {
    use common::{Doc, EpubBuilder, Nav};

    let epub = EpubBuilder::new("Spans Book")
        .doc(Doc::new(
            "text/ch1.xhtml",
            "Spans",
            "<h1>Grid</h1>\
             <table><thead><tr><th>Head</th></tr></thead><tbody>\
             <tr><td colspan=\"2\">wide</td><td rowspan=\"3\">tall</td></tr>\
             <tr><td>a</td><td>b</td></tr>\
             </tbody></table>\
             <ol start=\"5\"><li>five</li><li>six</li></ol>",
        ))
        .nav(vec![Nav::new("Grid", "text/ch1.xhtml")])
        .build();

    // Round-trip EPUB → KFX → import.
    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);
    let out = boko::Book::from_bytes(&kfx, Format::Kfx).expect("import kfx");

    // Table cell spans and the th/td distinction survive.
    let (mut saw_colspan, mut saw_rowspan, mut saw_header) = (false, false, false);
    let cell_ids: Vec<_> = {
        let ids: Vec<_> = out.spine().iter().map(|e| e.id).collect();
        let mut v = Vec::new();
        for id in ids {
            let ch = out.load_chapter(id).expect("load");
            for nid in ch.iter_dfs() {
                if ch.node(nid).map(|n| n.role) == Some(Role::TableCell) {
                    if ch.semantics.col_span(nid) == Some(2) {
                        saw_colspan = true;
                    }
                    if ch.semantics.row_span(nid) == Some(3) {
                        saw_rowspan = true;
                    }
                    if ch.semantics.is_header_cell(nid) {
                        saw_header = true;
                    }
                    v.push(nid);
                }
            }
        }
        v
    };
    assert!(!cell_ids.is_empty(), "KFX round-trip lost the table cells");
    assert!(saw_colspan, "colspan=2 did not survive the KFX round trip");
    assert!(saw_rowspan, "rowspan=3 did not survive the KFX round trip");
    assert!(
        saw_header,
        "th header cell did not survive the KFX round trip"
    );

    // Ordered-list start survives.
    let mut saw_start = false;
    let ids: Vec<_> = out.spine().iter().map(|e| e.id).collect();
    for id in ids {
        let ch = out.load_chapter(id).expect("load");
        for nid in ch.iter_dfs() {
            if ch.node(nid).map(|n| n.role) == Some(Role::OrderedList)
                && ch.semantics.list_start(nid) == Some(5)
            {
                saw_start = true;
            }
        }
    }
    assert!(saw_start, "ol start=5 did not survive the KFX round trip");
}

// ============================================================================
// Storyline encoding assertions (element types / classifications / markers)
// ============================================================================

/// Scan every storyline ($259) entity in a KFX container, returning the set of
/// element `type` symbol ids, `yj.classification` symbol ids, and resolved
/// `yj.semantics.type` marker names.
fn scan_storylines(
    kfx: &[u8],
) -> (
    std::collections::BTreeSet<u64>,
    std::collections::BTreeSet<u64>,
    std::collections::BTreeSet<String>,
) {
    use boko::kfx::container::{
        extract_doc_symbols, parse_container_header, parse_container_info, parse_index_table,
        skip_enty_header,
    };
    use boko::kfx::ion::{IonParser, IonValue};
    use boko::kfx::symbols::{KFX_SYMBOL_TABLE, KfxSymbol};

    let header = parse_container_header(&kfx[..18]).expect("container header");
    let info = parse_container_info(
        &kfx[header.container_info_offset
            ..header.container_info_offset + header.container_info_length],
    )
    .expect("container info");
    let doc_symbols = match info.doc_symbols {
        Some((off, len)) if len > 0 => extract_doc_symbols(&kfx[off..off + len]),
        _ => Vec::new(),
    };
    let (index_offset, index_length) = info.index.expect("index table");
    let entities = parse_index_table(
        &kfx[index_offset..index_offset + index_length],
        header.header_len,
    );

    let resolve = |id: u64| -> String {
        let base = KFX_SYMBOL_TABLE.len() as u64;
        if id < base {
            KFX_SYMBOL_TABLE[id as usize].to_string()
        } else {
            doc_symbols
                .get((id - base) as usize)
                .cloned()
                .unwrap_or_default()
        }
    };
    let semantics_field: Vec<u64> = doc_symbols
        .iter()
        .enumerate()
        .filter(|(_, s)| s.as_str() == "yj.semantics.type")
        .map(|(i, _)| i as u64 + KFX_SYMBOL_TABLE.len() as u64)
        .collect();

    let mut types = std::collections::BTreeSet::new();
    let mut classifications = std::collections::BTreeSet::new();
    let mut markers = std::collections::BTreeSet::new();

    fn walk(
        v: &IonValue,
        types: &mut std::collections::BTreeSet<u64>,
        classifications: &mut std::collections::BTreeSet<u64>,
        markers: &mut std::collections::BTreeSet<String>,
        semantics_field: &[u64],
        resolve: &dyn Fn(u64) -> String,
    ) {
        match v {
            IonValue::Struct(fields) => {
                for (k, val) in fields {
                    if *k == KfxSymbol::Type as u64
                        && let IonValue::Symbol(s) = val
                    {
                        types.insert(*s);
                    }
                    if *k == KfxSymbol::YjClassification as u64
                        && let IonValue::Symbol(s) = val
                    {
                        classifications.insert(*s);
                    }
                    if semantics_field.contains(k)
                        && let IonValue::Symbol(s) = val
                    {
                        markers.insert(resolve(*s));
                    }
                    walk(
                        val,
                        types,
                        classifications,
                        markers,
                        semantics_field,
                        resolve,
                    );
                }
            }
            IonValue::List(items) => {
                for item in items {
                    walk(
                        item,
                        types,
                        classifications,
                        markers,
                        semantics_field,
                        resolve,
                    );
                }
            }
            IonValue::Annotated(_, inner) => walk(
                inner,
                types,
                classifications,
                markers,
                semantics_field,
                resolve,
            ),
            _ => {}
        }
    }

    for loc in entities {
        if loc.type_id != KfxSymbol::Storyline as u32 {
            continue;
        }
        let entity = &kfx[loc.offset..loc.offset + loc.length];
        let payload = skip_enty_header(entity);
        if let Ok(value) = IonParser::new(payload).parse() {
            walk(
                &value,
                &mut types,
                &mut classifications,
                &mut markers,
                &semantics_field,
                &resolve,
            );
        }
    }
    (types, classifications, markers)
}

/// A bordered table must keep its table/table_row element types in KFX.
/// The border container-wrapper hack previously degraded the whole structure
/// to nested `container` elements (Kindle Previewer keeps table types and
/// renders borders from styles).
#[test]
fn bordered_table_keeps_table_structure_in_kfx() {
    use boko::kfx::symbols::KfxSymbol;
    use common::{Doc, EpubBuilder, Nav};

    let epub = EpubBuilder::new("Bordered Table")
        .css("table{border:1px solid black;border-collapse:collapse} td,th{border:1px solid #333} tr{border-bottom:1px solid #999}")
        .doc(Doc::new(
            "text/ch1.xhtml",
            "Table",
            "<p>before</p><table><thead><tr><th>H</th></tr></thead>\
             <tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>",
        ))
        .nav(vec![Nav::new("Table", "text/ch1.xhtml")])
        .build();

    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);

    let (types, _, _) = scan_storylines(&kfx);
    assert!(
        types.contains(&(KfxSymbol::Table as u64)),
        "bordered table lost its table element type: {types:?}"
    );
    assert!(
        types.contains(&(KfxSymbol::TableRow as u64)),
        "bordered table lost its table_row element types: {types:?}"
    );

    // And the structure survives a full round-trip.
    let out = boko::Book::from_bytes(&kfx, Format::Kfx).expect("import kfx");
    let ids: Vec<_> = out.spine().iter().map(|e| e.id).collect();
    let mut saw_row = false;
    for id in ids {
        let ch = out.load_chapter(id).expect("load");
        for nid in ch.iter_dfs() {
            if ch.node(nid).map(|n| n.role) == Some(Role::TableRow) {
                saw_row = true;
            }
        }
    }
    assert!(saw_row, "table rows lost through KFX round-trip");
}

/// Collect the element `type` of every storyline struct that carries a
/// `yj.semantics.type` marker. Readers only consume `yj.semantics.*` keys on
/// $269 text elements — a marker on any other type is flagged as unexpected
/// data — so conformant output must pair every marker with `type: text`.
fn scan_marker_carrier_types(kfx: &[u8]) -> Vec<(u64, String)> {
    use boko::kfx::container::{
        extract_doc_symbols, parse_container_header, parse_container_info, parse_index_table,
        skip_enty_header,
    };
    use boko::kfx::ion::{IonParser, IonValue};
    use boko::kfx::symbols::{KFX_SYMBOL_TABLE, KfxSymbol};

    let header = parse_container_header(&kfx[..18]).expect("container header");
    let info = parse_container_info(
        &kfx[header.container_info_offset
            ..header.container_info_offset + header.container_info_length],
    )
    .expect("container info");
    let doc_symbols = match info.doc_symbols {
        Some((off, len)) if len > 0 => extract_doc_symbols(&kfx[off..off + len]),
        _ => Vec::new(),
    };
    let (index_offset, index_length) = info.index.expect("index table");
    let entities = parse_index_table(
        &kfx[index_offset..index_offset + index_length],
        header.header_len,
    );

    let base = KFX_SYMBOL_TABLE.len() as u64;
    let resolve = |id: u64| -> String {
        if id < base {
            KFX_SYMBOL_TABLE[id as usize].to_string()
        } else {
            doc_symbols
                .get((id - base) as usize)
                .cloned()
                .unwrap_or_default()
        }
    };
    let semantics_field: Vec<u64> = doc_symbols
        .iter()
        .enumerate()
        .filter(|(_, s)| s.as_str() == "yj.semantics.type")
        .map(|(i, _)| i as u64 + base)
        .collect();

    fn walk(
        v: &IonValue,
        carriers: &mut Vec<(u64, String)>,
        semantics_field: &[u64],
        resolve: &dyn Fn(u64) -> String,
    ) {
        match v {
            IonValue::Struct(fields) => {
                let elem_type = fields.iter().find_map(|(k, val)| match val {
                    IonValue::Symbol(s) if *k == KfxSymbol::Type as u64 => Some(*s),
                    _ => None,
                });
                for (k, val) in fields {
                    if semantics_field.contains(k)
                        && let IonValue::Symbol(s) = val
                    {
                        carriers.push((elem_type.unwrap_or(0), resolve(*s)));
                    }
                    walk(val, carriers, semantics_field, resolve);
                }
            }
            IonValue::List(items) => {
                for item in items {
                    walk(item, carriers, semantics_field, resolve);
                }
            }
            IonValue::Annotated(_, inner) => walk(inner, carriers, semantics_field, resolve),
            _ => {}
        }
    }

    let mut carriers = Vec::new();
    for loc in entities {
        if loc.type_id != KfxSymbol::Storyline as u32 {
            continue;
        }
        let entity = &kfx[loc.offset..loc.offset + loc.length];
        let payload = skip_enty_header(entity);
        if let Ok(value) = IonParser::new(payload).parse() {
            walk(&value, &mut carriers, &semantics_field, &resolve);
        }
    }
    carriers
}

/// Inline-content sidebars export as $269 text elements carrying a
/// `yj.semantics.type: sidebar` marker — never the $280 element type or $620
/// classification, which Amazon-produced books don't use — and the role
/// survives the round trip via the marker.
#[test]
fn inline_sidebar_keeps_marker_on_text_element() {
    use boko::kfx::symbols::KfxSymbol;
    use common::{Doc, EpubBuilder, Nav};

    let epub = EpubBuilder::new("Sidebar Book")
        .doc(Doc::new(
            "text/ch1.xhtml",
            "Aside",
            "<p>body text</p>\
             <aside epub:type=\"sidebar\">just an inline note</aside>",
        ))
        .nav(vec![Nav::new("Aside", "text/ch1.xhtml")])
        .build();

    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);

    let (types, classifications, markers) = scan_storylines(&kfx);
    assert!(
        !types.contains(&(KfxSymbol::Sidebar as u64)),
        "sidebar must not use the $280 element type: {types:?}"
    );
    assert!(
        !classifications.contains(&(KfxSymbol::YjSidenote as u64)),
        "sidebar must not use the $620 classification: {classifications:?}"
    );
    assert!(
        markers.contains("sidebar"),
        "inline sidebar must carry the yj.semantics.type marker: {markers:?}"
    );

    // The marker must ride a $269 text element, where readers consume it.
    let carriers = scan_marker_carrier_types(&kfx);
    assert!(
        carriers
            .iter()
            .filter(|(_, m)| m == "sidebar")
            .all(|(t, _)| *t == KfxSymbol::Text as u64),
        "sidebar marker must ride type: text elements only: {carriers:?}"
    );

    // Role survives the round trip via the marker.
    let out = boko::Book::from_bytes(&kfx, Format::Kfx).expect("import kfx");
    let ids: Vec<_> = out.spine().iter().map(|e| e.id).collect();
    let mut saw_sidebar = false;
    for id in ids {
        let ch = out.load_chapter(id).expect("load");
        for nid in ch.iter_dfs() {
            if ch.node(nid).map(|n| n.role) == Some(Role::Sidebar) {
                saw_sidebar = true;
            }
        }
    }
    assert!(saw_sidebar, "sidebar role lost through KFX round-trip");
}

/// Block-holding sidebars are promoted to $270 containers by the no-hybrid
/// content-model rule, and containers admit no semantic markers (readers
/// flag `yj.semantics.*` on $270 as unexpected data). The marker is dropped
/// with the promotion — matching Kindle Previewer, which renders block
/// asides as plain styled containers.
#[test]
fn block_sidebar_drops_marker_with_container_promotion() {
    use boko::kfx::symbols::KfxSymbol;
    use common::{Doc, EpubBuilder, Nav};

    let epub = EpubBuilder::new("Block Sidebar Book")
        .doc(Doc::new(
            "text/ch1.xhtml",
            "Aside",
            "<p>body text</p>\
             <aside epub:type=\"sidebar\"><p>note box</p><p>second para</p></aside>",
        ))
        .nav(vec![Nav::new("Aside", "text/ch1.xhtml")])
        .build();

    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);

    let (types, _, _) = scan_storylines(&kfx);
    assert!(
        !types.contains(&(KfxSymbol::Sidebar as u64)),
        "sidebar must not use the $280 element type: {types:?}"
    );

    // No marker may survive on the promoted $270 container — and since every
    // marker must ride $269, the invariant covers all roles (block quotes,
    // table cells) in this book too.
    let carriers = scan_marker_carrier_types(&kfx);
    assert!(
        carriers.iter().all(|(t, _)| *t == KfxSymbol::Text as u64),
        "yj.semantics.type markers must ride type: text elements only: {carriers:?}"
    );
}

/// Scan the book_navigation ($389) for an approximate page list ($237),
/// returning (label, eid, offset) triples.
fn scan_page_list(kfx: &[u8]) -> Vec<(String, i64, i64)> {
    use boko::kfx::container::{
        parse_container_header, parse_container_info, parse_index_table, skip_enty_header,
    };
    use boko::kfx::ion::{IonParser, IonValue};
    use boko::kfx::symbols::KfxSymbol;

    let header = parse_container_header(&kfx[..18]).expect("container header");
    let info = parse_container_info(
        &kfx[header.container_info_offset
            ..header.container_info_offset + header.container_info_length],
    )
    .expect("container info");
    let (index_offset, index_length) = info.index.expect("index table");
    let entities = parse_index_table(
        &kfx[index_offset..index_offset + index_length],
        header.header_len,
    );

    let mut pages = Vec::new();
    for loc in entities {
        if loc.type_id != KfxSymbol::BookNavigation as u32 {
            continue;
        }
        let payload = skip_enty_header(&kfx[loc.offset..loc.offset + loc.length]);
        let Ok(value) = IonParser::new(payload).parse() else {
            continue;
        };

        // Walk: find nav containers whose nav_type == PageList, collect entries.
        fn walk(v: &IonValue, pages: &mut Vec<(String, i64, i64)>, in_page_list: bool) {
            match v {
                IonValue::Struct(fields) => {
                    let is_page_list = fields.iter().any(|(k, val)| {
                        *k == KfxSymbol::NavType as u64
                            && matches!(val, IonValue::Symbol(s) if *s == KfxSymbol::PageList as u64)
                    });
                    if in_page_list || is_page_list {
                        // page entry: {representation: {label}, target_position: {id, offset}}
                        let mut label = None;
                        let mut eid = None;
                        let mut off = 0;
                        for (k, val) in fields {
                            if *k == KfxSymbol::Representation as u64
                                && let IonValue::Struct(r) = val
                            {
                                for (rk, rv) in r {
                                    if *rk == KfxSymbol::Label as u64
                                        && let IonValue::String(s) = rv
                                    {
                                        label = Some(s.clone());
                                    }
                                }
                            }
                            if *k == KfxSymbol::TargetPosition as u64
                                && let IonValue::Struct(t) = val
                            {
                                for (tk, tv) in t {
                                    if let IonValue::Int(n) = tv {
                                        if *tk == KfxSymbol::Id as u64 {
                                            eid = Some(*n);
                                        } else if *tk == KfxSymbol::Offset as u64 {
                                            off = *n;
                                        }
                                    }
                                }
                            }
                        }
                        if let (Some(l), Some(e)) = (label, eid) {
                            pages.push((l, e, off));
                        }
                    }
                    for (_, val) in fields {
                        walk(val, pages, in_page_list || is_page_list);
                    }
                }
                IonValue::List(items) => {
                    for item in items {
                        walk(item, pages, in_page_list);
                    }
                }
                IonValue::Annotated(_, inner) => walk(inner, pages, in_page_list),
                _ => {}
            }
        }
        walk(&value, &mut pages, false);
    }
    pages
}

/// Books get an approximate page list (~1850 positions per page) so devices
/// show virtual page numbers, like Kindle Previewer output.
#[test]
fn kfx_carries_approximate_page_list() {
    use common::{Doc, EpubBuilder, Nav};

    // ~6000 characters of text -> expect ceil(total/1850) >= 3 pages.
    let para = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod. ".repeat(12);
    let body: String = (0..7)
        .map(|i| format!("<p>chunk {i}: {para}</p>"))
        .collect();
    let epub = EpubBuilder::new("Paged Book")
        .doc(Doc::new("text/ch1.xhtml", "One", &body))
        .nav(vec![Nav::new("One", "text/ch1.xhtml")])
        .build();

    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);

    let pages = scan_page_list(&kfx);
    assert!(
        pages.len() >= 3,
        "expected an approximate page list, got {} pages",
        pages.len()
    );
    // Labels are sequential 1..N.
    for (i, (label, _, _)) in pages.iter().enumerate() {
        assert_eq!(label, &(i + 1).to_string(), "page labels must be 1..N");
    }
    // First page targets the start of content.
    assert_eq!(pages[0].2, 0, "first page starts at offset 0");
    // Offsets are non-negative and eids are positive.
    assert!(pages.iter().all(|(_, e, o)| *e > 0 && *o >= 0));
}

/// The default style (s0) is only emitted when something references it —
/// plain books without container wrappers or unstyled spans previously
/// shipped an unreachable s0 fragment.
#[test]
fn unused_default_style_is_not_emitted() {
    use boko::kfx::container::{
        parse_container_header, parse_container_info, parse_index_table, skip_enty_header,
    };
    use boko::kfx::ion::IonParser;
    use boko::kfx::symbols::KfxSymbol;
    use common::{Doc, EpubBuilder, Nav};

    let epub = EpubBuilder::new("Plain Book")
        .doc(Doc::new(
            "text/ch1.xhtml",
            "One",
            "<h1>Title</h1><p>Just plain paragraphs.</p><p>Nothing bordered.</p>",
        ))
        .nav(vec![Nav::new("One", "text/ch1.xhtml")])
        .build();

    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);

    let header = parse_container_header(&kfx[..18]).unwrap();
    let info = parse_container_info(
        &kfx[header.container_info_offset
            ..header.container_info_offset + header.container_info_length],
    )
    .unwrap();
    let doc_symbols = match info.doc_symbols {
        Some((off, len)) if len > 0 => {
            boko::kfx::container::extract_doc_symbols(&kfx[off..off + len])
        }
        _ => Vec::new(),
    };
    let base = boko::kfx::symbols::KFX_SYMBOL_TABLE.len() as u32;
    let (io_, il) = info.index.unwrap();
    let mut style_names = Vec::new();
    for loc in parse_index_table(&kfx[io_..io_ + il], header.header_len) {
        if loc.type_id != KfxSymbol::Style as u32 {
            continue;
        }
        // Suppress the unused-variable path: keep payload parse to ensure entity is valid.
        let payload = skip_enty_header(&kfx[loc.offset..loc.offset + loc.length]);
        IonParser::new(payload).parse().expect("style ion parses");
        let name = if loc.id >= base {
            doc_symbols
                .get((loc.id - base) as usize)
                .cloned()
                .unwrap_or_default()
        } else {
            format!("${}", loc.id)
        };
        style_names.push(name);
    }
    assert!(
        !style_names.iter().any(|s| s == "s0"),
        "unreferenced default style s0 must not be emitted: {style_names:?}"
    );
}

/// Every anchor symbol referenced from a style event ($179 link_to) must have
/// a matching $266 anchor fragment — a link to a missing target must not
/// leave a dangling reference (fallback anchor to the book start instead).
#[test]
fn broken_internal_links_do_not_dangle() {
    use boko::kfx::container::{
        extract_doc_symbols, parse_container_header, parse_container_info, parse_index_table,
        skip_enty_header,
    };
    use boko::kfx::ion::{IonParser, IonValue};
    use boko::kfx::symbols::{KFX_SYMBOL_TABLE, KfxSymbol};
    use common::{Doc, EpubBuilder, Nav};

    let epub = EpubBuilder::new("Broken Link Book")
        .doc(Doc::new(
            "text/ch1.xhtml",
            "One",
            "<p>see <a href=\"#nonexistent-target\">the appendix</a> for more</p>",
        ))
        .nav(vec![Nav::new("One", "text/ch1.xhtml")])
        .build();

    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);

    let header = parse_container_header(&kfx[..18]).unwrap();
    let info = parse_container_info(
        &kfx[header.container_info_offset
            ..header.container_info_offset + header.container_info_length],
    )
    .unwrap();
    let doc_symbols = match info.doc_symbols {
        Some((off, len)) if len > 0 => extract_doc_symbols(&kfx[off..off + len]),
        _ => Vec::new(),
    };
    let base = KFX_SYMBOL_TABLE.len() as u64;
    let (io_, il) = info.index.unwrap();

    let mut referenced: std::collections::BTreeSet<u64> = Default::default();
    let mut anchor_fids: std::collections::BTreeSet<String> = Default::default();

    fn walk(v: &IonValue, referenced: &mut std::collections::BTreeSet<u64>) {
        match v {
            IonValue::Struct(fields) => {
                for (k, val) in fields {
                    if *k == KfxSymbol::LinkTo as u64
                        && let IonValue::Symbol(s) = val
                    {
                        referenced.insert(*s);
                    }
                    walk(val, referenced);
                }
            }
            IonValue::List(items) => items.iter().for_each(|i| walk(i, referenced)),
            IonValue::Annotated(_, inner) => walk(inner, referenced),
            _ => {}
        }
    }

    for loc in parse_index_table(&kfx[io_..io_ + il], header.header_len) {
        let payload = skip_enty_header(&kfx[loc.offset..loc.offset + loc.length]);
        if loc.type_id == KfxSymbol::Storyline as u32 {
            if let Ok(v) = IonParser::new(payload).parse() {
                walk(&v, &mut referenced);
            }
        } else if loc.type_id == KfxSymbol::Anchor as u32
            && loc.id as u64 >= base
            && let Some(name) = doc_symbols.get((loc.id as u64 - base) as usize)
        {
            anchor_fids.insert(name.clone());
        }
    }

    assert!(
        !referenced.is_empty(),
        "the link should produce a link_to reference"
    );
    for sym in &referenced {
        let name = doc_symbols
            .get((*sym - base) as usize)
            .cloned()
            .unwrap_or_default();
        assert!(
            anchor_fids.contains(&name),
            "link_to references anchor {name:?} but no $266 fragment exists (have: {anchor_fids:?})"
        );
    }
}

/// Styles and anchors are emitted only when referenced: an element with an id
/// that nothing links to must not produce a $266 fragment, and every emitted
/// $157 style must be referenced from a storyline.
#[test]
fn no_unreferenced_styles_or_anchors() {
    use boko::kfx::container::{
        extract_doc_symbols, parse_container_header, parse_container_info, parse_index_table,
        skip_enty_header,
    };
    use boko::kfx::ion::{IonParser, IonValue};
    use boko::kfx::symbols::{KFX_SYMBOL_TABLE, KfxSymbol};
    use common::{Doc, EpubBuilder, Nav};

    let epub = EpubBuilder::new("Orphan Book")
        .doc(Doc::new(
            "text/ch1.xhtml",
            "One",
            // The span has a style but collapses to nothing linkable; the id'd
            // paragraph is a potential anchor target that nothing references.
            "<p id=\"lonely\">unlinked target</p><p><span class=\"x\"></span>after empty span</p>",
        ))
        .nav(vec![Nav::new("One", "text/ch1.xhtml")])
        .build();

    let mut src = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    let kfx = common::export_to_bytes(&mut src, Format::Kfx);

    let header = parse_container_header(&kfx[..18]).unwrap();
    let info = parse_container_info(
        &kfx[header.container_info_offset
            ..header.container_info_offset + header.container_info_length],
    )
    .unwrap();
    let doc_symbols = match info.doc_symbols {
        Some((off, len)) if len > 0 => extract_doc_symbols(&kfx[off..off + len]),
        _ => Vec::new(),
    };
    let base = KFX_SYMBOL_TABLE.len() as u64;
    let (io_, il) = info.index.unwrap();

    let mut referenced_styles: std::collections::BTreeSet<u64> = Default::default();
    let mut emitted_styles: Vec<String> = Vec::new();
    let mut anchor_count = 0usize;

    fn walk(v: &IonValue, styles: &mut std::collections::BTreeSet<u64>) {
        match v {
            IonValue::Struct(fields) => {
                for (k, val) in fields {
                    if *k == KfxSymbol::Style as u64
                        && let IonValue::Symbol(s) = val
                    {
                        styles.insert(*s);
                    }
                    walk(val, styles);
                }
            }
            IonValue::List(items) => items.iter().for_each(|i| walk(i, styles)),
            IonValue::Annotated(_, inner) => walk(inner, styles),
            _ => {}
        }
    }

    for loc in parse_index_table(&kfx[io_..io_ + il], header.header_len) {
        let payload = skip_enty_header(&kfx[loc.offset..loc.offset + loc.length]);
        if loc.type_id == KfxSymbol::Storyline as u32 || loc.type_id == KfxSymbol::Section as u32 {
            if let Ok(v) = IonParser::new(payload).parse() {
                walk(&v, &mut referenced_styles);
            }
        } else if loc.type_id == KfxSymbol::Style as u32 {
            let name = if loc.id as u64 >= base {
                doc_symbols
                    .get((loc.id as u64 - base) as usize)
                    .cloned()
                    .unwrap_or_default()
            } else {
                String::new()
            };
            emitted_styles.push(name);
        } else if loc.type_id == KfxSymbol::Anchor as u32 {
            anchor_count += 1;
        }
    }

    assert_eq!(
        anchor_count, 0,
        "no links exist, so no $266 anchors should be emitted"
    );
    // Every emitted style must be referenced (resolve names back to symbols).
    let referenced_names: std::collections::BTreeSet<String> = referenced_styles
        .iter()
        .filter_map(|s| {
            if *s >= base {
                doc_symbols.get((*s - base) as usize).cloned()
            } else {
                None
            }
        })
        .collect();
    for name in &emitted_styles {
        assert!(
            referenced_names.contains(name),
            "style {name:?} emitted but never referenced (referenced: {referenced_names:?})"
        );
    }
}
