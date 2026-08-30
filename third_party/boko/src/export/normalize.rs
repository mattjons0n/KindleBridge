//! Normalized export pipeline.
//!
//! This module provides functionality for transforming ebooks through the IR layer
//! to produce clean, consistent output. It merges styles from all chapters into a
//! unified stylesheet and synthesizes normalized XHTML.
//!
//! # Two-Pass Export Flow
//!
//! 1. **Pass 1**: Load all chapters as IR, merge styles into GlobalStylePool
//! 2. **Pass 2**: Generate unified CSS, synthesize XHTML per chapter with remapped styles
//!
//! # Example
//!
//! ```no_run
//! use boko::Book;
//! use boko::export::normalize_book;
//!
//! let mut book = Book::open("input.epub")?;
//! let content = normalize_book(&mut book)?;
//!
//! // content.css contains the unified stylesheet
//! // content.chapters contains synthesized XHTML documents
//! // content.assets contains all referenced asset paths
//! # Ok::<(), boko::Error>(())
//! ```

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::import::ChapterId;
use crate::model::{Book, Chapter, NodeId, Role};
use crate::style::{StyleId, StylePool};

/// Maximum synthesized XHTML retained for one normalized chapter (32 MiB).
pub(crate) const MAX_NORMALIZED_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
/// Maximum synthesized XHTML retained across one normalized book (128 MiB).
pub(crate) const MAX_NORMALIZED_BOOK_DOCUMENT_BYTES: usize = 128 * 1024 * 1024;

use super::css_gen::generate_css_limited;
use super::html_synth::MathForm;
use super::html_synth::synthesize_xhtml_document_with_class_list_math_limited;

/// Collects styles from all chapters into a unified pool.
///
/// When merging styles from multiple chapters, identical styles are deduplicated
/// and assigned the same global StyleId. Each chapter's local StyleIds are remapped
/// to global IDs for consistent class names across the book.
#[derive(Debug)]
pub struct GlobalStylePool {
    /// The unified style pool containing all unique styles.
    pool: StylePool,
    /// Maps (chapter_idx, local_StyleId) -> global_StyleId
    remaps: Vec<HashMap<StyleId, StyleId>>,
}

impl Default for GlobalStylePool {
    fn default() -> Self {
        Self::new()
    }
}

impl GlobalStylePool {
    /// Create a new empty global style pool.
    pub fn new() -> Self {
        Self {
            pool: StylePool::new(),
            remaps: Vec::new(),
        }
    }

    /// Merge styles from a chapter into the global pool.
    ///
    /// This method:
    /// 1. Iterates over all styles in the chapter's pool
    /// 2. Interns each style into the global pool (deduplicating identical styles)
    /// 3. Records the mapping from local to global StyleId
    ///
    /// # Arguments
    ///
    /// * `chapter_idx` - Index of the chapter (used for remap lookups)
    /// * `chapter` - The IR chapter containing styles to merge
    pub fn merge(&mut self, chapter_idx: usize, chapter: &Chapter) {
        // Ensure remaps vec is large enough
        while self.remaps.len() <= chapter_idx {
            self.remaps.push(HashMap::new());
        }

        let remap = &mut self.remaps[chapter_idx];

        // Merge each style from the chapter's pool
        for (local_id, style) in chapter.styles.iter() {
            let global_id = self.pool.intern_ref(style);
            remap.insert(local_id, global_id);
        }
    }

    /// Remap a local StyleId to its global equivalent.
    ///
    /// # Arguments
    ///
    /// * `chapter_idx` - Index of the chapter the style belongs to
    /// * `local_id` - The local StyleId from that chapter
    ///
    /// # Returns
    ///
    /// The global StyleId, or the default style if not found.
    pub fn remap(&self, chapter_idx: usize, local_id: StyleId) -> StyleId {
        self.remaps
            .get(chapter_idx)
            .and_then(|m| m.get(&local_id))
            .copied()
            .unwrap_or(StyleId::DEFAULT)
    }

    /// Get a reference to the unified style pool.
    pub fn pool(&self) -> &StylePool {
        &self.pool
    }

    /// Get all used style IDs across all chapters.
    pub fn used_styles(&self) -> Vec<StyleId> {
        let mut set = HashSet::new();
        for map in &self.remaps {
            set.extend(map.values().copied());
        }
        let mut styles: Vec<StyleId> = set.into_iter().collect();
        styles.sort_by_key(|s| s.0);
        styles
    }
}

/// Content for a single normalized chapter.
#[derive(Debug, Clone)]
pub struct ChapterContent {
    /// Chapter identifier.
    pub id: ChapterId,
    /// Original source path within the ebook.
    pub source_path: String,
    /// Complete synthesized XHTML document.
    pub document: String,
}

/// Result of normalizing all chapters in a book.
#[derive(Debug)]
pub struct NormalizedContent {
    /// The global style pool with merged styles.
    pub styles: GlobalStylePool,
    /// Normalized chapters with synthesized XHTML.
    pub chapters: Vec<ChapterContent>,
    /// All asset paths referenced across chapters.
    pub assets: HashSet<String>,
    /// The unified CSS stylesheet.
    pub css: String,
    /// Maps each chapter's original source path to its emitted `chapter_{i}.xhtml`.
    pub source_to_output: HashMap<String, String>,
    /// Maps an element/anchor id to the emitted file that defines it. Lets
    /// callers turn a bare `#anchor` (as KFX TOCs use) or a cross-chapter link
    /// into a `chapter_{i}.xhtml#anchor` reference that actually resolves.
    pub anchor_to_output: HashMap<String, String>,
    /// Resolved-link overrides: original href string -> emitted target.
    /// Built from `Book::resolve_links()`, this bridges importer-specific
    /// anchor schemes (KFX `#a1CJ` anchor symbols) to the target node's real
    /// emitted id, which the id-based maps above cannot do.
    pub href_remap: HashMap<String, String>,
}

impl NormalizedContent {
    /// Rewrite a TOC tree's hrefs to target the emitted chapter files.
    pub fn rewrite_toc(&self, toc: &[crate::model::TocEntry]) -> Vec<crate::model::TocEntry> {
        toc.iter().map(|e| self.rewrite_toc_entry(e)).collect()
    }

    /// Rewrite a single book-global href (e.g. a landmark target) onto the
    /// emitted `chapter_{i}.xhtml` files, like [`Self::rewrite_toc`] does for
    /// TOC entries.
    pub fn rewrite_link(&self, href: &str) -> String {
        if let Some(mapped) = self.href_remap.get(href) {
            return mapped.clone();
        }
        rewrite_href(&self.source_to_output, &self.anchor_to_output, None, href)
    }

    fn rewrite_toc_entry(&self, entry: &crate::model::TocEntry) -> crate::model::TocEntry {
        let mut out = entry.clone();
        out.href = self.rewrite_link(&entry.href);
        out.children = entry
            .children
            .iter()
            .map(|c| self.rewrite_toc_entry(c))
            .collect();
        out
    }
}

/// Resolve a link/TOC href that referenced an original source path or a bare
/// anchor fragment into one targeting the emitted `chapter_{i}.xhtml` files.
///
/// `base_source` is the source path of the document the href appears in (used to
/// resolve relative file references); pass `None` for book-global hrefs like TOC
/// entries.
fn rewrite_href(
    source_to_output: &HashMap<String, String>,
    anchor_to_output: &HashMap<String, String>,
    base_source: Option<&str>,
    href: &str,
) -> String {
    // Leave external and non-navigational links untouched.
    if href.is_empty() || href.contains("://") || href.starts_with("mailto:") {
        return href.to_string();
    }

    let (file, frag) = match href.split_once('#') {
        Some((f, fr)) => (f, Some(fr)),
        None => (href, None),
    };

    let output = if file.is_empty() {
        // Bare "#frag": find the chapter that defines the anchor; otherwise
        // assume it targets the current document.
        frag.and_then(|fr| anchor_to_output.get(fr).cloned())
            .or_else(|| base_source.and_then(|b| source_to_output.get(b).cloned()))
    } else {
        let resolved = match base_source {
            Some(b) => crate::dom::resolve_path(b, file),
            None => file.to_string(),
        };
        source_to_output
            .get(&resolved)
            .or_else(|| source_to_output.get(file))
            .cloned()
    };

    match (output, frag) {
        (Some(o), Some(fr)) => format!("{o}#{fr}"),
        (Some(o), None) => o,
        // Unknown target: keep a same-document fragment as-is; leave other
        // unresolved hrefs unchanged rather than inventing a target.
        (None, Some(fr)) if file.is_empty() => format!("#{fr}"),
        _ => href.to_string(),
    }
}

/// Reverse the exact set of entities [`escape_xml_into`] produces
/// (`&amp; &lt; &gt; &quot; &#39;`, plus `&apos;`). Borrows unchanged when
/// there is no `&`. Unknown entities keep their literal `&`.
fn xml_unescape(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('&') {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let (repl, len) = if tail.starts_with("&amp;") {
            ("&", 5)
        } else if tail.starts_with("&lt;") {
            ("<", 4)
        } else if tail.starts_with("&gt;") {
            (">", 4)
        } else if tail.starts_with("&quot;") {
            ("\"", 6)
        } else if tail.starts_with("&#39;") {
            ("'", 5)
        } else if tail.starts_with("&apos;") {
            ("'", 6)
        } else {
            ("&", 1) // not a recognized entity: keep the literal ampersand
        };
        out.push_str(repl);
        rest = &tail[len..];
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// Rewrite the `href="…"` attributes inside a synthesized document so internal
/// links point at the emitted chapter files.
fn rewrite_document_hrefs(
    mut doc: String,
    base_source: &str,
    source_to_output: &HashMap<String, String>,
    anchor_to_output: &HashMap<String, String>,
    href_remap: &HashMap<String, String>,
    max_document_bytes: usize,
) -> crate::Result<String> {
    const NEEDLE: &str = " href=\"";
    if !doc.contains(NEEDLE) {
        return Ok(doc);
    }
    // First determine the exact final length without retaining a second
    // document. This lets `replace_range` reserve at most the checked final
    // size and makes every later in-place replacement allocation-safe.
    let mut final_len = doc.len();
    let mut scan = doc.as_str();
    while let Some(pos) = scan.find(NEEDLE) {
        let after = &scan[pos + NEEDLE.len()..];
        if let Some(end) = after.find('"') {
            let unescaped = xml_unescape(&after[..end]);
            let key: &str = &unescaped;
            let rewritten = match href_remap.get(key) {
                Some(mapped) => std::borrow::Cow::Borrowed(mapped.as_str()),
                None => std::borrow::Cow::Owned(rewrite_href(
                    source_to_output,
                    anchor_to_output,
                    Some(base_source),
                    key,
                )),
            };
            let escaped_len = escaped_xml_len(&rewritten);
            final_len = final_len
                .checked_sub(end)
                .and_then(|value| value.checked_add(escaped_len))
                .ok_or_else(|| normalized_content_limit("rewritten document length overflows"))?;
            scan = &after[end + 1..];
        } else {
            break;
        }
    }
    checked_normalized_document_length(final_len, max_document_bytes)?;
    if final_len > doc.len() {
        doc.try_reserve_exact(final_len - doc.len()).map_err(|_| {
            normalized_content_limit("rewritten document reservation could not be satisfied")
        })?;
    }

    let mut cursor = 0usize;
    while let Some(relative) = doc[cursor..].find(NEEDLE) {
        let value_start = cursor + relative + NEEDLE.len();
        let Some(relative_end) = doc[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + relative_end;
        let escaped_rewrite = {
            // The href in the document is XML-escaped (html_synth wrote it),
            // but every rewrite map is keyed on the raw, unescaped href — so
            // unescape before lookup or a link containing `&`/`<`/`>` misses
            // and stays pointed at a nonexistent source path. Re-escape the
            // result for the attribute context; for the common (no-entity)
            // href this whole dance is a no-op.
            let unescaped = xml_unescape(&doc[value_start..value_end]);
            let key: &str = &unescaped;
            // Resolved-link overrides win: they carry importer knowledge the
            // string-based maps below don't have (see `href_remap`).
            let rewritten = match href_remap.get(key) {
                Some(mapped) => std::borrow::Cow::Borrowed(mapped.as_str()),
                None => std::borrow::Cow::Owned(rewrite_href(
                    source_to_output,
                    anchor_to_output,
                    Some(base_source),
                    key,
                )),
            };
            let mut escaped = String::with_capacity(escaped_xml_len(&rewritten));
            super::escape_xml_into(&mut escaped, &rewritten);
            escaped
        };
        doc.replace_range(value_start..value_end, &escaped_rewrite);
        cursor = value_start + escaped_rewrite.len() + 1;
    }
    debug_assert_eq!(doc.len(), final_len);
    Ok(doc)
}

fn escaped_xml_len(value: &str) -> usize {
    value.bytes().fold(0usize, |total, byte| {
        total.saturating_add(match byte {
            b'&' => 5,
            b'<' | b'>' => 4,
            b'"' => 6,
            b'\'' => 5,
            _ => 1,
        })
    })
}

/// Normalize all chapters in a book through the IR pipeline.
///
/// This is the main entry point for normalized export. It:
/// 1. Loads each chapter as IR
/// 2. Merges all styles into a global pool
/// 3. Generates a unified CSS stylesheet
/// 4. Synthesizes XHTML for each chapter with remapped styles
/// 5. Collects all asset references
///
/// # Arguments
///
/// * `book` - Mutable reference to the book to normalize
///
/// # Returns
///
/// A `NormalizedContent` containing all normalized data ready for export.
pub fn normalize_book(book: &Book) -> crate::Result<NormalizedContent> {
    normalize_book_math(book, MathForm::MathMl)
}

/// [`normalize_book`] with an explicit math serialization form — KF8/MOBI
/// targets pass [`MathForm::Text`] because their renderers cannot display
/// MathML.
pub fn normalize_book_math(book: &Book, math_form: MathForm) -> crate::Result<NormalizedContent> {
    let spine = book.spine();

    // =========================================================================
    // Pass 1: Load all chapters and merge styles
    // =========================================================================

    let mut global_styles = GlobalStylePool::new();
    let mut ir_chapters: Vec<(ChapterId, String, Arc<Chapter>)> = Vec::with_capacity(spine.len());
    // Link-rewrite maps: original source path / anchor id -> emitted filename.
    let mut source_to_output: HashMap<String, String> = HashMap::new();
    let mut anchor_to_output: HashMap<String, String> = HashMap::new();

    // Compile every spine chapter up front as one batch — importers with
    // thread-safe IO (EPUB) parallelize the HTML parse + cascade + IR
    // transform across chapters, which dominates cold conversion.
    let spine_ids: Vec<ChapterId> = spine.iter().map(|e| e.id).collect();
    let loaded = book.load_chapters_cached(&spine_ids)?;

    for ((idx, entry), chapter) in spine.iter().enumerate().zip(loaded) {
        let source_path = book
            .source_id(entry.id)
            .unwrap_or("unknown.xhtml")
            .to_string();

        // Merge styles into global pool
        global_styles.merge(idx, &chapter);

        // Record where this chapter and its anchors will live in the output, so
        // TOC entries and internal links can be remapped from the original
        // source paths / bare `#anchor`s to the emitted `chapter_{i}.xhtml`.
        let output_name = format!("chapter_{idx}.xhtml");
        source_to_output.insert(source_path.clone(), output_name.clone());
        for node_id in chapter.iter_dfs() {
            if let Some(id) = chapter.semantics.id(node_id) {
                anchor_to_output
                    .entry(id.to_string())
                    .or_insert_with(|| output_name.clone());
            }
        }

        ir_chapters.push((entry.id, source_path, chapter));
    }

    // =========================================================================
    // Resolve importer-specific link anchors
    // =========================================================================
    //
    // Some importers use anchor schemes that don't correspond to element ids
    // in the IR (KFX links carry anchor *symbols* like "#a1CJ" while the
    // target nodes carry numeric eids). The string maps above can't bridge
    // that, so consult the book's resolved links and point each such href at
    // the target node's real emitted location.
    let chapter_pos: HashMap<ChapterId, usize> = ir_chapters
        .iter()
        .enumerate()
        .map(|(i, (id, _, _))| (*id, i))
        .collect();
    let mut per_chapter_remap: Vec<HashMap<String, String>> =
        vec![HashMap::new(); ir_chapters.len()];
    let mut href_remap: HashMap<String, String> = HashMap::new();
    if let Ok(resolved) = book.resolve_links() {
        for (idx, (chapter_id, _, chapter)) in ir_chapters.iter().enumerate() {
            for node_id in chapter.iter_dfs() {
                let Some(href) = chapter.semantics.href(node_id) else {
                    continue;
                };
                if href.is_empty() || href.contains("://") || href.starts_with("mailto:") {
                    continue;
                }
                let target = resolved.get(crate::model::GlobalNodeId::new(*chapter_id, node_id));
                let output = match target {
                    Some(crate::model::AnchorTarget::Internal(gid)) => {
                        let Some(&tidx) = chapter_pos.get(&gid.chapter) else {
                            continue;
                        };
                        let frag = ir_chapters[tidx].2.semantics.id(gid.node);
                        match frag {
                            Some(frag) => format!("chapter_{tidx}.xhtml#{frag}"),
                            None => format!("chapter_{tidx}.xhtml"),
                        }
                    }
                    Some(crate::model::AnchorTarget::Chapter(cid)) => {
                        let Some(&tidx) = chapter_pos.get(cid) else {
                            continue;
                        };
                        format!("chapter_{tidx}.xhtml")
                    }
                    _ => continue,
                };
                per_chapter_remap[idx].insert(href.to_string(), output.clone());
                href_remap.entry(href.to_string()).or_insert(output);
            }
        }
    }

    // =========================================================================
    // Generate unified CSS
    // =========================================================================

    let used_styles = global_styles.used_styles();
    let css_artifact = generate_css_limited(
        global_styles.pool(),
        &used_styles,
        MAX_NORMALIZED_DOCUMENT_BYTES,
    )?;

    // =========================================================================
    // Pass 2: Synthesize XHTML with remapped styles
    // =========================================================================

    // Synthesis is intentionally invoked sequentially below so the next
    // document receives only the book-level bytes still available.
    let synthesize_one = |((idx, (chapter_id, source_path, ir)), document_budget): (
        (usize, &(ChapterId, String, Arc<Chapter>)),
        usize,
    )|
     -> crate::Result<(ChapterContent, HashSet<String>)> {
        // Build remapped style map for this chapter
        let mut remapped_class_list: Vec<Option<&str>> = vec![None; ir.styles.len()];
        for (local_id, _) in ir.styles.iter() {
            let global_id = global_styles.remap(idx, local_id);
            if let Some(class_name) = css_artifact.class_name_fast(global_id) {
                let slot = remapped_class_list
                    .get_mut(local_id.0 as usize)
                    .expect("style id out of bounds");
                *slot = Some(class_name);
            }
        }

        // Extract title from first heading or use source path
        let title = extract_chapter_title(ir).unwrap_or_else(|| source_path.clone());

        // Synthesize XHTML document
        let result = synthesize_xhtml_document_with_class_list_math_limited(
            ir,
            &remapped_class_list,
            &title,
            Some("style.css"),
            math_form,
            document_budget,
        )?;

        // Rewrite internal links to target the emitted chapter files.
        let document = rewrite_document_hrefs(
            result.body,
            source_path,
            &source_to_output,
            &anchor_to_output,
            &per_chapter_remap[idx],
            document_budget,
        )?;

        Ok((
            ChapterContent {
                id: *chapter_id,
                source_path: source_path.clone(),
                document,
            },
            result.assets,
        ))
    };

    // Synthesize and account one document at a time. A hostile all-spine book
    // cannot first retain a parallel Vec of every expanded XHTML document.
    let mut chapters = Vec::with_capacity(ir_chapters.len());
    let mut all_assets = HashSet::new();
    let mut aggregate_document_bytes = 0usize;
    for item in ir_chapters.iter().enumerate() {
        let remaining = MAX_NORMALIZED_BOOK_DOCUMENT_BYTES
            .checked_sub(aggregate_document_bytes)
            .ok_or_else(|| normalized_content_limit("aggregate synthesized XHTML overflows"))?;
        let document_budget = remaining.min(MAX_NORMALIZED_DOCUMENT_BYTES);
        let (content, assets) = synthesize_one((item, document_budget)).map_err(|error| {
            if document_budget < MAX_NORMALIZED_DOCUMENT_BYTES
                && matches!(error, crate::Error::ResourceLimit { .. })
            {
                normalized_content_limit(format!(
                    "aggregate synthesized XHTML exceeds the {MAX_NORMALIZED_BOOK_DOCUMENT_BYTES} byte limit"
                ))
            } else {
                error
            }
        })?;
        aggregate_document_bytes =
            checked_normalized_document_total(aggregate_document_bytes, content.document.len())?;
        all_assets.extend(assets);
        chapters.push(content);
    }

    // The synthesized documents now own the export representation; release
    // the all-spine IR cache before an output builder starts allocating.
    drop(ir_chapters);
    book.clear_cache();

    Ok(NormalizedContent {
        styles: global_styles,
        chapters,
        assets: all_assets,
        css: css_artifact.stylesheet,
        source_to_output,
        anchor_to_output,
        href_remap,
    })
}

fn normalized_content_limit(context: impl Into<String>) -> crate::Error {
    crate::Error::ResourceLimit {
        context: format!("normalized content: {}", context.into()),
    }
}

fn checked_normalized_document_total(current: usize, document: usize) -> crate::Result<usize> {
    checked_normalized_document_length(document, MAX_NORMALIZED_DOCUMENT_BYTES)?;
    let next = current
        .checked_add(document)
        .ok_or_else(|| normalized_content_limit("aggregate synthesized XHTML overflows"))?;
    if next > MAX_NORMALIZED_BOOK_DOCUMENT_BYTES {
        return Err(normalized_content_limit(format!(
            "aggregate synthesized XHTML exceeds the {MAX_NORMALIZED_BOOK_DOCUMENT_BYTES} byte limit"
        )));
    }
    Ok(next)
}

fn checked_normalized_document_length(document: usize, max_bytes: usize) -> crate::Result<()> {
    if document > max_bytes {
        return Err(normalized_content_limit(format!(
            "synthesized document exceeds the {max_bytes} byte limit"
        )));
    }
    Ok(())
}

/// Extract a title from the first heading in a chapter.
fn extract_chapter_title(ir: &Chapter) -> Option<String> {
    for node_id in ir.iter_dfs() {
        if let Some(node) = ir.node(node_id)
            && matches!(node.role, Role::Heading(_))
        {
            // Collect text from heading's children
            let mut title = String::new();
            collect_text_recursive(ir, node_id, &mut title);
            if !title.is_empty() {
                return Some(title.trim().to_string());
            }
        }
    }
    None
}

/// Recursively collect text content from a node and its descendants.
fn collect_text_recursive(ir: &Chapter, node_id: NodeId, buf: &mut String) {
    if let Some(node) = ir.node(node_id)
        && node.role == Role::Text
    {
        buf.push_str(ir.text(node.text));
    }

    for child_id in ir.children(node_id) {
        collect_text_recursive(ir, child_id, buf);
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::model::Node;
    use crate::style::{ComputedStyle, FontWeight};

    #[test]
    fn normalized_document_budget_rejects_n_plus_one() {
        assert_eq!(
            checked_normalized_document_total(0, MAX_NORMALIZED_DOCUMENT_BYTES).unwrap(),
            MAX_NORMALIZED_DOCUMENT_BYTES
        );
        let error =
            checked_normalized_document_total(0, MAX_NORMALIZED_DOCUMENT_BYTES + 1).unwrap_err();
        assert!(error.to_string().contains("synthesized document exceeds"));
    }

    #[test]
    fn normalized_book_budget_rejects_aggregate_n_plus_one() {
        let error =
            checked_normalized_document_total(MAX_NORMALIZED_BOOK_DOCUMENT_BYTES, 1).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("aggregate synthesized XHTML exceeds")
        );
    }

    #[test]
    fn xml_unescape_reverses_escape_xml() {
        // Round-trips the exact entity set escape_xml_into produces.
        for raw in ["a&b", "x<y>z", "he said \"hi\"", "it's", "plain/path#frag"] {
            let escaped = super::super::escape_xml(raw);
            assert_eq!(xml_unescape(&escaped), raw, "round trip for {raw:?}");
        }
        // No-ampersand fast path borrows unchanged.
        assert!(matches!(
            xml_unescape("chapter_0.xhtml#frag"),
            std::borrow::Cow::Borrowed(_)
        ));
        // Unknown entity keeps its literal ampersand.
        assert_eq!(xml_unescape("a&unknown;b"), "a&unknown;b");
    }

    #[test]
    fn rewrite_document_hrefs_handles_escaped_ampersand() {
        // A resolved link whose raw href contains `&` is escaped in the doc
        // as `&amp;`; the rewrite must still find it and retarget it.
        let mut href_remap = HashMap::new();
        href_remap.insert("ch1.xhtml#a&b".to_string(), "chapter_0.xhtml#x".to_string());
        let doc = r#"<a href="ch1.xhtml#a&amp;b">link</a>"#;
        let out = rewrite_document_hrefs(
            doc.to_string(),
            "src.xhtml",
            &HashMap::new(),
            &HashMap::new(),
            &href_remap,
            MAX_NORMALIZED_DOCUMENT_BYTES,
        )
        .unwrap();
        assert!(out.contains(r#"href="chapter_0.xhtml#x""#), "{out}");
    }

    #[test]
    fn href_rewrite_rejects_expansion_past_document_cap_before_mutation() {
        let original = r#"<a href="short">link</a>"#.to_string();
        let mut href_remap = HashMap::new();
        href_remap.insert(
            "short".to_string(),
            "x".repeat(MAX_NORMALIZED_DOCUMENT_BYTES + 1),
        );
        let error = rewrite_document_hrefs(
            original,
            "src.xhtml",
            &HashMap::new(),
            &HashMap::new(),
            &href_remap,
            MAX_NORMALIZED_DOCUMENT_BYTES,
        )
        .expect_err("a rewrite beyond 32 MiB must fail in the length preflight");
        assert!(error.to_string().contains("synthesized document exceeds"));
    }

    #[test]
    fn test_global_style_pool_new() {
        let pool = GlobalStylePool::new();
        assert_eq!(pool.pool().len(), 1); // Default style
        assert!(pool.remaps.is_empty());
    }

    #[test]
    fn test_global_style_pool_merge() {
        let mut global = GlobalStylePool::new();

        // Create first chapter with a bold style
        let mut chapter1 = Chapter::new();
        let mut bold = ComputedStyle::default();
        bold.font_weight = FontWeight::BOLD;
        let bold_id = chapter1.styles.intern(bold.clone());

        // Create second chapter with the same bold style
        let mut chapter2 = Chapter::new();
        let bold_id2 = chapter2.styles.intern(bold);

        // Merge both chapters
        global.merge(0, &chapter1);
        global.merge(1, &chapter2);

        // Both should map to the same global ID
        let global_id1 = global.remap(0, bold_id);
        let global_id2 = global.remap(1, bold_id2);
        assert_eq!(global_id1, global_id2);

        // Global pool should have 2 styles (default + bold)
        assert_eq!(global.pool().len(), 2);
    }

    #[test]
    fn test_global_style_pool_remap_unknown() {
        let global = GlobalStylePool::new();

        // Unknown chapter/style should return default
        let result = global.remap(999, StyleId(999));
        assert_eq!(result, StyleId::DEFAULT);
    }

    #[test]
    fn test_global_style_pool_used_styles() {
        let mut global = GlobalStylePool::new();

        let mut chapter = Chapter::new();
        let mut bold = ComputedStyle::default();
        bold.font_weight = FontWeight::BOLD;
        chapter.styles.intern(bold);

        global.merge(0, &chapter);

        let used = global.used_styles();
        assert!(!used.is_empty());
    }

    #[test]
    fn test_extract_chapter_title() {
        let mut chapter = Chapter::new();

        // Add a heading with text
        let h1 = chapter.alloc_node(Node::new(Role::Heading(1)));
        chapter.append_child(NodeId::ROOT, h1);

        let text_range = chapter.append_text("Chapter One");
        let mut text_node = Node::new(Role::Text);
        text_node.text = text_range;
        let text_id = chapter.alloc_node(text_node);
        chapter.append_child(h1, text_id);

        let title = extract_chapter_title(&chapter);
        assert_eq!(title, Some("Chapter One".to_string()));
    }

    #[test]
    fn test_extract_chapter_title_no_heading() {
        let chapter = Chapter::new();
        let title = extract_chapter_title(&chapter);
        assert_eq!(title, None);
    }

    #[test]
    fn rewrite_href_maps_anchors_and_paths() {
        let source_to_output =
            HashMap::from([("text/ch2.xhtml".to_string(), "chapter_1.xhtml".to_string())]);
        let anchor_to_output = HashMap::from([("sec3".to_string(), "chapter_1.xhtml".to_string())]);
        let rw = |href: &str| rewrite_href(&source_to_output, &anchor_to_output, None, href);

        // Bare "#anchor" (as KFX TOCs use) -> the chapter that defines it.
        assert_eq!(rw("#sec3"), "chapter_1.xhtml#sec3");
        // Source path, with and without a fragment -> emitted file.
        assert_eq!(rw("text/ch2.xhtml#x"), "chapter_1.xhtml#x");
        assert_eq!(rw("text/ch2.xhtml"), "chapter_1.xhtml");
        // Unknown anchor stays a same-document fragment; externals untouched.
        assert_eq!(rw("#missing"), "#missing");
        assert_eq!(rw("https://example.com/a"), "https://example.com/a");
    }
}
