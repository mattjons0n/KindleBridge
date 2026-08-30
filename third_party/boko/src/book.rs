//! The `Book` runtime handle for reading ebooks via importers.
//!
//! This module wires the pure data model (`crate::model`) to the
//! format-specific importer and exporter backends. It sits above both
//! `crate::import` and `crate::export` in the layering.

use std::collections::{HashMap, HashSet};
use std::io::{self, Seek, Write};
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};

use crate::export::{Azw3Exporter, EpubExporter, Exporter, KfxExporter, MarkdownExporter};
use crate::import::{
    Azw3Importer, ChapterId, EpubImporter, Importer, KfxImporter, MobiImporter, SpineEntry,
};
use crate::io::MemorySource;
use crate::model::{AnchorTarget, Chapter, Format, Landmark, Metadata, ResolvedLinks, TocEntry};
use crate::resolved::resolve_book_links;

/// Maximum normalized IR nodes retained across one book's chapter cache.
pub(crate) const MAX_BOOK_IR_NODES: usize = 1_000_000;
/// Maximum semantic IR attributes retained across one book's chapter cache.
pub(crate) const MAX_BOOK_IR_ATTRIBUTES: usize = 1_000_000;
/// Maximum text and semantic string bytes retained across the chapter cache.
pub(crate) const MAX_BOOK_IR_TEXT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum distinct per-chapter computed styles retained across the cache.
pub(crate) const MAX_BOOK_IR_STYLES: usize = 100_000;
/// Maximum canonical MathExpr nodes retained across the chapter cache.
pub(crate) const MAX_BOOK_MATH_EXPR_NODES: usize = 200_000;
/// Maximum canonical math-owned string bytes retained across the cache.
pub(crate) const MAX_BOOK_MATH_TEXT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
struct IrCache {
    chapters: HashMap<ChapterId, Arc<Chapter>>,
    nodes: usize,
    attributes: usize,
    text_bytes: usize,
    styles: usize,
    math_expr_nodes: usize,
    math_text_bytes: usize,
}

impl IrCache {
    fn clear(&mut self) {
        self.chapters.clear();
        self.nodes = 0;
        self.attributes = 0;
        self.text_bytes = 0;
        self.styles = 0;
        self.math_expr_nodes = 0;
        self.math_text_bytes = 0;
    }

    /// Insert only after every aggregate has been checked. The caller owns the
    /// sole `Chapter` until this succeeds, so a rejected chapter is dropped
    /// rather than retained alongside the cache.
    fn insert_checked(&mut self, id: ChapterId, chapter: Chapter) -> crate::Result<Arc<Chapter>> {
        if let Some(existing) = self.chapters.get(&id) {
            return Ok(Arc::clone(existing));
        }

        let nodes = self
            .nodes
            .checked_add(chapter.node_count())
            .ok_or_else(|| book_ir_limit("aggregate IR node count overflows"))?;
        let attributes = self
            .attributes
            .checked_add(chapter.semantics.len())
            .ok_or_else(|| book_ir_limit("aggregate IR attribute count overflows"))?;
        let text_bytes = self
            .text_bytes
            .checked_add(chapter.retained_text_bytes())
            .ok_or_else(|| book_ir_limit("aggregate retained IR text length overflows"))?;
        let styles = self
            .styles
            .checked_add(chapter.styles.len())
            .ok_or_else(|| book_ir_limit("aggregate IR style count overflows"))?;
        let (chapter_math_nodes, chapter_math_bytes) = chapter.math_retained_stats();
        let math_expr_nodes = self
            .math_expr_nodes
            .checked_add(chapter_math_nodes)
            .ok_or_else(|| book_ir_limit("aggregate MathExpr node count overflows"))?;
        let math_text_bytes = self
            .math_text_bytes
            .checked_add(chapter_math_bytes)
            .ok_or_else(|| book_ir_limit("aggregate retained math strings overflow"))?;

        if nodes > MAX_BOOK_IR_NODES {
            return Err(book_ir_limit(format!(
                "aggregate IR node count exceeds the {MAX_BOOK_IR_NODES} node limit"
            )));
        }
        if attributes > MAX_BOOK_IR_ATTRIBUTES {
            return Err(book_ir_limit(format!(
                "aggregate IR attribute count exceeds the {MAX_BOOK_IR_ATTRIBUTES} attribute limit"
            )));
        }
        if text_bytes > MAX_BOOK_IR_TEXT_BYTES {
            return Err(book_ir_limit(format!(
                "aggregate retained IR text exceeds the {MAX_BOOK_IR_TEXT_BYTES} byte limit"
            )));
        }
        if styles > MAX_BOOK_IR_STYLES {
            return Err(book_ir_limit(format!(
                "aggregate IR style count exceeds the {MAX_BOOK_IR_STYLES} style limit"
            )));
        }
        if math_expr_nodes > MAX_BOOK_MATH_EXPR_NODES {
            return Err(book_ir_limit(format!(
                "aggregate MathExpr count exceeds the {MAX_BOOK_MATH_EXPR_NODES} node limit"
            )));
        }
        if math_text_bytes > MAX_BOOK_MATH_TEXT_BYTES {
            return Err(book_ir_limit(format!(
                "aggregate retained math strings exceed the {MAX_BOOK_MATH_TEXT_BYTES} byte limit"
            )));
        }

        let chapter = Arc::new(chapter);
        self.chapters.insert(id, Arc::clone(&chapter));
        self.nodes = nodes;
        self.attributes = attributes;
        self.text_bytes = text_bytes;
        self.styles = styles;
        self.math_expr_nodes = math_expr_nodes;
        self.math_text_bytes = math_text_bytes;
        Ok(chapter)
    }
}

fn book_ir_limit(context: impl Into<String>) -> crate::Error {
    crate::Error::ResourceLimit {
        context: format!("book chapter cache: {}", context.into()),
    }
}

/// Runtime handle for an ebook.
///
/// `Book` wraps a format-specific `Importer` backend and provides
/// unified access to metadata, table of contents, and content.
///
/// # Example
///
/// ```no_run
/// use boko::Book;
///
/// let mut book = Book::open("input.epub")?;
/// println!("Title: {}", book.metadata().title);
///
/// // Load chapter content (collect spine first to avoid borrow issues)
/// let spine: Vec<_> = book.spine().to_vec();
/// for entry in spine {
///     let raw = book.load_raw(entry.id)?;
///     println!("Chapter {}: {} bytes", entry.id.0, raw.len());
/// }
/// # Ok::<(), boko::Error>(())
/// ```
pub struct Book {
    backend: Box<dyn Importer>,
    /// Cache of parsed IR chapters to avoid re-parsing during normalized export.
    /// Uses RwLock for thread-safe access and Arc for cheap cloning.
    ir_cache: Arc<RwLock<IrCache>>,
    /// TOC after format-specific href fixup (AZW3/MOBI `#fileposN` suffixes).
    /// Empty for formats whose hrefs are correct from source.
    fixed_toc: OnceLock<Vec<TocEntry>>,
    /// TOC after href fixup AND target resolution (set by `resolve_links`).
    /// Takes precedence over `fixed_toc` in [`toc`](Self::toc).
    targeted_toc: OnceLock<Vec<TocEntry>>,
    /// Memoized link resolution, shared with callers as an `Arc`.
    resolved_links: OnceLock<Arc<ResolvedLinks>>,
}

impl Book {
    /// Open an ebook file, auto-detecting the format.
    pub fn open(path: impl AsRef<Path>) -> crate::Result<Self> {
        let path = path.as_ref();
        let format = Format::from_path(path).ok_or_else(|| crate::Error::UnsupportedFormat {
            detail: format!("unknown file format: {}", path.display()),
        })?;
        Self::open_format(path, format)
    }

    /// Open an ebook file with an explicit format.
    pub fn open_format(path: impl AsRef<Path>, format: Format) -> crate::Result<Self> {
        let backend: Box<dyn Importer> = match format {
            Format::Epub => Box::new(EpubImporter::open(path.as_ref())?),
            Format::Azw3 => Box::new(Azw3Importer::open(path.as_ref())?),
            Format::Mobi => Box::new(MobiImporter::open(path.as_ref())?),
            Format::Kfx => Box::new(KfxImporter::open(path.as_ref())?),
            Format::Markdown => {
                return Err(crate::Error::UnsupportedFormat {
                    detail: "Markdown format is export-only".into(),
                });
            }
        };
        Ok(Self::from_backend(backend))
    }

    /// Swap the importer backend, returning the old one.
    ///
    /// Cached chapters are dropped: they were produced by the old backend
    /// and may not reflect the new one's view (e.g. rewritten asset paths
    /// after [`optimize`](Self::optimize)).
    pub(crate) fn replace_backend(&mut self, backend: Box<dyn Importer>) -> Box<dyn Importer> {
        self.ir_cache
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        std::mem::replace(&mut self.backend, backend)
    }

    fn from_backend(backend: Box<dyn Importer>) -> Self {
        Self {
            backend,
            ir_cache: Arc::new(RwLock::new(IrCache::default())),
            fixed_toc: OnceLock::new(),
            targeted_toc: OnceLock::new(),
            resolved_links: OnceLock::new(),
        }
    }

    /// Create a Book from in-memory bytes with an explicit format.
    ///
    /// This is useful for reading from stdin or other non-file sources.
    pub fn from_bytes(data: &[u8], format: Format) -> crate::Result<Self> {
        let source = Arc::new(MemorySource::new(data.to_vec()));
        let backend: Box<dyn Importer> = match format {
            Format::Epub => Box::new(EpubImporter::from_source(source)?),
            Format::Azw3 => Box::new(Azw3Importer::from_source(source)?),
            Format::Mobi => Box::new(MobiImporter::from_source(source)?),
            Format::Kfx => Box::new(KfxImporter::from_source(source)?),
            Format::Markdown => {
                return Err(crate::Error::UnsupportedFormat {
                    detail: "Markdown format is export-only".into(),
                });
            }
        };
        Ok(Self::from_backend(backend))
    }

    /// Book metadata.
    pub fn metadata(&self) -> &Metadata {
        self.backend.metadata()
    }

    /// Table of contents.
    ///
    /// Serves the most-resolved view available: after `resolve_links` the
    /// entries carry resolved targets; after `resolve_toc` (AZW3/MOBI) the
    /// hrefs carry fragment suffixes; otherwise the importer's entries as
    /// parsed from source.
    pub fn toc(&self) -> &[TocEntry] {
        if let Some(toc) = self.targeted_toc.get() {
            return toc;
        }
        if let Some(toc) = self.fixed_toc.get() {
            return toc;
        }
        self.backend.toc()
    }

    /// Landmarks (structural navigation points).
    pub fn landmarks(&self) -> &[Landmark] {
        self.backend.landmarks()
    }

    /// Reading order (spine).
    pub fn spine(&self) -> &[SpineEntry] {
        self.backend.spine()
    }

    /// Get the internal source path for a chapter.
    pub fn source_id(&self, id: ChapterId) -> Option<&str> {
        self.backend.source_id(id)
    }

    /// Load raw chapter bytes.
    pub fn load_raw(&self, id: ChapterId) -> crate::Result<Vec<u8>> {
        self.backend.load_raw(id)
    }

    /// Load a chapter as normalized IR.
    ///
    /// This parses the chapter's HTML content and any linked or inline CSS,
    /// producing a normalized tree structure suitable for rendering.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boko::{Book, Role};
    ///
    /// let mut book = Book::open("input.epub")?;
    /// let spine: Vec<_> = book.spine().to_vec();
    ///
    /// for entry in spine {
    ///     let chapter = book.load_chapter(entry.id)?;
    ///     for id in chapter.iter_dfs() {
    ///         let node = chapter.node(id).unwrap();
    ///         if matches!(node.role, Role::Heading(_)) {
    ///             // Process heading...
    ///         }
    ///     }
    /// }
    /// # Ok::<(), boko::Error>(())
    /// ```
    pub fn load_chapter(&self, id: ChapterId) -> crate::Result<Chapter> {
        self.backend.load_chapter(id)
    }

    /// Load a chapter as IR with caching.
    ///
    /// This method caches parsed IR chapters to avoid re-parsing when the same
    /// chapter is loaded multiple times (e.g., during normalized export).
    /// Returns an `Arc<Chapter>` for cheap cloning and thread-safe sharing.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boko::Book;
    ///
    /// let mut book = Book::open("input.epub")?;
    /// let spine: Vec<_> = book.spine().to_vec();
    ///
    /// // First call parses the chapter
    /// let chapter1 = book.load_chapter_cached(spine[0].id)?;
    ///
    /// // Second call returns cached version (cheap Arc clone)
    /// let chapter2 = book.load_chapter_cached(spine[0].id)?;
    /// # Ok::<(), boko::Error>(())
    /// ```
    pub fn load_chapter_cached(&self, id: ChapterId) -> crate::Result<Arc<Chapter>> {
        // Fast path: check read lock first
        {
            let cache = self
                .ir_cache
                .read()
                .map_err(|_| io::Error::other("IR cache lock poisoned"))?;
            if let Some(chapter) = cache.chapters.get(&id) {
                return Ok(Arc::clone(chapter));
            }
        }

        // Slow path: load chapter (no lock held during IO)
        let chapter = self.backend.load_chapter(id)?;
        let mut cache = self
            .ir_cache
            .write()
            .map_err(|_| io::Error::other("IR cache lock poisoned"))?;
        cache.insert_checked(id, chapter)
    }

    /// Load several chapters as IR with caching, in spine order.
    ///
    /// Like calling [`load_chapter_cached`](Self::load_chapter_cached) per id.
    /// Uncached chapters are compiled and budget-checked one at a time so the
    /// backend never retains a hostile all-spine batch before aggregate limits
    /// can be enforced.
    pub fn load_chapters_cached(&self, ids: &[ChapterId]) -> crate::Result<Vec<Arc<Chapter>>> {
        // Collect unique ids that still need compiling.
        let missing: Vec<ChapterId> = {
            let cache = self
                .ir_cache
                .read()
                .map_err(|_| io::Error::other("IR cache lock poisoned"))?;
            let mut seen = HashSet::new();
            ids.iter()
                .copied()
                .filter(|id| !cache.chapters.contains_key(id) && seen.insert(*id))
                .collect()
        };

        for id in missing {
            let chapter = self.backend.load_chapter(id)?;
            let mut cache = self
                .ir_cache
                .write()
                .map_err(|_| io::Error::other("IR cache lock poisoned"))?;
            cache.insert_checked(id, chapter)?;
        }

        let cache = self
            .ir_cache
            .read()
            .map_err(|_| io::Error::other("IR cache lock poisoned"))?;
        ids.iter()
            .map(|id| {
                cache
                    .chapters
                    .get(id)
                    .cloned()
                    .ok_or_else(|| crate::Error::NotFound {
                        what: format!("chapter {}", id.0),
                    })
            })
            .collect()
    }

    /// Clear the IR cache.
    ///
    /// Call this to free memory after normalized export is complete.
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.ir_cache.write() {
            cache.clear();
        }
    }

    /// Resolve all internal links in the book.
    ///
    /// Uses `load_chapter_cached()` internally, so chapters are parsed once
    /// and reused for subsequent export operations. Call this before export
    /// to benefit from caching.
    ///
    /// Returns both forward mappings (source -> target) and reverse mappings
    /// (target -> sources) for efficient lookup during traversal.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boko::Book;
    ///
    /// let mut book = Book::open("input.epub")?;
    /// let resolved = book.resolve_links()?;
    ///
    /// // Check for broken links
    /// for (source, href) in resolved.broken_links() {
    ///     eprintln!("Broken link at {:?}: {}", source, href);
    /// }
    /// # Ok::<(), boko::Error>(())
    /// ```
    pub fn resolve_links(&self) -> crate::Result<Arc<ResolvedLinks>> {
        if let Some(resolved) = self.resolved_links.get() {
            return Ok(Arc::clone(resolved));
        }
        let resolved = Arc::new(resolve_book_links(self)?);
        // A concurrent resolution may have won the race; both computed the
        // same thing, so whichever landed first is shared.
        Ok(Arc::clone(self.resolved_links.get_or_init(|| resolved)))
    }

    /// Index anchors for link resolution.
    ///
    /// Called internally by `resolve_links()`. Delegates to the format-specific
    /// importer to build anchor maps.
    pub(crate) fn index_anchors(&self, chapters: &[(ChapterId, Arc<Chapter>)]) {
        self.backend.index_anchors(chapters);
    }

    /// Resolve TOC hrefs (fills in fragments for AZW3/MOBI).
    ///
    /// Computes the importer's fixed-up TOC once and caches it; formats whose
    /// hrefs are already correct (EPUB/KFX) cache nothing and
    /// [`toc`](Self::toc) keeps serving the importer's entries.
    pub(crate) fn resolve_toc(&self) {
        if self.fixed_toc.get().is_none()
            && let Some(fixed) = self.backend.resolve_toc()
        {
            let _ = self.fixed_toc.set(fixed);
        }
    }

    /// Resolve TOC entry targets using `resolve_href()`.
    ///
    /// Called internally by `resolve_links()` after `index_anchors`, so
    /// fragment anchors resolve. Produces the final targeted TOC from the
    /// fixed (or original) entries and caches it once.
    pub(crate) fn resolve_toc_targets(&self) {
        if self.targeted_toc.get().is_some() {
            return;
        }

        fn apply_targets(entries: &mut [TocEntry], backend: &dyn Importer) {
            for entry in entries {
                entry.target = backend.resolve_href(ChapterId(0), &entry.href);
                apply_targets(&mut entry.children, backend);
            }
        }

        let mut toc = self
            .fixed_toc
            .get()
            .cloned()
            .unwrap_or_else(|| self.backend.toc().to_vec());
        apply_targets(&mut toc, &*self.backend);
        let _ = self.targeted_toc.set(toc);
    }

    /// Resolve a single href using format-specific logic.
    ///
    /// Called internally by `resolve_links()`. Delegates to the format-specific
    /// importer.
    pub(crate) fn resolve_href(&self, from_chapter: ChapterId, href: &str) -> Option<AnchorTarget> {
        self.backend.resolve_href(from_chapter, href)
    }

    /// Load an asset by archive entry name (e.g. `"OEBPS/images/cover.jpg"`).
    pub fn load_asset(&self, path: &str) -> crate::Result<Vec<u8>> {
        self.backend.load_asset(path)
    }

    /// List all assets as archive entry names (forward-slash separated).
    pub fn list_assets(&self) -> &[String] {
        self.backend.list_assets()
    }

    /// Collect all @font-face definitions from CSS files.
    ///
    /// Returns font-face rules that map font family names to font files.
    /// Used by KFX export to create font entities linking font-family
    /// names to resource locations.
    pub fn font_faces(&self) -> Vec<crate::model::FontFace> {
        self.backend.font_faces()
    }

    /// Whether this book requires normalized export for HTML-based formats.
    ///
    /// Returns true for binary formats (KFX) where the raw content is not HTML.
    /// Exporters should use IR-based output when this returns true.
    pub fn requires_normalized_export(&self) -> bool {
        self.backend.requires_normalized_export()
    }

    /// Export the book to a different format.
    ///
    /// # Supported Export Formats
    ///
    /// | Format   | Support |
    /// |----------|---------|
    /// | EPUB     | ✓       |
    /// | AZW3     | ✓       |
    /// | MOBI     | ✗       |
    /// | Text     | ✓       |
    /// | Markdown | ✓       |
    ///
    /// # Example
    ///
    /// ```no_run
    /// use boko::{Book, Format};
    /// use std::fs::File;
    ///
    /// let book = Book::open("input.azw3")?;
    /// let mut file = File::create("output.epub")?;
    /// book.export(Format::Epub, &mut file)?;
    /// # Ok::<(), boko::Error>(())
    /// ```
    pub fn export<W: Write + Seek>(&self, format: Format, writer: &mut W) -> crate::Result<()> {
        match format {
            Format::Epub => EpubExporter::new().export(self, writer),
            Format::Azw3 => Azw3Exporter::new().export(self, writer),
            Format::Markdown => MarkdownExporter::new().export(self, writer),
            Format::Kfx => KfxExporter::new().export(self, writer),
            Format::Mobi => Err(crate::Error::UnsupportedFormat {
                detail: format!("{:?} export is not supported", format),
            }),
        }
    }
}

#[cfg(test)]
mod resource_limit_tests {
    use super::*;

    #[test]
    fn ir_cache_rejection_is_atomic_at_each_aggregate_boundary() {
        let cases = [
            (MAX_BOOK_IR_NODES, 0, 0, 0, "aggregate IR node count"),
            (
                0,
                MAX_BOOK_IR_ATTRIBUTES,
                0,
                0,
                "aggregate IR attribute count",
            ),
            (
                0,
                0,
                MAX_BOOK_IR_TEXT_BYTES,
                0,
                "aggregate retained IR text",
            ),
            (0, 0, 0, MAX_BOOK_IR_STYLES, "aggregate IR style count"),
        ];

        for (nodes, attributes, text_bytes, styles, expected) in cases {
            let mut cache = IrCache {
                nodes,
                attributes,
                text_bytes,
                styles,
                ..IrCache::default()
            };
            let mut chapter = Chapter::new();
            chapter.append_text("x");
            chapter.semantics.set_href(crate::model::NodeId::ROOT, "#x");
            let error = cache
                .insert_checked(ChapterId(7), chapter)
                .expect_err("N+1 cache insertion must fail");
            assert!(error.to_string().contains(expected));
            assert!(cache.chapters.is_empty());
            assert_eq!(cache.nodes, nodes);
            assert_eq!(cache.attributes, attributes);
            assert_eq!(cache.text_bytes, text_bytes);
            assert_eq!(cache.styles, styles);
        }
    }

    #[test]
    fn ir_cache_math_rejection_is_atomic_at_each_aggregate_boundary() {
        for (math_expr_nodes, math_text_bytes, expected) in [
            (MAX_BOOK_MATH_EXPR_NODES, 0, "aggregate MathExpr count"),
            (
                0,
                MAX_BOOK_MATH_TEXT_BYTES,
                "aggregate retained math strings",
            ),
        ] {
            let mut cache = IrCache {
                math_expr_nodes,
                math_text_bytes,
                ..IrCache::default()
            };
            let mut chapter = Chapter::new();
            chapter.math.insert(
                crate::model::NodeId::ROOT,
                crate::math::Math {
                    expr: crate::math::MathExpr::Token {
                        kind: crate::math::TokenKind::Ident,
                        text: "x".into(),
                    },
                    display: false,
                    alttext: None,
                },
            );
            let error = cache
                .insert_checked(ChapterId(8), chapter)
                .expect_err("N+1 math cache insertion must fail");
            assert!(error.to_string().contains(expected));
            assert!(cache.chapters.is_empty());
            assert_eq!(cache.math_expr_nodes, math_expr_nodes);
            assert_eq!(cache.math_text_bytes, math_text_bytes);
        }
    }
}
