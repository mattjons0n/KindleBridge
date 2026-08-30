//! MathML ⇄ [`Math`] tree.
//!
//! [`from_mathml`] lifts a parsed `<math>` DOM subtree into the canonical
//! tree; [`to_mathml`] serializes it back. Presentation MathML is
//! structurally the same tree, so both directions are near-lossless — an
//! element the tree doesn't model is kept verbatim as [`MathExpr::Raw`] with
//! its serialized source, so a round trip never loses content.

use crate::dom::{ArenaDom, ArenaNodeId};
use std::fmt;

use super::{ColAlign, Math, MathExpr, TokenKind};

/// The MathML namespace URI.
pub const MATHML_NS: &str = "http://www.w3.org/1998/Math/MathML";

/// Parse a standalone MathML string into a [`Math`]. Convenience for tools
/// and tests; the conversion pipeline goes through the DOM transform instead.
pub fn parse_math_str(s: &str) -> Option<Math> {
    let dom = crate::dom::parse_dom(s);
    let root = dom.find_by_tag("math")?;
    Some(from_mathml(&dom, root))
}

/// Whether any descendant `<mtable>` opts into display style — publishers
/// mark multi-row display equations with `displaystyle="true"` instead of
/// `display="block"` on the root.
fn has_displaystyle_table(dom: &ArenaDom, id: ArenaNodeId) -> bool {
    for c in dom.children(id) {
        if dom.element_name(c).map(|n| n.as_ref()) == Some("mtable")
            && dom.get_attr(c, "displaystyle") == Some("true")
        {
            return true;
        }
        if has_displaystyle_table(dom, c) {
            return true;
        }
    }
    false
}

/// Whether an element (by namespace or local name) is a MathML `<math>` root.
pub fn is_math_root(dom: &ArenaDom, id: ArenaNodeId) -> bool {
    dom.element_namespace(id).map(|ns| ns.as_ref()) == Some(MATHML_NS)
        || dom.element_name(id).map(|n| n.as_ref()) == Some("math")
}

/// Build a [`Math`] from a `<math>` element in the arena DOM.
pub fn from_mathml(dom: &ArenaDom, math_id: ArenaNodeId) -> Math {
    let display = matches!(dom.get_attr(math_id, "display"), Some("block"))
        || has_displaystyle_table(dom, math_id);
    let alttext = dom
        .get_attr(math_id, "alttext")
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    Math {
        expr: build_row(dom, math_id),
        display,
        alttext,
    }
}

/// Importer-controlled MathML conversion. A non-allocating/strictly bounded
/// arena preflight runs before the recursive canonical-tree builder, bounding
/// its stack depth, expression cardinality, and all duplicated strings.
pub(crate) fn from_mathml_limited(
    dom: &ArenaDom,
    math_id: ArenaNodeId,
    remaining_expr_nodes: usize,
    remaining_text_bytes: usize,
) -> crate::Result<Math> {
    preflight_mathml(dom, math_id, remaining_expr_nodes, remaining_text_bytes)?;
    let math = from_mathml(dom, math_id);
    let (nodes, bytes) = math.retained_stats();
    if nodes > remaining_expr_nodes {
        return Err(math_limit(format!(
            "canonical expression count exceeds the {remaining_expr_nodes} remaining nodes of the {} node document limit",
            super::MAX_DOCUMENT_MATH_EXPR_NODES
        )));
    }
    if bytes > remaining_text_bytes {
        return Err(math_limit(format!(
            "retained strings exceed the {remaining_text_bytes} remaining bytes of the {} byte document limit",
            super::MAX_DOCUMENT_MATH_TEXT_BYTES
        )));
    }
    Ok(math)
}

/// Bound the existing recursive builder before it allocates. For every source
/// element it can create at most its own expression plus three fixed-arity
/// empty children; with 4,096 elements the 20,000-expression budget cannot be
/// reached. Twice the exact full-subtree serialization length conservatively
/// covers the mutually exclusive token strings / Raw serializations plus
/// duplicated fence and alttext values.
fn preflight_mathml(
    dom: &ArenaDom,
    math_id: ArenaNodeId,
    remaining_expr_nodes: usize,
    remaining_text_bytes: usize,
) -> crate::Result<()> {
    let mut elements = 1usize;
    let mut serialized_bytes = 0usize;
    let mut stack = vec![(math_id, 1usize)];

    while let Some((id, depth)) = stack.pop() {
        if depth > super::MAX_DOCUMENT_MATH_DEPTH {
            return Err(math_limit(format!(
                "nesting exceeds the {} level limit",
                super::MAX_DOCUMENT_MATH_DEPTH
            )));
        }
        let name = dom.element_name(id).map(|name| name.as_ref()).unwrap_or("");
        // `<name></name>` is an upper bound for the tag framing even when the
        // actual serializer chooses the shorter self-closing spelling.
        serialized_bytes = checked_math_add(serialized_bytes, name.len().saturating_mul(2) + 5)?;
        for attr in [
            "open",
            "close",
            "display",
            "alttext",
            "mathvariant",
            "stretchy",
        ] {
            if let Some(value) = dom.get_attr(id, attr) {
                serialized_bytes = checked_math_add(
                    serialized_bytes,
                    attr.len()
                        .saturating_add(4)
                        .saturating_add(escaped_attr_len(value)),
                )?;
            }
        }

        for child in dom.children(id) {
            if dom.is_element(child) {
                elements = elements
                    .checked_add(1)
                    .ok_or_else(|| math_limit("source element count overflows"))?;
                if elements > super::MAX_DOCUMENT_MATH_SOURCE_ELEMENTS {
                    return Err(math_limit(format!(
                        "source element count exceeds the {} element limit",
                        super::MAX_DOCUMENT_MATH_SOURCE_ELEMENTS
                    )));
                }
                stack.push((child, depth + 1));
            } else if let Some(text) = dom.text_content(child) {
                serialized_bytes = checked_math_add(serialized_bytes, escaped_text_len(text))?;
            }
        }
    }

    let retained_upper = serialized_bytes
        .checked_mul(2)
        .ok_or_else(|| math_limit("retained string estimate overflows"))?;
    if retained_upper > remaining_text_bytes {
        return Err(math_limit(format!(
            "retained string estimate exceeds the {} remaining bytes of the {} byte document limit",
            remaining_text_bytes,
            super::MAX_DOCUMENT_MATH_TEXT_BYTES
        )));
    }
    let expression_upper = elements
        .checked_mul(4)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| math_limit("canonical expression estimate overflows"))?;
    if expression_upper > remaining_expr_nodes {
        return Err(math_limit(format!(
            "canonical expression estimate exceeds the {remaining_expr_nodes} remaining nodes of the {} node document limit",
            super::MAX_DOCUMENT_MATH_EXPR_NODES
        )));
    }
    Ok(())
}

fn checked_math_add(total: usize, additional: usize) -> crate::Result<usize> {
    total
        .checked_add(additional)
        .ok_or_else(|| math_limit("retained string estimate overflows"))
}

fn escaped_text_len(text: &str) -> usize {
    text.bytes().fold(0usize, |total, byte| {
        total.saturating_add(match byte {
            b'&' => 5,
            b'<' | b'>' => 4,
            _ => 1,
        })
    })
}

fn escaped_attr_len(text: &str) -> usize {
    text.bytes().fold(0usize, |total, byte| {
        total.saturating_add(match byte {
            b'&' => 5,
            b'<' => 4,
            b'"' => 6,
            _ => 1,
        })
    })
}

fn math_limit(context: impl Into<String>) -> crate::Error {
    crate::Error::ResourceLimit {
        context: format!("document MathML: {}", context.into()),
    }
}

/// Build an expression from the element children of `id`, wrapping multiple
/// children in a [`MathExpr::Row`] and unwrapping a single child.
fn build_row(dom: &ArenaDom, id: ArenaNodeId) -> MathExpr {
    let mut items: Vec<MathExpr> = dom
        .children(id)
        .filter(|&c| dom.is_element(c))
        .map(|c| build_expr(dom, c))
        .collect();
    match items.len() {
        0 => MathExpr::Row(Vec::new()),
        1 => items.pop().unwrap(),
        _ => MathExpr::Row(items),
    }
}

/// The element children of `id` as a Vec (for fixed-arity constructs).
fn elem_children(dom: &ArenaDom, id: ArenaNodeId) -> Vec<ArenaNodeId> {
    dom.children(id).filter(|&c| dom.is_element(c)).collect()
}

/// Convert one MathML element to a [`MathExpr`].
fn build_expr(dom: &ArenaDom, id: ArenaNodeId) -> MathExpr {
    let name = dom.element_name(id).map(|n| n.as_ref()).unwrap_or("");
    match name {
        "mi" => token(TokenKind::Ident, dom, id),
        "mn" => token(TokenKind::Num, dom, id),
        "mo" => token(TokenKind::Op, dom, id),
        "mtext" | "ms" => token(TokenKind::Text, dom, id),
        // Transparent grouping wrappers.
        "mrow" | "mstyle" | "mpadded" | "mphantom" => build_row(dom, id),
        "msub" => pair(dom, id, MathExpr::Sub),
        "msup" => pair(dom, id, MathExpr::Sup),
        "msubsup" => triple(dom, id, MathExpr::SubSup),
        "munder" => pair(dom, id, |base, under| MathExpr::Under { base, under }),
        "mover" => pair(dom, id, |base, over| MathExpr::Over { base, over }),
        "munderover" => triple(dom, id, |base, under, over| MathExpr::UnderOver {
            base,
            under,
            over,
        }),
        "mfrac" => pair(dom, id, MathExpr::Frac),
        "msqrt" => MathExpr::Sqrt(Box::new(build_row(dom, id))),
        // `<mroot>base index</mroot>`.
        "mroot" => {
            let kids = elem_children(dom, id);
            let radicand = kids.first().map(|&c| build_expr(dom, c)).unwrap_or_empty();
            let index = kids.get(1).map(|&c| build_expr(dom, c)).unwrap_or_empty();
            MathExpr::Root(Box::new(index), Box::new(radicand))
        }
        "mfenced" => {
            let open = dom.get_attr(id, "open").unwrap_or("(").to_string();
            let close = dom.get_attr(id, "close").unwrap_or(")").to_string();
            MathExpr::Fenced {
                open,
                close,
                body: Box::new(build_row(dom, id)),
            }
        }
        "mtable" => {
            let mut rows: Vec<Vec<MathExpr>> = Vec::new();
            let mut aligns: Vec<ColAlign> = Vec::new();
            for r in elem_children(dom, id) {
                if dom.element_name(r).map(|n| n.as_ref()) != Some("mtr") {
                    continue;
                }
                let mut row = Vec::new();
                for c in elem_children(dom, r) {
                    if dom.element_name(c).map(|n| n.as_ref()) != Some("mtd") {
                        continue;
                    }
                    let col = row.len();
                    if aligns.len() <= col {
                        aligns.resize(col + 1, ColAlign::Center);
                    }
                    // First explicit columnalign in each column wins.
                    if aligns[col] == ColAlign::Center {
                        aligns[col] = match dom.get_attr(c, "columnalign") {
                            Some("left") => ColAlign::Left,
                            Some("right") => ColAlign::Right,
                            _ => ColAlign::Center,
                        };
                    }
                    row.push(build_row(dom, c));
                }
                rows.push(row);
            }
            MathExpr::Table { rows, aligns }
        }
        "mspace" => MathExpr::Space,
        // `<semantics>` wraps a presentation child plus annotations; take the
        // first presentation child.
        "semantics" => elem_children(dom, id)
            .first()
            .map(|&c| build_expr(dom, c))
            .unwrap_or_empty(),
        // Anything unmodeled: keep its source so no round trip loses it.
        _ => MathExpr::Raw {
            mathml: Some(serialize_element(dom, id)),
            latex: None,
        },
    }
}

/// Build a leaf token from a token element's collected text.
fn token(kind: TokenKind, dom: &ArenaDom, id: ArenaNodeId) -> MathExpr {
    MathExpr::Token {
        kind,
        text: collect_text(dom, id),
    }
}

/// Collect all descendant text of an element (token content).
fn collect_text(dom: &ArenaDom, id: ArenaNodeId) -> String {
    let mut out = String::new();
    collect_text_into(dom, id, &mut out);
    out
}

fn collect_text_into(dom: &ArenaDom, id: ArenaNodeId, out: &mut String) {
    if let Some(t) = dom.text_content(id) {
        out.push_str(t);
        return;
    }
    for c in dom.children(id) {
        collect_text_into(dom, c, out);
    }
}

/// Two element children → a binary constructor (missing children fill empty).
fn pair<F>(dom: &ArenaDom, id: ArenaNodeId, f: F) -> MathExpr
where
    F: FnOnce(Box<MathExpr>, Box<MathExpr>) -> MathExpr,
{
    let kids = elem_children(dom, id);
    let a = kids.first().map(|&c| build_expr(dom, c)).unwrap_or_empty();
    let b = kids.get(1).map(|&c| build_expr(dom, c)).unwrap_or_empty();
    f(Box::new(a), Box::new(b))
}

/// Three element children → a ternary constructor (missing children fill empty).
fn triple<F>(dom: &ArenaDom, id: ArenaNodeId, f: F) -> MathExpr
where
    F: FnOnce(Box<MathExpr>, Box<MathExpr>, Box<MathExpr>) -> MathExpr,
{
    let kids = elem_children(dom, id);
    let a = kids.first().map(|&c| build_expr(dom, c)).unwrap_or_empty();
    let b = kids.get(1).map(|&c| build_expr(dom, c)).unwrap_or_empty();
    let c = kids.get(2).map(|&c| build_expr(dom, c)).unwrap_or_empty();
    f(Box::new(a), Box::new(b), Box::new(c))
}

/// Small helper: an empty expression (used for missing script/base slots).
trait UnwrapOrEmpty {
    fn unwrap_or_empty(self) -> MathExpr;
}
impl UnwrapOrEmpty for Option<MathExpr> {
    fn unwrap_or_empty(self) -> MathExpr {
        self.unwrap_or_else(|| MathExpr::Row(Vec::new()))
    }
}

/// Re-serialize an arena element (and its subtree) to a MathML string, for
/// the [`MathExpr::Raw`] escape hatch.
fn serialize_element(dom: &ArenaDom, id: ArenaNodeId) -> String {
    let mut out = String::new();
    serialize_into(dom, id, &mut out);
    out
}

fn serialize_into(dom: &ArenaDom, id: ArenaNodeId, out: &mut String) {
    if let Some(t) = dom.text_content(id) {
        push_escaped_text(out, t);
        return;
    }
    let Some(name) = dom.element_name(id).map(|n| n.as_ref().to_string()) else {
        return;
    };
    out.push('<');
    out.push_str(&name);
    // Preserve open/close/display/alttext-style attributes we know matter.
    for attr in ["open", "close", "display", "mathvariant", "stretchy"] {
        if let Some(v) = dom.get_attr(id, attr) {
            out.push(' ');
            out.push_str(attr);
            out.push_str("=\"");
            push_escaped_attr(out, v);
            out.push('"');
        }
    }
    let children: Vec<ArenaNodeId> = dom.children(id).collect();
    if children.is_empty() {
        out.push_str("/>");
        return;
    }
    out.push('>');
    for c in children {
        serialize_into(dom, c, out);
    }
    out.push_str("</");
    out.push_str(&name);
    out.push('>');
}

/// Serialize a [`Math`] tree back to a `<math>` MathML string.
pub fn to_mathml(math: &Math) -> String {
    let mut out = String::new();
    write_mathml_to(math, &mut out).expect("writing MathML to String cannot fail");
    out
}

/// Stream MathML into a caller-supplied formatter. The normalized exporter
/// passes its capped document buffer so a large equation cannot first allocate
/// an unconstrained intermediate `String`.
pub(crate) fn write_mathml_to<W: fmt::Write>(math: &Math, out: &mut W) -> fmt::Result {
    out.write_str("<math xmlns=\"")?;
    out.write_str(MATHML_NS)?;
    out.write_char('"')?;
    if math.display {
        out.write_str(" display=\"block\"")?;
    }
    if let Some(alt) = &math.alttext {
        out.write_str(" alttext=\"")?;
        write_escaped_attr(out, alt)?;
        out.write_char('"')?;
    }
    out.write_char('>')?;
    write_mathml_expr(&math.expr, out)?;
    out.write_str("</math>")
}

fn write_mathml_expr<W: fmt::Write>(expr: &MathExpr, out: &mut W) -> fmt::Result {
    match expr {
        MathExpr::Row(items) => {
            out.write_str("<mrow>")?;
            for it in items {
                write_mathml_expr(it, out)?;
            }
            out.write_str("</mrow>")?;
        }
        MathExpr::Token { kind, text } => {
            let tag = match kind {
                TokenKind::Ident => "mi",
                TokenKind::Op => "mo",
                TokenKind::Num => "mn",
                TokenKind::Text => "mtext",
            };
            out.write_char('<')?;
            out.write_str(tag)?;
            out.write_char('>')?;
            write_escaped_text(out, text)?;
            out.write_str("</")?;
            out.write_str(tag)?;
            out.write_char('>')?;
        }
        MathExpr::Sub(b, s) => wrap2(out, "msub", b, s)?,
        MathExpr::Sup(b, s) => wrap2(out, "msup", b, s)?,
        MathExpr::SubSup(b, sub, sup) => wrap3(out, "msubsup", b, sub, sup)?,
        MathExpr::Under { base, under } => wrap2(out, "munder", base, under)?,
        MathExpr::Over { base, over } => wrap2(out, "mover", base, over)?,
        MathExpr::UnderOver { base, under, over } => wrap3(out, "munderover", base, under, over)?,
        MathExpr::Frac(n, d) => wrap2(out, "mfrac", n, d)?,
        MathExpr::Sqrt(x) => {
            out.write_str("<msqrt>")?;
            write_mathml_expr(x, out)?;
            out.write_str("</msqrt>")?;
        }
        MathExpr::Root(i, x) => {
            // `<mroot>radicand index</mroot>`.
            out.write_str("<mroot>")?;
            write_mathml_expr(x, out)?;
            write_mathml_expr(i, out)?;
            out.write_str("</mroot>")?;
        }
        MathExpr::Fenced { open, close, body } => {
            out.write_str("<mfenced open=\"")?;
            write_escaped_attr(out, open)?;
            out.write_str("\" close=\"")?;
            write_escaped_attr(out, close)?;
            out.write_str("\">")?;
            write_mathml_expr(body, out)?;
            out.write_str("</mfenced>")?;
        }
        MathExpr::Table { rows, aligns } => {
            out.write_str("<mtable>")?;
            for row in rows {
                out.write_str("<mtr>")?;
                for (col, cell) in row.iter().enumerate() {
                    match aligns.get(col) {
                        Some(ColAlign::Left) => out.write_str("<mtd columnalign=\"left\">")?,
                        Some(ColAlign::Right) => out.write_str("<mtd columnalign=\"right\">")?,
                        _ => out.write_str("<mtd>")?,
                    }
                    write_mathml_expr(cell, out)?;
                    out.write_str("</mtd>")?;
                }
                out.write_str("</mtr>")?;
            }
            out.write_str("</mtable>")?;
        }
        MathExpr::Space => out.write_str("<mspace/>")?,
        MathExpr::Raw { mathml, .. } => {
            if let Some(m) = mathml {
                out.write_str(m)?;
            }
        }
    }
    Ok(())
}

fn wrap2<W: fmt::Write>(out: &mut W, tag: &str, a: &MathExpr, b: &MathExpr) -> fmt::Result {
    out.write_char('<')?;
    out.write_str(tag)?;
    out.write_char('>')?;
    write_mathml_expr(a, out)?;
    write_mathml_expr(b, out)?;
    out.write_str("</")?;
    out.write_str(tag)?;
    out.write_char('>')
}

fn wrap3<W: fmt::Write>(
    out: &mut W,
    tag: &str,
    a: &MathExpr,
    b: &MathExpr,
    c: &MathExpr,
) -> fmt::Result {
    out.write_char('<')?;
    out.write_str(tag)?;
    out.write_char('>')?;
    write_mathml_expr(a, out)?;
    write_mathml_expr(b, out)?;
    write_mathml_expr(c, out)?;
    out.write_str("</")?;
    out.write_str(tag)?;
    out.write_char('>')
}

fn write_escaped_text<W: fmt::Write>(out: &mut W, s: &str) -> fmt::Result {
    for c in s.chars() {
        match c {
            '<' => out.write_str("&lt;")?,
            '>' => out.write_str("&gt;")?,
            '&' => out.write_str("&amp;")?,
            _ => out.write_char(c)?,
        }
    }
    Ok(())
}

fn write_escaped_attr<W: fmt::Write>(out: &mut W, s: &str) -> fmt::Result {
    for c in s.chars() {
        match c {
            '<' => out.write_str("&lt;")?,
            '&' => out.write_str("&amp;")?,
            '"' => out.write_str("&quot;")?,
            _ => out.write_char(c)?,
        }
    }
    Ok(())
}

fn push_escaped_text(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            _ => out.push(c),
        }
    }
}

fn push_escaped_attr(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{MathExpr, TokenKind};

    /// Parse an HTML fragment and build the `Math` from its `<math>` element.
    fn parse(html: &str) -> Math {
        let dom = crate::dom::parse_dom(html);
        let math_id = dom.find_by_tag("math").expect("a <math> element");
        from_mathml(&dom, math_id)
    }

    #[test]
    fn limited_import_rejects_mathml_before_recursive_tree_allocation() {
        let mut nested = format!("<math xmlns=\"{MATHML_NS}\">");
        nested.push_str(&"<mrow>".repeat(super::super::MAX_DOCUMENT_MATH_DEPTH));
        nested.push_str("<mi>x</mi>");
        nested.push_str(&"</mrow>".repeat(super::super::MAX_DOCUMENT_MATH_DEPTH));
        nested.push_str("</math>");
        let dom = crate::dom::parse_dom(&nested);
        let root = dom.find_by_tag("math").unwrap();
        let error = from_mathml_limited(
            &dom,
            root,
            super::super::MAX_DOCUMENT_MATH_EXPR_NODES,
            super::super::MAX_DOCUMENT_MATH_TEXT_BYTES,
        )
        .expect_err("depth N+1 must fail before recursive conversion");
        assert!(
            error
                .to_string()
                .contains("nesting exceeds the 128 level limit")
        );

        let wide = format!(
            "<math xmlns=\"{MATHML_NS}\">{}</math>",
            "<mi>x</mi>".repeat(super::super::MAX_DOCUMENT_MATH_SOURCE_ELEMENTS)
        );
        let dom = crate::dom::parse_dom(&wide);
        let root = dom.find_by_tag("math").unwrap();
        let error = from_mathml_limited(
            &dom,
            root,
            super::super::MAX_DOCUMENT_MATH_EXPR_NODES,
            super::super::MAX_DOCUMENT_MATH_TEXT_BYTES,
        )
        .expect_err("source element N+1 must fail before canonical tree allocation");
        assert!(
            error
                .to_string()
                .contains("source element count exceeds the 4096 element limit")
        );
    }

    #[test]
    fn imports_structure() {
        let m = parse(r#"<math display="block"><msup><mi>E</mi></msup></math>"#);
        assert!(m.display);
        // E with an (empty) superscript.
        assert!(matches!(m.expr, MathExpr::Sup(..)));

        let m = parse(r#"<math><msubsup><mi>x</mi><mn>1</mn><mn>2</mn></msubsup></math>"#);
        match m.expr {
            MathExpr::SubSup(b, sub, sup) => {
                assert_eq!(
                    *b,
                    MathExpr::Token {
                        kind: TokenKind::Ident,
                        text: "x".into()
                    }
                );
                assert_eq!(
                    *sub,
                    MathExpr::Token {
                        kind: TokenKind::Num,
                        text: "1".into()
                    }
                );
                assert_eq!(
                    *sup,
                    MathExpr::Token {
                        kind: TokenKind::Num,
                        text: "2".into()
                    }
                );
            }
            other => panic!("expected SubSup, got {other:?}"),
        }
    }

    #[test]
    fn fenced_and_table() {
        let m = parse(
            r#"<math><mfenced open="[" close="]"><mtable><mtr><mtd><mn>1</mn></mtd></mtr></mtable></mfenced></math>"#,
        );
        match m.expr {
            MathExpr::Fenced { open, close, body } => {
                assert_eq!(open, "[");
                assert_eq!(close, "]");
                assert!(matches!(*body, MathExpr::Table { .. }));
            }
            other => panic!("expected Fenced, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_preserves_structure() {
        // from_mathml → to_mathml → from_mathml must yield the same tree.
        for src in [
            r#"<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>"#,
            r#"<math><msqrt><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></msqrt></math>"#,
            r#"<math><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover></math>"#,
        ] {
            let m1 = parse(src);
            let serialized = to_mathml(&m1);
            let m2 = parse(&format!("<div>{}</div>", serialized));
            assert_eq!(m1.expr, m2.expr, "round trip changed {src}");
        }
    }

    #[test]
    fn to_text_linearizes_structurally_with_alttext_fallback() {
        // The Unicode linearization wins even when alttext is present —
        // spoken-math prose ("x squared") is for screen readers, not the
        // visible text run.
        let m = parse(r#"<math alttext="x squared"><msup><mi>x</mi><mn>2</mn></msup></math>"#);
        assert_eq!(m.to_text(), "x²");

        let m = parse(r#"<math><msup><mi>x</mi><mn>2</mn></msup></math>"#);
        assert_eq!(m.to_text(), "x²");

        // An unmodeled equation with no renderable tree falls back to alttext.
        let m = parse(r#"<math alttext="the quadratic formula"><menclose notation="box"/></math>"#);
        assert_eq!(m.to_text(), "the quadratic formula");
    }
}
