//! EPUB format support - pure parsing functions.

mod parser;

/// Maximum number of item references retained from an EPUB package spine.
pub(crate) const MAX_SPINE_CHAPTERS: usize = 4_096;

pub use parser::{parse_container_xml, parse_nav_landmarks, parse_nav_toc, parse_ncx, parse_opf};
