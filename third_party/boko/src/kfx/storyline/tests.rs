#![allow(clippy::field_reassign_with_default)]

use super::export::*;
use super::import::*;
use super::ion_synth::*;
use super::*;
use crate::model::{GlobalNodeId, Role};

#[test]
fn test_tokenize_creates_proper_structure() {
    // Test that tokenization produces expected token sequence
    let mut stream = TokenStream::new();
    stream.start_element(Role::Paragraph);
    stream.text("Hello");
    stream.end_element();

    let chapter = build_ir_from_tokens(&stream, &[], None, |_, _| None);
    assert_eq!(chapter.node_count(), 3); // root + para + text
}

#[test]
fn test_build_ir_with_image() {
    let mut stream = TokenStream::new();
    let mut semantics = HashMap::new();
    semantics.insert(SemanticTarget::Src, "cover.jpg".to_string());

    stream.push(KfxToken::StartElement(ElementStart {
        role: Role::Image,
        node_id: None,
        id: Some(123),
        semantics,
        content_ref: None,
        style_events: Vec::new(),
        kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
        style_symbol: None,
        style_name: None,
        needs_container_wrapper: false,
        is_header_cell: false,
        table_format: None,
        is_table_caption: false,
    }));
    stream.end_element();

    let chapter = build_ir_from_tokens(&stream, &[], None, |_, _| None);

    let children: Vec<_> = chapter.children(chapter.root()).collect();
    assert_eq!(children.len(), 1);

    let image_node = chapter.node(children[0]).unwrap();
    assert_eq!(image_node.role, Role::Image);
    assert_eq!(chapter.semantics.src(children[0]), Some("cover.jpg"));
}

#[test]
fn test_build_ir_with_text_content() {
    let mut stream = TokenStream::new();
    stream.push(KfxToken::StartElement(ElementStart {
        role: Role::Paragraph,
        node_id: None,
        id: None,
        semantics: HashMap::new(),
        content_ref: Some(ContentRef {
            name: "content_1".to_string(),
            index: 0,
        }),
        style_events: Vec::new(),
        kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
        style_symbol: None,
        style_name: None,
        needs_container_wrapper: false,
        is_header_cell: false,
        table_format: None,
        is_table_caption: false,
    }));
    stream.end_element();

    let chapter = build_ir_from_tokens(&stream, &[], None, |name, idx| {
        if name == "content_1" && idx == 0 {
            Some("Hello, world!".to_string())
        } else {
            None
        }
    });

    assert_eq!(chapter.node_count(), 3); // root + para + text
    let para_id = chapter.children(chapter.root()).next().unwrap();
    let text_id = chapter.children(para_id).next().unwrap();
    let text_node = chapter.node(text_id).unwrap();
    assert_eq!(chapter.text(text_node.text), "Hello, world!");
}

#[test]
fn test_build_ir_with_heading() {
    let mut stream = TokenStream::new();
    stream.push(KfxToken::StartElement(ElementStart {
        role: Role::Heading(2),
        node_id: None,
        id: None,
        semantics: HashMap::new(),
        content_ref: Some(ContentRef {
            name: "content_1".to_string(),
            index: 0,
        }),
        style_events: Vec::new(),
        kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
        style_symbol: None,
        style_name: None,
        needs_container_wrapper: false,
        is_header_cell: false,
        table_format: None,
        is_table_caption: false,
    }));
    stream.end_element();

    let chapter = build_ir_from_tokens(&stream, &[], None, |_, _| Some("Chapter 1".to_string()));

    let heading_id = chapter.children(chapter.root()).next().unwrap();
    let heading = chapter.node(heading_id).unwrap();
    assert_eq!(heading.role, Role::Heading(2));
}

#[test]
fn test_build_ir_with_link_span() {
    let mut stream = TokenStream::new();
    let mut span_semantics = HashMap::new();
    span_semantics.insert(SemanticTarget::Href, "chapter2".to_string());

    stream.push(KfxToken::StartElement(ElementStart {
        role: Role::Paragraph,
        node_id: None,
        id: None,
        semantics: HashMap::new(),
        content_ref: Some(ContentRef {
            name: "content_1".to_string(),
            index: 0,
        }),
        style_events: vec![SpanStart {
            role: Role::Link,
            node_id: None,
            semantics: span_semantics,
            offset: 7,
            length: 5,
            style_symbol: None,
            kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
        }],
        kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
        style_symbol: None,
        style_name: None,
        needs_container_wrapper: false,
        is_header_cell: false,
        table_format: None,
        is_table_caption: false,
    }));
    stream.end_element();

    // Text is "Hello, world!" - span at offset 7, length 5 = "world"
    let chapter =
        build_ir_from_tokens(&stream, &[], None, |_, _| Some("Hello, world!".to_string()));

    // Should have: root -> para -> [text("Hello, "), link("world"), text("!")]
    let para_id = chapter.children(chapter.root()).next().unwrap();
    let children: Vec<_> = chapter.children(para_id).collect();
    assert_eq!(children.len(), 3);

    // First: plain text "Hello, "
    let first = chapter.node(children[0]).unwrap();
    assert_eq!(first.role, Role::Text);
    assert_eq!(chapter.text(first.text), "Hello, ");

    // Second: link containing "world"
    let link = chapter.node(children[1]).unwrap();
    assert_eq!(link.role, Role::Link);
    assert_eq!(chapter.semantics.href(children[1]), Some("chapter2"));

    // Third: plain text "!"
    let last = chapter.node(children[2]).unwrap();
    assert_eq!(last.role, Role::Text);
    assert_eq!(chapter.text(last.text), "!");
}

#[test]
fn test_char_to_byte_offset() {
    let text = "Hello ὑπόληψις world";

    // ASCII chars: byte offset = char offset
    assert_eq!(char_to_byte_offset(text, 0), 0); // 'H'
    assert_eq!(char_to_byte_offset(text, 5), 5); // ' '

    // Greek chars start at char 6, byte 6
    // Each Greek char is 3 bytes (extended Greek), so:
    // char 6 = byte 6 (ὑ)
    // char 7 = byte 9 (π)
    // char 13 = byte 21 (ς)
    // char 14 = byte 23 (' ')
    assert_eq!(char_to_byte_offset(text, 6), 6); // 'ὑ'
    assert_eq!(char_to_byte_offset(text, 7), 9); // 'π'
    assert_eq!(char_to_byte_offset(text, 14), 23); // ' ' after Greek

    // Past end returns text.len()
    assert_eq!(char_to_byte_offset(text, 100), text.len());
}

#[test]
fn test_apply_semantics_generic() {
    let mut chapter = Chapter::new();
    let node = Node::new(Role::Image);
    let node_id = chapter.alloc_node(node);

    let mut semantics = HashMap::new();
    semantics.insert(SemanticTarget::Src, "image.jpg".to_string());
    semantics.insert(SemanticTarget::Alt, "An image".to_string());

    apply_semantics_to_node(&mut chapter, node_id, &semantics);

    assert_eq!(chapter.semantics.src(node_id), Some("image.jpg"));
    assert_eq!(chapter.semantics.alt(node_id), Some("An image"));
}

// ========================================================================
// Export tests
// ========================================================================

#[test]
fn test_ir_to_tokens_basic() {
    let mut chapter = Chapter::new();

    // Create a text node with content
    let text_range = chapter.append_text("Hello");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);
    chapter.append_child(chapter.root(), text_id);

    let mut ctx = ExportContext::new();
    let tokens = ir_to_tokens(&chapter, &mut ctx);

    // Should have tokens for the text node
    assert!(!tokens.is_empty());
}

#[test]
fn test_build_storyline_ion() {
    let mut chapter = Chapter::new();

    // Create a paragraph with a text child
    let para = Node::new(Role::Paragraph);
    let para_id = chapter.alloc_node(para);
    chapter.append_child(chapter.root(), para_id);

    let text_range = chapter.append_text("Test content");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);
    chapter.append_child(para_id, text_id);

    let mut ctx = ExportContext::new();
    let ion = build_storyline_ion(&chapter, &mut ctx);

    // Should produce some Ion structure
    assert!(!matches!(ion, IonValue::Null));
}

#[test]
fn test_tokens_to_ion_empty() {
    let tokens = TokenStream::new();
    let mut ctx = ExportContext::new();
    let ion = tokens_to_ion(&tokens, &mut ctx);

    // Empty tokens should produce an empty list or null
    assert!(
        matches!(ion, IonValue::List(_)) || matches!(ion, IonValue::Null),
        "expected List or Null, got {:?}",
        ion
    );
}

#[test]
fn test_heading_level_export() {
    use crate::kfx::symbols::KfxSymbol;

    let mut chapter = Chapter::new();

    // Create an H2 heading
    let h2 = Node::new(Role::Heading(2));
    let h2_id = chapter.alloc_node(h2);
    chapter.append_child(chapter.root(), h2_id);

    // Add text content
    let text_range = chapter.append_text("Chapter Title");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);
    chapter.append_child(h2_id, text_id);

    let mut ctx = ExportContext::new();
    let ion = build_storyline_ion(&chapter, &mut ctx);

    // Find the heading container in the output and verify yj.semantics.heading_level = 2
    fn find_heading_level(ion: &IonValue) -> Option<i64> {
        match ion {
            IonValue::Struct(fields) => {
                for (field_id, value) in fields {
                    if *field_id == KfxSymbol::YjSemanticsHeadingLevel as u64
                        && let IonValue::Int(level) = value
                    {
                        return Some(*level);
                    }
                }
                // Check content_list (children in KFX)
                for (field_id, value) in fields {
                    if *field_id == KfxSymbol::ContentList as u64
                        && let Some(level) = find_heading_level(value)
                    {
                        return Some(level);
                    }
                }
            }
            IonValue::List(items) => {
                for item in items {
                    if let Some(level) = find_heading_level(item) {
                        return Some(level);
                    }
                }
            }
            _ => {}
        }
        None
    }

    let heading_level = find_heading_level(&ion);
    assert_eq!(
        heading_level,
        Some(2),
        "Expected yj.semantics.heading_level = 2, got {:?}",
        heading_level
    );
}

#[test]
fn test_style_event_offsets_use_char_count() {
    // KFX style events use character offsets, not byte offsets.
    // Greek characters are multi-byte in UTF-8, so this verifies
    // we count characters, not bytes.
    let mut builder = IonBuilder::new();

    // "Hello " = 6 chars, 6 bytes
    builder.append_text("Hello ");
    assert_eq!(builder.text_len(), 6);

    // "ὑπόληψις" = 8 chars, 17 bytes in UTF-8
    let greek_offset = builder.append_text("ὑπόληψις");
    assert_eq!(greek_offset, 6, "Greek text should start at char offset 6");
    assert_eq!(builder.text_len(), 14, "Total should be 14 chars (6 + 8)");

    // Verify byte length differs from char count
    assert_eq!(builder.accumulated_text.len(), 23); // 6 + 17 bytes
    assert_eq!(builder.accumulated_char_count, 14); // 6 + 8 chars
}

#[test]
fn test_layout_hints_for_heading() {
    // Headings should emit layout_hints: [treat_as_title]
    let mut chapter = Chapter::new();
    let text_range = chapter.append_text("Chapter 1");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);

    let heading = Node::new(Role::Heading(1));
    let heading_id = chapter.alloc_node(heading);
    chapter.append_child(heading_id, text_id);
    chapter.append_child(chapter.root(), heading_id);

    let mut ctx = crate::kfx::context::ExportContext::new();
    ctx.register_section("test_section");
    let ion = build_storyline_ion(&chapter, &mut ctx);

    // Find layout_hints in the generated Ion
    fn find_layout_hints(ion: &IonValue) -> Option<Vec<u64>> {
        match ion {
            IonValue::Struct(fields) => {
                for (key, value) in fields {
                    if *key == sym!(LayoutHints)
                        && let IonValue::List(items) = value
                    {
                        return Some(
                            items
                                .iter()
                                .filter_map(|v| {
                                    if let IonValue::Symbol(s) = v {
                                        Some(*s)
                                    } else {
                                        None
                                    }
                                })
                                .collect(),
                        );
                    }
                    if let Some(hints) = find_layout_hints(value) {
                        return Some(hints);
                    }
                }
                None
            }
            IonValue::List(items) => {
                for item in items {
                    if let Some(hints) = find_layout_hints(item) {
                        return Some(hints);
                    }
                }
                None
            }
            _ => None,
        }
    }

    // Reference KFX carries layout hints in the element's *style*, not on
    // the content node.
    assert!(
        find_layout_hints(&ion).is_none(),
        "layout_hints must not ride content nodes"
    );
    let hinted = ctx.style_registry.styles().any(|(_, style)| {
        matches!(
            style.get(KfxSymbol::LayoutHints),
            Some(crate::kfx::style_schema::KfxValue::SymbolList(hints))
                if hints.contains(&(KfxSymbol::TreatAsTitle as u64))
        )
    });
    assert!(hinted, "a registered style must carry treat_as_title");
}

#[test]
fn test_layout_hints_for_figure() {
    // Figure elements should emit layout_hints: [figure]
    let mut chapter = Chapter::new();

    let figure = Node::new(Role::Figure);
    let figure_id = chapter.alloc_node(figure);
    chapter.append_child(chapter.root(), figure_id);

    let mut ctx = crate::kfx::context::ExportContext::new();
    ctx.register_section("test_section");
    let ion = build_storyline_ion(&chapter, &mut ctx);

    // Find layout_hints in the generated Ion
    fn find_layout_hints(ion: &IonValue) -> Option<Vec<u64>> {
        match ion {
            IonValue::Struct(fields) => {
                for (key, value) in fields {
                    if *key == sym!(LayoutHints)
                        && let IonValue::List(items) = value
                    {
                        return Some(
                            items
                                .iter()
                                .filter_map(|v| {
                                    if let IonValue::Symbol(s) = v {
                                        Some(*s)
                                    } else {
                                        None
                                    }
                                })
                                .collect(),
                        );
                    }
                    if let Some(hints) = find_layout_hints(value) {
                        return Some(hints);
                    }
                }
                None
            }
            IonValue::List(items) => {
                for item in items {
                    if let Some(hints) = find_layout_hints(item) {
                        return Some(hints);
                    }
                }
                None
            }
            _ => None,
        }
    }

    // Reference KFX carries layout hints in the element's *style*, not on
    // the content node.
    assert!(
        find_layout_hints(&ion).is_none(),
        "layout_hints must not ride content nodes"
    );
    let hinted = ctx.style_registry.styles().any(|(_, style)| {
        matches!(
            style.get(KfxSymbol::LayoutHints),
            Some(crate::kfx::style_schema::KfxValue::SymbolList(hints))
                if hints.contains(&(KfxSymbol::Figure as u64))
        )
    });
    assert!(hinted, "a registered style must carry the figure hint");
}

#[test]
fn test_yj_classification_for_footnote_popup() {
    // Elements with epub:type="endnote" or "footnote" should emit
    // yj.classification: yj.endnote ($615: $619) for popup support
    let mut chapter = Chapter::new();

    // Create a list item that represents an endnote
    let text_range = chapter.append_text("This is footnote content");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);

    let endnote = Node::new(Role::ListItem);
    let endnote_id = chapter.alloc_node(endnote);
    chapter.append_child(endnote_id, text_id);
    chapter.append_child(chapter.root(), endnote_id);

    // Set epub:type to indicate this is an endnote
    chapter
        .semantics
        .set_epub_type(endnote_id, "endnote footnote");
    chapter.semantics.set_id(endnote_id, "note-1");

    let mut ctx = crate::kfx::context::ExportContext::new();
    ctx.register_section("test_section");
    let ion = build_storyline_ion(&chapter, &mut ctx);

    // Find yj.classification in the generated Ion and check its value
    fn find_classification(ion: &IonValue) -> Option<u64> {
        match ion {
            IonValue::Struct(fields) => {
                for (key, value) in fields {
                    if *key == sym!(YjClassification)
                        && let IonValue::Symbol(sym) = value
                    {
                        return Some(*sym);
                    }
                    if let Some(found) = find_classification(value) {
                        return Some(found);
                    }
                }
                None
            }
            IonValue::List(items) => {
                for item in items {
                    if let Some(found) = find_classification(item) {
                        return Some(found);
                    }
                }
                None
            }
            _ => None,
        }
    }

    let classification = find_classification(&ion);
    assert!(
        classification.is_some(),
        "Endnote element should have yj.classification attribute"
    );
    assert_eq!(
        classification.unwrap(),
        KfxSymbol::YjEndnote as u64,
        "yj.classification should be yj.endnote ($619) for endnote elements"
    );
}

#[test]
fn test_heading_with_border_exports_as_container() {
    // Test that elements with borders are wrapped in type: container
    // with nested type: text for KFX border rendering
    use crate::style::{BorderStyle, ComputedStyle, Length};

    let mut chapter = Chapter::new();

    // Create a heading with border style
    let mut style = ComputedStyle::default();
    style.border_style_top = BorderStyle::Solid;
    style.border_width_top = Length::Px(2.0);
    let style_id = chapter.styles.intern(style);

    let mut h1 = Node::new(Role::Heading(1));
    h1.style = style_id;
    let h1_id = chapter.alloc_node(h1);
    chapter.append_child(chapter.root(), h1_id);

    // Add text content
    let text_range = chapter.append_text("Title with Border");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);
    chapter.append_child(h1_id, text_id);

    let mut ctx = crate::kfx::context::ExportContext::new();
    let ion = build_storyline_ion(&chapter, &mut ctx);

    // Helper to find element type and nested content_list structure
    fn find_container_structure(ion: &IonValue) -> Option<(u64, Option<u64>)> {
        match ion {
            IonValue::Struct(fields) => {
                let mut elem_type = None;
                let mut inner_type = None;

                for (key, value) in fields {
                    if *key == KfxSymbol::Type as u64
                        && let IonValue::Symbol(sym) = value
                    {
                        elem_type = Some(*sym);
                    }
                    if *key == KfxSymbol::ContentList as u64
                        && let IonValue::List(items) = value
                    {
                        for item in items {
                            if let Some((inner_elem_type, _)) = find_container_structure(item) {
                                inner_type = Some(inner_elem_type);
                                break;
                            }
                        }
                    }
                }

                if let Some(t) = elem_type {
                    return Some((t, inner_type));
                }
                None
            }
            IonValue::List(items) => {
                for item in items {
                    if let Some(result) = find_container_structure(item) {
                        return Some(result);
                    }
                }
                None
            }
            _ => None,
        }
    }

    let structure = find_container_structure(&ion);
    assert!(structure.is_some(), "Should find element structure");
    let (outer_type, inner_type) = structure.unwrap();

    // Outer element should be type: container
    assert_eq!(
        outer_type,
        KfxSymbol::Container as u64,
        "Heading with border should have type: container (not text)"
    );

    // Should have nested type: text child
    assert!(
        inner_type.is_some(),
        "Container should have nested content_list with inner element"
    );
    assert_eq!(
        inner_type.unwrap(),
        KfxSymbol::Text as u64,
        "Inner element should have type: text"
    );
}

#[test]
fn test_heading_without_border_exports_as_text() {
    // Test that elements without borders use normal type: text
    let mut chapter = Chapter::new();

    // Create a heading without border style
    let h1 = Node::new(Role::Heading(1));
    let h1_id = chapter.alloc_node(h1);
    chapter.append_child(chapter.root(), h1_id);

    // Add text content
    let text_range = chapter.append_text("Title without Border");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);
    chapter.append_child(h1_id, text_id);

    let mut ctx = crate::kfx::context::ExportContext::new();
    let ion = build_storyline_ion(&chapter, &mut ctx);

    // Helper to find first element type
    fn find_first_element_type(ion: &IonValue) -> Option<u64> {
        match ion {
            IonValue::Struct(fields) => {
                for (key, value) in fields {
                    if *key == KfxSymbol::Type as u64
                        && let IonValue::Symbol(sym) = value
                    {
                        return Some(*sym);
                    }
                }
                None
            }
            IonValue::List(items) => {
                for item in items {
                    if let Some(result) = find_first_element_type(item) {
                        return Some(result);
                    }
                }
                None
            }
            _ => None,
        }
    }

    let elem_type = find_first_element_type(&ion);
    assert!(elem_type.is_some(), "Should find element type");

    // Element without border should be type: text (normal heading)
    assert_eq!(
        elem_type.unwrap(),
        KfxSymbol::Text as u64,
        "Heading without border should have type: text"
    );
}

#[test]
fn test_needs_container_wrapper_no_border() {
    let style = ComputedStyle::default();
    assert!(!needs_container_wrapper(&style));
}

#[test]
fn test_needs_container_wrapper_with_top_border() {
    let mut style = ComputedStyle::default();
    style.border_style_top = BorderStyle::Solid;
    style.border_width_top = Length::Px(1.0);
    assert!(needs_container_wrapper(&style));
}

#[test]
fn test_needs_container_wrapper_with_bottom_border() {
    let mut style = ComputedStyle::default();
    style.border_style_bottom = BorderStyle::Solid;
    style.border_width_bottom = Length::Px(2.0);
    assert!(needs_container_wrapper(&style));
}

#[test]
fn test_needs_container_wrapper_border_style_none() {
    let mut style = ComputedStyle::default();
    // Has width but no style - should NOT need wrapper
    style.border_style_top = BorderStyle::None;
    style.border_width_top = Length::Px(1.0);
    assert!(!needs_container_wrapper(&style));
}

#[test]
fn test_needs_container_wrapper_border_width_zero() {
    let mut style = ComputedStyle::default();
    // Has style but zero width - should NOT need wrapper
    style.border_style_top = BorderStyle::Solid;
    style.border_width_top = Length::Px(0.0);
    assert!(!needs_container_wrapper(&style));
}

#[test]
fn test_nested_spans_link_containing_inline() {
    // Test that nested spans (Link containing Inline) are properly reconstructed.
    // This is the TOC case: "1. Easy Concurrency..." where "1." is in an Inline inside a Link.
    let mut stream = TokenStream::new();
    let mut link_semantics = HashMap::new();
    link_semantics.insert(SemanticTarget::Href, "#chapter1".to_string());

    // Text: "1. Easy Concurrency"
    // Link: offset 0, length 19 (entire text)
    // Inline: offset 0, length 2 ("1.")
    stream.push(KfxToken::StartElement(ElementStart {
        role: Role::Paragraph,
        node_id: None,
        id: None,
        semantics: HashMap::new(),
        content_ref: Some(ContentRef {
            name: "content_1".to_string(),
            index: 0,
        }),
        style_events: vec![
            SpanStart {
                role: Role::Link,
                node_id: None,
                semantics: link_semantics,
                offset: 0,
                length: 19,
                style_symbol: None,
                kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
            },
            SpanStart {
                role: Role::Inline,
                node_id: None,
                semantics: HashMap::new(),
                offset: 0,
                length: 2,
                style_symbol: None,
                kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
            },
        ],
        kfx_attrs: crate::kfx::tokens::KfxAttrs::new(),
        style_symbol: None,
        style_name: None,
        needs_container_wrapper: false,
        is_header_cell: false,
        table_format: None,
        is_table_caption: false,
    }));
    stream.end_element();

    let chapter = build_ir_from_tokens(&stream, &[], None, |_, _| {
        Some("1. Easy Concurrency".to_string())
    });

    // Expected structure:
    // Paragraph
    //   Link [href="#chapter1"]
    //     Inline
    //       Text: "1."
    //     Text: " Easy Concurrency"
    let para_id = chapter.children(chapter.root()).next().unwrap();
    let para_children: Vec<_> = chapter.children(para_id).collect();

    // Should have exactly one child: the Link
    assert_eq!(
        para_children.len(),
        1,
        "Paragraph should have one Link child"
    );

    let link_id = para_children[0];
    let link_node = chapter.node(link_id).unwrap();
    assert_eq!(link_node.role, Role::Link, "First child should be Link");
    assert_eq!(
        chapter.semantics.href(link_id),
        Some("#chapter1"),
        "Link should have href"
    );

    // Link should have two children: Inline and Text
    let link_children: Vec<_> = chapter.children(link_id).collect();
    assert_eq!(
        link_children.len(),
        2,
        "Link should have Inline + Text children"
    );

    // First child: Inline containing "1."
    let inline_id = link_children[0];
    let inline_node = chapter.node(inline_id).unwrap();
    assert_eq!(
        inline_node.role,
        Role::Inline,
        "First Link child should be Inline"
    );

    let inline_children: Vec<_> = chapter.children(inline_id).collect();
    assert_eq!(
        inline_children.len(),
        1,
        "Inline should have one Text child"
    );
    let inline_text = chapter.node(inline_children[0]).unwrap();
    assert_eq!(chapter.text(inline_text.text), "1.");

    // Second child: Text " Easy Concurrency"
    let text_id = link_children[1];
    let text_node = chapter.node(text_id).unwrap();
    assert_eq!(text_node.role, Role::Text);
    assert_eq!(chapter.text(text_node.text), " Easy Concurrency");
}

#[test]
fn test_flatten_inline_content_produces_non_overlapping_segments() {
    // Test the "Push Down, Emit at Bottom" flattening algorithm.
    // Given: Link > Inline > Text("1.") + Text("Easy...")
    // Expect: Two non-overlapping segments, each with correct accumulated state.

    let mut chapter = Chapter::new();

    // Create distinct styles (use different margin values to distinguish)
    let link_style = chapter.styles.intern(ComputedStyle::default());
    let mut inline_computed = ComputedStyle::default();
    inline_computed.margin_top = Length::Px(10.0);
    let inline_style = chapter.styles.intern(inline_computed);

    // Build tree: Link > Inline > Text("1.") + Text(" Easy")
    // Create text nodes
    let text1_range = chapter.append_text("1.");
    let mut text1 = Node::new(Role::Text);
    text1.text = text1_range;
    let text1_id = chapter.alloc_node(text1);

    let text2_range = chapter.append_text(" Easy Concurrency");
    let mut text2 = Node::new(Role::Text);
    text2.text = text2_range;
    let text2_id = chapter.alloc_node(text2);

    // Create Inline containing text1
    let mut inline_node = Node::new(Role::Inline);
    inline_node.style = inline_style;
    let inline_id = chapter.alloc_node(inline_node);
    chapter.append_child(inline_id, text1_id);

    // Create Link containing Inline and text2
    let mut link_node = Node::new(Role::Link);
    link_node.style = link_style;
    let link_id = chapter.alloc_node(link_node);
    chapter.append_child(link_id, inline_id);
    chapter.append_child(link_id, text2_id);
    chapter.semantics.set_href(link_id, "#chapter1");

    // Flatten the Link subtree
    let mut segments = Vec::new();
    flatten_inline_content(&chapter, link_id, InlineState::default(), &mut segments);

    // Should produce exactly 2 segments
    assert_eq!(segments.len(), 2, "Should have 2 non-overlapping segments");

    // First segment: "1." with Inline's style and Link's href
    assert_eq!(segments[0].text, "1.");
    assert_eq!(
        segments[0].state.link_to,
        Some("#chapter1".to_string()),
        "First segment should have link_to from Link"
    );
    assert_eq!(
        segments[0].state.style,
        Some(inline_style),
        "First segment should have Inline's style (innermost wins)"
    );

    // Second segment: " Easy Concurrency" with Link's style and Link's href
    assert_eq!(segments[1].text, " Easy Concurrency");
    assert_eq!(
        segments[1].state.link_to,
        Some("#chapter1".to_string()),
        "Second segment should have link_to from Link"
    );
    assert_eq!(
        segments[1].state.style,
        Some(link_style),
        "Second segment should have Link's style"
    );
}

#[test]
fn test_anchor_inside_container_wrapper_uses_outer_id() {
    // Test that anchors inside container-wrapped elements (like headings with borders)
    // use the outer container's ID, not the inner text element's ID.
    // This is critical for TOC navigation to work correctly.
    use crate::import::ChapterId;
    use crate::style::{BorderStyle, ComputedStyle, Length};

    let mut chapter = Chapter::new();

    // Create a heading with border style (triggers container wrapper)
    let mut style = ComputedStyle::default();
    style.border_style_bottom = BorderStyle::Solid;
    style.border_width_bottom = Length::Px(1.0);
    let style_id = chapter.styles.intern(style);

    let mut h2 = Node::new(Role::Heading(2));
    h2.style = style_id;
    let h2_id = chapter.alloc_node(h2);
    chapter.append_child(chapter.root(), h2_id);

    // Add text content
    let text_range = chapter.append_text("All the Tools You Need");
    let mut text_node = Node::new(Role::Text);
    text_node.text = text_range;
    let text_id = chapter.alloc_node(text_node);
    chapter.append_child(h2_id, text_id);

    // Add an inline span with an ID (like <span id="p6"/>)
    // This simulates how EPUB anchors are often placed
    let span_node = Node::new(Role::Inline);
    let span_id = chapter.alloc_node(span_node);
    chapter.append_child(h2_id, span_id);
    chapter.semantics.set_id(span_id, "p6");

    let mut ctx = crate::kfx::context::ExportContext::new();

    // Set up the context with a chapter ID
    let chapter_id = ChapterId(1);
    ctx.begin_chapter_export(chapter_id);

    // Register the span as a link target (simulating what resolve_links does)
    let target = GlobalNodeId::new(chapter_id, span_id);
    ctx.anchor_registry
        .register_internal_target(target, "chapter1.xhtml#p6");

    let _ion = build_storyline_ion(&chapter, &mut ctx);

    // Get the node position for p6
    let anchor_pos = ctx.anchor_registry.get_node_position(target);

    // The anchor position should exist and point to the outer container ID
    assert!(anchor_pos.is_some(), "Anchor for p6 should be created");

    let (fragment_id, _offset) = anchor_pos.unwrap();

    // Get the list of content IDs recorded for this chapter
    // Container wrapper creates 2 content IDs: outer container and inner text
    // The first one (outer container) should be used for the anchor
    let content_ids = ctx.content_ids_by_chapter.get(&chapter_id);
    assert!(
        content_ids.is_some(),
        "Should have recorded content IDs for chapter"
    );
    let content_ids = content_ids.unwrap();
    assert!(
        content_ids.len() >= 2,
        "Container wrapper should create at least 2 content IDs (outer + inner), got {}",
        content_ids.len()
    );

    // The anchor should point to the first content ID (the outer container)
    // not the second ID (the inner text element)
    assert_eq!(
        fragment_id, content_ids[0],
        "Anchor should point to outer container ID ({}) not inner element ({})",
        content_ids[0], content_ids[1]
    );
}

// ============================================================================
// Reference content model: split runs, block-children typing
// ============================================================================

mod content_model {
    use super::*;
    use crate::kfx::symbols::KfxSymbol;

    fn field(fields: &[(u64, IonValue)], id: KfxSymbol) -> Option<&IonValue> {
        fields.iter().find(|(k, _)| *k == id as u64).map(|(_, v)| v)
    }

    fn as_struct(v: &IonValue) -> &[(u64, IonValue)] {
        match v {
            IonValue::Struct(f) => f,
            other => panic!("expected struct, got {other:?}"),
        }
    }

    fn text_child(chapter: &mut Chapter, parent: NodeId, text: &str) {
        let range = chapter.append_text(text);
        let mut node = Node::new(Role::Text);
        node.text = range;
        let id = chapter.alloc_node(node);
        chapter.append_child(parent, id);
    }

    fn image_child(chapter: &mut Chapter, parent: NodeId, src: &str) -> NodeId {
        let id = chapter.alloc_node(Node::new(Role::Image));
        chapter.append_child(parent, id);
        chapter.semantics.set_src(id, src);
        id
    }

    fn export(chapter: &Chapter) -> (IonValue, ExportContext) {
        let mut ctx = ExportContext::new();
        let tokens = ir_to_tokens(chapter, &mut ctx);
        let ion = tokens_to_ion(&tokens, &mut ctx);
        (ion, ctx)
    }

    /// A paragraph with a mid-text inline image splits into sibling text
    /// elements (each with its own content ref) around the image; the parent
    /// keeps NO content ref (the reference model — Previewer never emits an
    /// element with both a content ref and children).
    #[test]
    fn inline_image_splits_text_into_sibling_runs() {
        let mut chapter = Chapter::new();
        let para = chapter.alloc_node(Node::new(Role::Paragraph));
        chapter.append_child(chapter.root(), para);
        text_child(&mut chapter, para, "before ");
        image_child(&mut chapter, para, "img.png");
        text_child(&mut chapter, para, " after");

        let (ion, mut ctx) = export(&chapter);
        let IonValue::List(elems) = ion else {
            panic!("expected list")
        };
        let para_ion = as_struct(&elems[0]);
        assert!(
            field(para_ion, KfxSymbol::Content).is_none(),
            "split parent must not carry a content ref"
        );
        let IonValue::List(kids) = field(para_ion, KfxSymbol::ContentList).expect("children")
        else {
            panic!("children must be a list")
        };
        assert_eq!(kids.len(), 3, "run, image, run: {kids:#?}");

        let run1 = as_struct(&kids[0]);
        assert!(
            field(run1, KfxSymbol::Content).is_some(),
            "run1 has own ref"
        );
        let img = as_struct(&kids[1]);
        assert!(field(img, KfxSymbol::ResourceName).is_some(), "image child");
        let run2 = as_struct(&kids[2]);
        assert!(
            field(run2, KfxSymbol::Content).is_some(),
            "run2 has own ref"
        );

        // The two runs' text landed in the content chunks in order.
        let chunks = ctx.take_content_chunks();
        let all: Vec<&String> = chunks.iter().flat_map(|(_, segs)| segs).collect();
        assert_eq!(all, ["before ", " after"]);
    }

    /// A styled span after an inline image gets run-relative event offsets.
    #[test]
    fn events_after_inline_image_are_run_relative() {
        let mut chapter = Chapter::new();
        let para = chapter.alloc_node(Node::new(Role::Paragraph));
        chapter.append_child(chapter.root(), para);
        text_child(&mut chapter, para, "before ");
        image_child(&mut chapter, para, "img.png");
        // <a href> span in the second run
        let link = chapter.alloc_node(Node::new(Role::Link));
        chapter.append_child(para, link);
        chapter.semantics.set_href(link, "http://x/");
        text_child(&mut chapter, link, "click");

        let (ion, _ctx) = export(&chapter);
        let IonValue::List(elems) = ion else { panic!() };
        let para_ion = as_struct(&elems[0]);
        let IonValue::List(kids) = field(para_ion, KfxSymbol::ContentList).expect("children")
        else {
            panic!()
        };
        assert_eq!(kids.len(), 3, "run, image, run: {kids:#?}");
        let run2 = as_struct(&kids[2]);
        let IonValue::List(events) =
            field(run2, KfxSymbol::StyleEvents).expect("run2 has the link event")
        else {
            panic!()
        };
        let ev = as_struct(&events[0]);
        assert!(
            matches!(field(ev, KfxSymbol::Offset), Some(IonValue::Int(0))),
            "offset is relative to the run, not the paragraph: {ev:?}"
        );
        assert!(matches!(
            field(ev, KfxSymbol::Length),
            Some(IonValue::Int(5))
        ));
    }

    /// A text-typed element containing a block child (a list) becomes a
    /// container: Previewer never emits text-typed parents with block
    /// children ($269 -> $276 does not occur in reference output).
    #[test]
    fn block_child_forces_container_type() {
        let mut chapter = Chapter::new();
        let quote = chapter.alloc_node(Node::new(Role::BlockQuote));
        chapter.append_child(chapter.root(), quote);
        text_child(&mut chapter, quote, "intro ");
        let list = chapter.alloc_node(Node::new(Role::UnorderedList));
        chapter.append_child(quote, list);
        let li = chapter.alloc_node(Node::new(Role::ListItem));
        chapter.append_child(list, li);
        text_child(&mut chapter, li, "item");

        let (ion, _ctx) = export(&chapter);
        let IonValue::List(elems) = ion else { panic!() };
        let quote_ion = as_struct(&elems[0]);
        let container = KfxSymbol::Container as u64;
        assert!(
            matches!(field(quote_ion, KfxSymbol::Type), Some(IonValue::Symbol(t)) if *t == container),
            "block child must force container type: {quote_ion:?}"
        );
        assert!(field(quote_ion, KfxSymbol::Content).is_none());
    }

    /// Definition-list wrappers (dt container + dd content) must not mix the
    /// dt element child with bare dd text on one element — dd inline flow is
    /// wrapped in its own run element (glossaries were the largest remaining
    /// source of hybrid elements).
    #[test]
    fn definition_list_dd_text_gets_run_wrapped() {
        let mut chapter = Chapter::new();
        let dl = chapter.alloc_node(Node::new(Role::DefinitionList));
        chapter.append_child(chapter.root(), dl);
        let dt = chapter.alloc_node(Node::new(Role::DefinitionTerm));
        chapter.append_child(dl, dt);
        text_child(&mut chapter, dt, "term");
        let dd = chapter.alloc_node(Node::new(Role::DefinitionDescription));
        chapter.append_child(dl, dd);
        text_child(&mut chapter, dd, "the definition text");

        let (ion, _ctx) = export(&chapter);
        // Walk the whole tree: no struct may carry both Content and ContentList.
        fn assert_no_hybrid(v: &IonValue) {
            match v {
                IonValue::Struct(fields) => {
                    let has_ref = fields.iter().any(|(k, _)| *k == KfxSymbol::Content as u64);
                    let has_children = fields
                        .iter()
                        .any(|(k, _)| *k == KfxSymbol::ContentList as u64);
                    assert!(
                        !(has_ref && has_children),
                        "hybrid element (ref + children): {fields:?}"
                    );
                    for (_, val) in fields {
                        assert_no_hybrid(val);
                    }
                }
                IonValue::List(items) => items.iter().for_each(assert_no_hybrid),
                IonValue::Annotated(_, inner) => assert_no_hybrid(inner),
                _ => {}
            }
        }
        assert_no_hybrid(&ion);
    }

    /// Simple paragraphs keep the compact single-ref encoding.
    #[test]
    fn simple_paragraph_keeps_single_ref() {
        let mut chapter = Chapter::new();
        let para = chapter.alloc_node(Node::new(Role::Paragraph));
        chapter.append_child(chapter.root(), para);
        text_child(&mut chapter, para, "just text");

        let (ion, _ctx) = export(&chapter);
        let IonValue::List(elems) = ion else { panic!() };
        let para_ion = as_struct(&elems[0]);
        assert!(
            field(para_ion, KfxSymbol::Content).is_some(),
            "own ref kept"
        );
        assert!(
            field(para_ion, KfxSymbol::ContentList).is_none(),
            "no synthesized children"
        );
        let text_type = KfxSymbol::Text as u64;
        assert!(
            matches!(field(para_ion, KfxSymbol::Type), Some(IonValue::Symbol(t)) if *t == text_type)
        );
    }

    /// Tables export in the reference shape the device's table renderer
    /// engages with: cells are `container` + `layout: vertical` with NO
    /// `yj.semantics.type` marker (kfxlib rejects local markers on $270),
    /// cell text nests in a run child with the default style (reusing the
    /// cell's box style would draw its borders twice), cell styles shed
    /// authored min/max-width (column_format carries the widths), the table
    /// element carries the viewer features + column_format, and the caption
    /// nests its content with `yj.classification: caption` on the wrapper.
    /// Import restores TableCell structurally, header flag from the header
    /// section.
    #[test]
    fn table_exports_reference_shape() {
        use crate::style::{BorderCollapse, ComputedStyle as IrStyle, Length};

        let mut chapter = Chapter::new();

        let mut table_style = IrStyle::default();
        table_style.border_collapse = BorderCollapse::Collapse;
        let mut table = Node::new(Role::Table);
        table.style = chapter.styles.intern(table_style);
        let table_id = chapter.alloc_node(table);
        chapter.append_child(chapter.root(), table_id);

        let caption_id = chapter.alloc_node(Node::new(Role::Caption));
        chapter.append_child(table_id, caption_id);
        text_child(&mut chapter, caption_id, "Table 1. Comparison");

        let mut cell_style = IrStyle::default();
        cell_style.min_width = Length::Rem(6.0);
        cell_style.padding_left = Length::Em(0.5);
        let cell_style_id = chapter.styles.intern(cell_style);
        let cell = |chapter: &mut Chapter, row: NodeId, text: &str| {
            let mut node = Node::new(Role::TableCell);
            node.style = cell_style_id;
            let id = chapter.alloc_node(node);
            chapter.append_child(row, id);
            text_child(chapter, id, text);
        };

        let head_id = chapter.alloc_node(Node::new(Role::TableHead));
        chapter.append_child(table_id, head_id);
        let hrow_id = chapter.alloc_node(Node::new(Role::TableRow));
        chapter.append_child(head_id, hrow_id);
        cell(&mut chapter, hrow_id, "Name");
        cell(&mut chapter, hrow_id, "Value");

        let body_id = chapter.alloc_node(Node::new(Role::TableBody));
        chapter.append_child(table_id, body_id);
        let brow_id = chapter.alloc_node(Node::new(Role::TableRow));
        chapter.append_child(body_id, brow_id);
        cell(&mut chapter, brow_id, "A");
        cell(&mut chapter, brow_id, "a much longer cell text value");

        let (ion, ctx) = export(&chapter);
        let IonValue::List(elems) = &ion else {
            panic!()
        };
        let table_ion = as_struct(&elems[0]);

        // Table element: viewer features, selection mode, border collapsing,
        // and per-column widths (wider text column gets the wider column).
        assert!(
            field(table_ion, KfxSymbol::YjTableFeatures).is_some(),
            "table carries yj.table_features"
        );
        assert!(
            field(table_ion, KfxSymbol::YjTableSelectionMode).is_some(),
            "table carries yj.table_selection_mode"
        );
        assert!(
            matches!(
                field(table_ion, KfxSymbol::TableBorderCollapse),
                Some(IonValue::Bool(true))
            ),
            "border-collapse: collapse reaches the table element"
        );
        let Some(IonValue::List(columns)) = field(table_ion, KfxSymbol::ColumnFormat) else {
            panic!("table must carry column_format");
        };
        assert_eq!(columns.len(), 2, "one column_format entry per column");
        let width_of = |col: &IonValue| -> f64 {
            let Some(IonValue::Struct(w)) = field(as_struct(col), KfxSymbol::Width) else {
                panic!("column entry must carry a width");
            };
            let Some(IonValue::Decimal(v)) = w
                .iter()
                .find(|(k, _)| *k == KfxSymbol::Value as u64)
                .map(|(_, v)| v)
            else {
                panic!("width must be a decimal value");
            };
            v.parse().unwrap()
        };
        assert!(
            width_of(&columns[1]) > width_of(&columns[0]),
            "longer column text gets the wider column"
        );

        let IonValue::List(kids) = field(table_ion, KfxSymbol::ContentList).expect("children")
        else {
            panic!()
        };

        // Caption: classification on the wrapper, content in a nested child.
        let caption = as_struct(&kids[0]);
        assert!(
            matches!(
                field(caption, KfxSymbol::YjClassification),
                Some(IonValue::Symbol(c)) if *c == KfxSymbol::Caption as u64
            ),
            "caption wrapper carries yj.classification: caption"
        );
        assert!(
            field(caption, KfxSymbol::Content).is_none(),
            "classification-marked caption must not carry a content ref"
        );

        // Header cell: container + layout: vertical, no local-symbol fields
        // (no yj.semantics.type marker), content nested in a run child that
        // does NOT reuse the cell's box style.
        let header = as_struct(&kids[1]);
        let IonValue::List(hrows) = field(header, KfxSymbol::ContentList).expect("rows") else {
            panic!()
        };
        let hrow = as_struct(&hrows[0]);
        let IonValue::List(cells) = field(hrow, KfxSymbol::ContentList).expect("cells") else {
            panic!()
        };
        let cell_ion = as_struct(&cells[0]);
        assert!(
            matches!(
                field(cell_ion, KfxSymbol::Type),
                Some(IonValue::Symbol(t)) if *t == KfxSymbol::Container as u64
            ),
            "cells are containers"
        );
        assert!(
            field(cell_ion, KfxSymbol::Layout).is_some(),
            "cells carry layout: vertical"
        );
        assert!(
            !cell_ion
                .iter()
                .any(|(k, _)| *k >= crate::kfx::context::SymbolTable::LOCAL_MIN_ID),
            "cells carry no local-symbol fields (yj.semantics.type marker)"
        );
        let cell_style_sym = match field(cell_ion, KfxSymbol::Style) {
            Some(IonValue::Symbol(s)) => *s,
            other => panic!("cell must carry a style symbol, got {other:?}"),
        };
        let IonValue::List(cell_kids) =
            field(cell_ion, KfxSymbol::ContentList).expect("cell child")
        else {
            panic!()
        };
        let run = as_struct(&cell_kids[0]);
        assert!(
            field(run, KfxSymbol::Content).is_some(),
            "cell text lives in a nested run child"
        );
        let run_style_sym = match field(run, KfxSymbol::Style) {
            Some(IonValue::Symbol(s)) => *s,
            other => panic!("run must carry a style symbol, got {other:?}"),
        };
        assert_ne!(
            run_style_sym, cell_style_sym,
            "run child must not reuse the cell's box style"
        );

        // Cell styles shed authored min/max-width.
        let cell_kfx = ctx
            .style_registry
            .style_by_symbol(cell_style_sym)
            .expect("cell style registered");
        assert!(
            cell_kfx.get(KfxSymbol::MinWidth).is_none(),
            "cell min-width stripped (column_format carries widths)"
        );

        // Structural import round-trip: cells come back as TableCell, header
        // cells flagged from the enclosing header section.
        let storyline = IonValue::Struct(vec![(KfxSymbol::ContentList as u64, ion.clone())]);
        let tokens = tokenize_storyline(&storyline, &[], None, None);
        let imported = build_ir_from_tokens(&tokens, &[], None, |_, _| Some(String::new()));
        let mut cell_roles = 0;
        let mut header_cells = 0;
        for nid in imported.iter_dfs() {
            if imported.node(nid).map(|n| n.role) == Some(Role::TableCell) {
                cell_roles += 1;
                if imported.semantics.is_header_cell(nid) {
                    header_cells += 1;
                }
            }
        }
        assert_eq!(cell_roles, 4, "all four cells import as TableCell");
        assert_eq!(header_cells, 2, "thead cells import with the header flag");
    }

    /// Lists shed their authored horizontal indent (margin/padding-left) at
    /// export: the Kindle renderer supplies the list gutter natively, so
    /// authored values — which *replace* the UA gutter in HTML renderers —
    /// would stack on top of it and roughly double the indent on device.
    /// Kindle Previewer strips them the same way. Vertical margins survive,
    /// non-list elements keep their indent, and the list element carries
    /// `list_style_position: outside`.
    #[test]
    fn list_sheds_horizontal_indent() {
        use crate::style::{ComputedStyle as IrStyle, Length};

        let mut chapter = Chapter::new();

        // Leading paragraph so the list's top margin can't be dropped by
        // chapter-start margin collapsing.
        let lead = chapter.alloc_node(Node::new(Role::Paragraph));
        chapter.append_child(chapter.root(), lead);
        text_child(&mut chapter, lead, "lead");

        // ul { margin: 15px 0 15px 1.25em; padding-left: 2.25em }
        let mut ul_style = IrStyle::default();
        ul_style.margin_top = Length::Px(15.0);
        ul_style.margin_left = Length::Em(1.25);
        ul_style.padding_left = Length::Em(2.25);
        let mut ul = Node::new(Role::UnorderedList);
        ul.style = chapter.styles.intern(ul_style);
        let ul_id = chapter.alloc_node(ul);
        chapter.append_child(chapter.root(), ul_id);

        let li_id = chapter.alloc_node(Node::new(Role::ListItem));
        chapter.append_child(ul_id, li_id);
        text_child(&mut chapter, li_id, "item");

        // Control: a paragraph with the same indent keeps it.
        let mut p_style = IrStyle::default();
        p_style.margin_left = Length::Em(1.25);
        p_style.padding_left = Length::Em(2.25);
        let mut para = Node::new(Role::Paragraph);
        para.style = chapter.styles.intern(p_style);
        let p_id = chapter.alloc_node(para);
        chapter.append_child(chapter.root(), p_id);
        text_child(&mut chapter, p_id, "para");

        let (ion, ctx) = export(&chapter);
        let IonValue::List(elems) = ion else { panic!() };

        let style_of = |elem: &[(u64, IonValue)]| {
            let Some(IonValue::Symbol(sym)) = field(elem, KfxSymbol::Style) else {
                panic!("element must carry a style symbol");
            };
            ctx.style_registry
                .style_by_symbol(*sym)
                .expect("style symbol must resolve in the registry")
        };

        let ul_ion = as_struct(&elems[1]);
        assert!(
            matches!(field(ul_ion, KfxSymbol::Type), Some(IonValue::Symbol(t)) if *t == KfxSymbol::List as u64)
        );
        assert!(
            matches!(
                field(ul_ion, KfxSymbol::ListStylePosition),
                Some(IonValue::Symbol(p)) if *p == KfxSymbol::Outside as u64
            ),
            "list carries list_style_position: outside"
        );

        let ul_kfx = style_of(ul_ion);
        assert!(
            ul_kfx.get(KfxSymbol::MarginLeft).is_none(),
            "list margin-left must be stripped"
        );
        assert!(
            ul_kfx.get(KfxSymbol::PaddingLeft).is_none(),
            "list padding-left must be stripped"
        );
        assert!(
            ul_kfx.get(KfxSymbol::MarginTop).is_some(),
            "list vertical margin must survive"
        );

        let p_kfx = style_of(as_struct(&elems[2]));
        assert!(
            p_kfx.get(KfxSymbol::MarginLeft).is_some(),
            "non-list elements keep margin-left"
        );
        assert!(
            p_kfx.get(KfxSymbol::PaddingLeft).is_some(),
            "non-list elements keep padding-left"
        );
    }
}
