//! Universal link representation for ebook formats.
//!
//! Ebooks use fundamentally different addressing modes:
//! - **EPUB**: Semantic IDs (`#footnote-1`, `chapter2.xhtml#section-5`)
//! - **AZW3/KFX**: Physical offsets (`kindle:pos:fid:000B:off:00000002SO`)
//!
//! This module provides a format-agnostic representation that captures both.
//!
//! Links are stored as raw href strings in `SemanticMap.href` and parsed
//! on-demand using `Link::parse()` when needed (e.g., for export).

use crate::model::NodeId;

/// Unique identifier for a chapter/spine item within a book.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChapterId(pub u32);

/// Uniquely identifies a node across the entire book.
///
/// Combines a chapter identifier with a node identifier to provide
/// a globally unique reference to any node in any chapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GlobalNodeId {
    /// The chapter (spine item) containing the node.
    pub chapter: ChapterId,
    /// The node within that chapter's IR tree.
    pub node: NodeId,
}

impl GlobalNodeId {
    /// Create a new global node identifier.
    pub fn new(chapter: ChapterId, node: NodeId) -> Self {
        Self { chapter, node }
    }
}

/// The resolved target of a link.
///
/// After resolving hrefs against the book structure, each link points to
/// one of these target types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorTarget {
    /// Link to a specific node in a specific chapter.
    /// Example: href="chapter2.xhtml#note-1" → Internal(GlobalNodeId { chapter: 1, node: 23 })
    Internal(GlobalNodeId),

    /// Link to the start of a chapter (no fragment).
    /// Example: href="chapter2.xhtml" → Chapter(ChapterId(1))
    Chapter(ChapterId),

    /// External URL.
    /// Example: `href="https://example.com"` → External(String)
    External(String),
}
