//! EPUB format importer - handles all IO.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};

use zip::ZipArchive;

use crate::dom::Stylesheet;
use crate::epub::{parse_container_xml, parse_nav_landmarks, parse_nav_toc, parse_ncx, parse_opf};
use crate::import::{ChapterId, Importer, SpineEntry, resolve_path_based_href};
use crate::io::{ByteSource, ByteSourceCursor, FileSource};
use crate::model::{AnchorTarget, Chapter, GlobalNodeId, Landmark, Metadata, TocEntry};

/// Maximum number of ZIP entries accepted from one EPUB.
///
/// The importer keeps an index of every entry, so this is checked directly
/// from the end-of-central-directory record before `zip` parses or retains the
/// central directory.
pub const MAX_EPUB_ARCHIVE_ENTRIES: usize = 20_000;

/// Maximum total declared inflated size of all entries in one EPUB (256 MiB).
///
/// This intentionally stays close to the application's 200 MiB source/output
/// ceilings: the browser simultaneously holds the compressed input, parsed
/// book state, and a growing Kindle derivative.
pub const MAX_EPUB_ARCHIVE_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

/// Maximum declared inflated size of one EPUB entry (128 MiB).
pub const MAX_EPUB_ENTRY_UNCOMPRESSED_BYTES: u64 = crate::util::MAX_DECOMPRESSED_ENTRY as u64;

/// Maximum raw byte length of one ZIP entry name.
pub const MAX_EPUB_ENTRY_NAME_BYTES: usize = 2_048;

/// Maximum total raw byte length of all ZIP entry names (8 MiB).
pub const MAX_EPUB_ARCHIVE_NAME_BYTES: usize = 8 * 1024 * 1024;

/// Maximum central-directory region read during the resource preflight
/// (24 MiB). This also bounds extra fields and comments that are parsed by the
/// `zip` crate but are not part of the entry-name aggregate.
pub const MAX_EPUB_CENTRAL_DIRECTORY_BYTES: u64 = 24 * 1024 * 1024;

/// Maximum number of XHTML documents retained in one EPUB reading order.
pub const MAX_EPUB_SPINE_CHAPTERS: usize = crate::epub::MAX_SPINE_CHAPTERS;

/// Maximum aggregate declared inflated bytes across the EPUB reading order
/// (128 MiB). This is checked before any chapter bytes or DOMs are loaded.
pub const MAX_EPUB_SPINE_UNCOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;

/// Maximum ratio between an entry's declared inflated and compressed sizes.
const MAX_EPUB_COMPRESSION_RATIO: u64 = 1_000;

const ZIP_EOCD_MIN_BYTES: usize = 22;
const ZIP_EOCD_SEARCH_BYTES: u64 = 65_535 + ZIP_EOCD_MIN_BYTES as u64;
const ZIP_EOCD_SIGNATURE: u32 = 0x0605_4b50;
const ZIP_CENTRAL_ENTRY_SIGNATURE: u32 = 0x0201_4b50;

impl From<zip::result::ZipError> for crate::Error {
    fn from(e: zip::result::ZipError) -> Self {
        // A genuine I/O failure while reading the archive is not a malformed
        // book — preserve it (and its ErrorKind) as Error::Io. Only structural
        // ZIP problems become Malformed.
        match e {
            zip::result::ZipError::Io(io) => crate::Error::Io(io),
            other => crate::Error::Malformed {
                format: crate::Format::Epub,
                context: other.to_string(),
            },
        }
    }
}

/// EPUB format importer with random-access ZIP reading.
pub struct EpubImporter {
    /// Random-access byte source for the ZIP file.
    source: Arc<dyn ByteSource>,

    /// Cached ZIP entry locations: path -> ZipEntryLoc.
    zip_index: HashMap<String, ZipEntryLoc>,

    /// Book metadata.
    metadata: Metadata,

    /// Table of contents.
    toc: Vec<TocEntry>,

    /// Landmarks (structural navigation points).
    landmarks: Vec<Landmark>,

    /// Reading order (spine).
    spine: Vec<SpineEntry>,

    /// Maps ChapterId -> ZIP path (e.g., "OEBPS/text/ch01.xhtml").
    spine_paths: Vec<String>,

    /// All asset paths in the ZIP (archive entry names, forward slashes).
    assets: Vec<String>,

    /// Cached parsed stylesheets. Behind a lock so parallel chapter
    /// compilation ([`Importer::load_chapters`]) can share it through `&self`.
    css_cache: RwLock<HashMap<String, Arc<Stylesheet>>>,

    /// Fonts listed in META-INF/encryption.xml as obfuscated, keyed by
    /// archive path. Deobfuscated transparently in [`load_asset`].
    obfuscated_fonts: HashMap<String, FontObfuscation>,

    // --- Link resolution ---
    /// Maps path (without fragment) -> ChapterId
    path_to_chapter: HashMap<String, ChapterId>,

    /// Maps chapter -> fragment -> GlobalNodeId for fragment resolution.
    /// Keeping the path outside each key avoids repeating a potentially 2 KiB
    /// archive path for every anchor in a wide document.
    anchor_map: RwLock<HashMap<ChapterId, HashMap<String, GlobalNodeId>>>,
}

#[derive(Clone, Copy)]
struct ZipEntryLoc {
    data_offset: u64,
    compressed_size: u64,
    uncompressed_size: u64,
    compression: u16, // 0 = Store, 8 = Deflate
}

impl Importer for EpubImporter {
    fn open(path: &Path) -> crate::Result<Self> {
        let file = std::fs::File::open(path)?;
        let source = Arc::new(FileSource::new(file)?);
        Self::from_source(source)
    }

    fn metadata(&self) -> &Metadata {
        &self.metadata
    }

    fn toc(&self) -> &[TocEntry] {
        &self.toc
    }

    fn landmarks(&self) -> &[Landmark] {
        &self.landmarks
    }

    fn spine(&self) -> &[SpineEntry] {
        &self.spine
    }

    fn source_id(&self, id: ChapterId) -> Option<&str> {
        self.spine_paths.get(id.0 as usize).map(|s| s.as_str())
    }

    fn load_raw(&self, id: ChapterId) -> crate::Result<Vec<u8>> {
        let path = self
            .spine_paths
            .get(id.0 as usize)
            .ok_or_else(|| crate::Error::NotFound {
                what: format!("chapter {}", id.0),
            })?;
        self.read_entry(path)
    }

    fn list_assets(&self) -> &[String] {
        &self.assets
    }

    fn load_asset(&self, path: &str) -> crate::Result<Vec<u8>> {
        let data = self.read_entry(path)?;
        if let Some(obfuscation) = self.obfuscated_fonts.get(path) {
            return Ok(deobfuscate_font(data, obfuscation));
        }
        Ok(data)
    }

    fn load_stylesheet(&self, path: &str) -> Option<Arc<Stylesheet>> {
        if let Ok(cache) = self.css_cache.read()
            && let Some(sheet) = cache.get(path)
        {
            return Some(Arc::clone(sheet));
        }
        let css_bytes = read_content_entry(
            &self.source,
            &self.zip_index,
            path,
            crate::dom::MAX_DOCUMENT_XHTML_BYTES as u64,
            "stylesheet",
        )
        .ok()?;
        let css_str = String::from_utf8_lossy(&css_bytes);
        let sheet = Arc::new(Stylesheet::parse(&css_str));
        // Two threads may race to parse the same sheet; the first insert wins
        // so every chapter ends up sharing one Arc.
        match self.css_cache.write() {
            Ok(mut cache) => Some(Arc::clone(cache.entry(path.to_string()).or_insert(sheet))),
            Err(_) => Some(sheet),
        }
    }

    fn index_anchors(&self, chapters: &[(ChapterId, Arc<Chapter>)]) {
        let mut anchor_map = HashMap::new();

        for (chapter_id, chapter) in chapters {
            let mut chapter_anchors = HashMap::new();
            for node_id in chapter.iter_dfs() {
                if let Some(id) = chapter.semantics.id(node_id) {
                    chapter_anchors.insert(id.to_string(), GlobalNodeId::new(*chapter_id, node_id));
                }
            }
            anchor_map.insert(*chapter_id, chapter_anchors);
        }

        if let Ok(mut map) = self.anchor_map.write() {
            *map = anchor_map;
        }
    }

    fn resolve_href(&self, from_chapter: ChapterId, href: &str) -> Option<AnchorTarget> {
        let from_path = self.source_id(from_chapter)?;
        resolve_path_based_href(
            from_path,
            href,
            |p| self.path_to_chapter.get(p).copied(),
            |key| {
                let (path, fragment) = key.rsplit_once('#')?;
                let chapter = self.path_to_chapter.get(path)?;
                self.anchor_map.read().ok().and_then(|map| {
                    map.get(chapter)
                        .and_then(|anchors| anchors.get(fragment))
                        .copied()
                })
            },
        )
    }
}

impl EpubImporter {
    /// Create an importer from a ByteSource.
    pub fn from_source(source: Arc<dyn ByteSource>) -> crate::Result<Self> {
        // Check hostile-archive resource claims before `ZipArchive::new`
        // parses and retains central-directory entries. The follow-up ZIP
        // reader still performs its full structural validation.
        let expected_entries = preflight_archive(&*source)?;

        // 1. Scan ZIP central directory and cache entry locations
        let cursor = ByteSourceCursor::new(source.clone());
        let mut archive = ZipArchive::new(cursor)?;
        if archive.len() != expected_entries {
            return Err(epub_malformed(
                "central-directory entry count changed during ZIP parsing",
            ));
        }

        let mut zip_index = HashMap::new();
        let mut assets = Vec::new();

        for i in 0..archive.len() {
            let file = archive.by_index(i)?;
            let name = file.name().to_string();

            if zip_index.contains_key(&name) {
                return Err(epub_malformed("archive contains duplicate entry names"));
            }

            zip_index.insert(
                name.clone(),
                ZipEntryLoc {
                    data_offset: file
                        .data_start()
                        .ok_or_else(|| epub_malformed("archive entry has no data offset"))?,
                    compressed_size: file.compressed_size(),
                    uncompressed_size: file.size(),
                    compression: compression_to_u16(file.compression()),
                },
            );
            // Directory entries are ZIP bookkeeping, not assets; surfacing
            // them made re-exports reference "files" like `OEBPS/images/`.
            if !name.ends_with('/') {
                assets.push(name);
            }
        }

        // 2. Find OPF path from container.xml
        let container_bytes = read_content_entry(
            &source,
            &zip_index,
            "META-INF/container.xml",
            crate::dom::MAX_DOCUMENT_XHTML_BYTES as u64,
            "container document",
        )?;
        let opf_path = parse_container_xml(&container_bytes)?;
        // Directory of the OPF (including trailing slash), or "" for root.
        let opf_base = match opf_path.rfind('/') {
            Some(idx) => opf_path[..=idx].to_string(),
            None => String::new(),
        };

        // 3. Parse OPF
        let opf_bytes = read_content_entry(
            &source,
            &zip_index,
            &opf_path,
            crate::dom::MAX_DOCUMENT_XHTML_BYTES as u64,
            "package document",
        )?;
        let hint_encoding = crate::util::extract_xml_encoding(&opf_bytes);
        let opf_str = crate::util::decode_text(&opf_bytes, hint_encoding);
        let opf = parse_opf(&opf_str)?;

        // 4. Build spine. Manifest hrefs are URLs (may be percent-encoded);
        // archive entry names are literal, so decode at this join point.
        let mut spine = Vec::new();
        let mut spine_paths = Vec::new();
        let mut aggregate_spine_bytes = 0u64;

        for spine_id in &opf.spine_ids {
            if let Some((href, _media_type)) = opf.manifest.get(spine_id) {
                let full_path = crate::import::resolve_relative_path(&opf_path, href);
                let uncompressed_size = zip_index
                    .get(&full_path)
                    .map(|loc| loc.uncompressed_size)
                    .unwrap_or(0);

                if uncompressed_size > crate::dom::MAX_DOCUMENT_XHTML_BYTES as u64 {
                    return Err(epub_content_limit(format!(
                        "spine document exceeds the {} byte limit",
                        crate::dom::MAX_DOCUMENT_XHTML_BYTES
                    )));
                }

                if spine_paths.len() >= MAX_EPUB_SPINE_CHAPTERS {
                    return Err(epub_content_limit(format!(
                        "spine chapter count exceeds the {MAX_EPUB_SPINE_CHAPTERS} chapter limit"
                    )));
                }
                aggregate_spine_bytes = aggregate_spine_bytes
                    .checked_add(uncompressed_size)
                    .ok_or_else(|| epub_content_limit("aggregate spine XHTML length overflows"))?;
                if aggregate_spine_bytes > MAX_EPUB_SPINE_UNCOMPRESSED_BYTES {
                    return Err(epub_content_limit(format!(
                        "aggregate spine XHTML exceeds the {MAX_EPUB_SPINE_UNCOMPRESSED_BYTES} byte limit"
                    )));
                }
                let size_estimate = usize::try_from(uncompressed_size).map_err(|_| {
                    epub_content_limit("spine document cannot be addressed on this platform")
                })?;

                spine.push(SpineEntry {
                    // Id by position in spine_paths, not the itemref index: a
                    // dangling idref (no manifest entry) is skipped, and using
                    // the raw index would desync every later ChapterId from
                    // its path in spine_paths.
                    id: ChapterId(spine_paths.len() as u32),
                    size_estimate,
                });
                spine_paths.push(full_path);
            }
        }

        // Load the EPUB 3 nav document once, if declared: it serves both the
        // TOC fallback (step 5) and landmarks (step 6).
        let nav_str: Option<String> = opf.nav_href.as_ref().and_then(|nav_href| {
            let nav_path = crate::import::resolve_relative_path(&opf_path, nav_href);
            read_content_entry(
                &source,
                &zip_index,
                &nav_path,
                crate::dom::MAX_DOCUMENT_XHTML_BYTES as u64,
                "navigation document",
            )
            .ok()
            .map(|nav_bytes| {
                let hint_encoding = crate::util::extract_xml_encoding(&nav_bytes);
                crate::util::decode_text(&nav_bytes, hint_encoding).into_owned()
            })
        });

        // 5. Parse TOC. The NCX is used when it yields entries (existing
        // behavior, kept for dual-TOC books to avoid churn); EPUB 3 makes the
        // nav document canonical and the NCX optional, so books without a
        // usable NCX fall back to `<nav epub:type="toc">`.
        let mut toc = if let Some(ncx_href) = &opf.ncx_href {
            let ncx_path = crate::import::resolve_relative_path(&opf_path, ncx_href);
            if let Ok(ncx_bytes) = read_content_entry(
                &source,
                &zip_index,
                &ncx_path,
                crate::dom::MAX_DOCUMENT_XHTML_BYTES as u64,
                "NCX document",
            ) {
                let hint_encoding = crate::util::extract_xml_encoding(&ncx_bytes);
                let ncx_str = crate::util::decode_text(&ncx_bytes, hint_encoding);
                // Navigation is auxiliary: a malformed NCX degrades to an
                // empty TOC (like a missing one) instead of failing the open.
                let toc_entries = parse_ncx(&ncx_str).unwrap_or_default();
                // Prepend base path to hrefs (NCX uses relative paths)
                prepend_base_to_toc(&toc_entries, &opf_base)
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        if toc.is_empty()
            && let Some(nav_str) = &nav_str
        {
            // Same leniency as the NCX: a malformed nav document must not
            // fail the whole book.
            let toc_entries = parse_nav_toc(nav_str).unwrap_or_default();
            toc = prepend_base_to_toc(&toc_entries, &opf_base);
        }

        // 6. Parse landmarks from EPUB 3 nav document
        let landmarks = if let Some(nav_str) = &nav_str {
            let mut parsed = parse_nav_landmarks(nav_str).unwrap_or_default();
            // Prepend base path to hrefs (nav uses relative, URL-encoded paths)
            for landmark in &mut parsed {
                if !landmark.href.starts_with('#') && !landmark.href.is_empty() {
                    landmark.href = crate::import::resolve_relative_path(&opf_path, &landmark.href);
                }
            }
            parsed
        } else {
            Vec::new()
        };

        // Build path -> ChapterId map
        let mut path_to_chapter = HashMap::new();
        for (i, path) in spine_paths.iter().enumerate() {
            // Store path without fragment
            let base_path = path.split('#').next().unwrap_or(path);
            path_to_chapter.insert(base_path.to_string(), ChapterId(i as u32));
        }

        // Resolve cover_image to an absolute (zip-relative) path so it matches
        // asset keys downstream. The OPF parser leaves it as a manifest href
        // relative to opf_base; like all manifest hrefs it may be
        // percent-encoded while asset keys are literal.
        let mut metadata = opf.metadata;
        if let Some(ref href) = metadata.cover_image
            && !href.is_empty()
        {
            metadata.cover_image = Some(crate::import::resolve_relative_path(&opf_path, href));
        }

        // Font obfuscation manifest (META-INF/encryption.xml), if any. Every
        // dc:identifier is a key candidate: the obfuscation key derives from
        // the package unique-identifier, which is not always the first (or
        // only) identifier declared.
        let obfuscated_fonts = read_content_entry(
            &source,
            &zip_index,
            "META-INF/encryption.xml",
            crate::dom::MAX_DOCUMENT_XHTML_BYTES as u64,
            "encryption document",
        )
        .map(|xml| {
            let identifiers = collect_identifiers(&opf_str);
            parse_encryption_xml(&xml, &identifiers, &opf_base)
        })
        .unwrap_or_default();

        Ok(Self {
            source,
            zip_index,
            metadata,
            toc,
            landmarks,
            spine,
            spine_paths,
            assets,
            path_to_chapter,
            anchor_map: RwLock::new(HashMap::new()),
            css_cache: RwLock::new(HashMap::new()),
            obfuscated_fonts,
        })
    }

    /// Read and decompress a ZIP entry by path.
    fn read_entry(&self, path: &str) -> crate::Result<Vec<u8>> {
        read_entry(&self.source, &self.zip_index, path)
    }
}

// ----------------------------------------------------------------------------
// ZIP IO Helpers
// ----------------------------------------------------------------------------

/// Read the classic ZIP central-directory headers with strict allocation
/// bounds before handing the archive to the general-purpose ZIP parser.
///
/// EPUB sources larger than the application's transfer ceiling are rejected by
/// the caller. This routine independently bounds the only regions it allocates
/// (the EOCD search tail and central directory), and it intentionally rejects
/// ZIP64 because none of the accepted resource limits require it.
fn preflight_archive(source: &dyn ByteSource) -> crate::Result<usize> {
    let source_len = source.len();
    if source_len < ZIP_EOCD_MIN_BYTES as u64 {
        return Err(epub_malformed(
            "archive has no end-of-central-directory record",
        ));
    }

    let tail_len = source_len.min(ZIP_EOCD_SEARCH_BYTES) as usize;
    let tail_offset = source_len - tail_len as u64;
    let tail = source.read_at(tail_offset, tail_len)?;
    let eocd_in_tail = (0..=tail.len() - ZIP_EOCD_MIN_BYTES)
        .rev()
        .find(|&offset| read_u32_le(&tail, offset) == Some(ZIP_EOCD_SIGNATURE))
        .ok_or_else(|| epub_malformed("archive has no end-of-central-directory record"))?;
    let eocd_offset = tail_offset + eocd_in_tail as u64;

    let disk = read_u16_le(&tail, eocd_in_tail + 4).unwrap();
    let central_disk = read_u16_le(&tail, eocd_in_tail + 6).unwrap();
    let entries_on_disk = read_u16_le(&tail, eocd_in_tail + 8).unwrap();
    let entry_count = read_u16_le(&tail, eocd_in_tail + 10).unwrap();
    let central_size = read_u32_le(&tail, eocd_in_tail + 12).unwrap() as u64;
    let central_offset = read_u32_le(&tail, eocd_in_tail + 16).unwrap() as u64;

    if disk != 0 || central_disk != 0 || entries_on_disk != entry_count {
        return Err(epub_malformed("multi-disk ZIP archives are not supported"));
    }
    if entry_count == u16::MAX
        || central_size == u32::MAX as u64
        || central_offset == u32::MAX as u64
    {
        return Err(epub_limit("ZIP64 archives are not supported"));
    }

    let entry_count = entry_count as usize;
    if entry_count > MAX_EPUB_ARCHIVE_ENTRIES {
        return Err(epub_limit(format!(
            "archive entry count exceeds the {MAX_EPUB_ARCHIVE_ENTRIES} entry limit"
        )));
    }
    if central_size > MAX_EPUB_CENTRAL_DIRECTORY_BYTES {
        return Err(epub_limit(format!(
            "central directory exceeds the {} byte limit",
            MAX_EPUB_CENTRAL_DIRECTORY_BYTES
        )));
    }
    let central_end = central_offset
        .checked_add(central_size)
        .ok_or_else(|| epub_malformed("central-directory range overflows"))?;
    if central_end > eocd_offset {
        return Err(epub_malformed(
            "central directory extends beyond its end record",
        ));
    }

    let central_size = usize::try_from(central_size)
        .map_err(|_| epub_limit("central directory cannot be addressed on this platform"))?;
    let central = source.read_at(central_offset, central_size)?;
    let mut cursor = 0usize;
    let mut aggregate_names = 0usize;
    let mut aggregate_uncompressed = 0u64;

    for _ in 0..entry_count {
        let fixed_end = cursor
            .checked_add(46)
            .ok_or_else(|| epub_malformed("central-directory entry range overflows"))?;
        if fixed_end > central.len()
            || read_u32_le(&central, cursor) != Some(ZIP_CENTRAL_ENTRY_SIGNATURE)
        {
            return Err(epub_malformed(
                "central-directory entry is truncated or invalid",
            ));
        }

        let compressed_size = read_u32_le(&central, cursor + 20).unwrap() as u64;
        let uncompressed_size = read_u32_le(&central, cursor + 24).unwrap() as u64;
        let name_len = read_u16_le(&central, cursor + 28).unwrap() as usize;
        let extra_len = read_u16_le(&central, cursor + 30).unwrap() as usize;
        let comment_len = read_u16_le(&central, cursor + 32).unwrap() as usize;
        let local_header_offset = read_u32_le(&central, cursor + 42).unwrap();

        if compressed_size == u32::MAX as u64
            || uncompressed_size == u32::MAX as u64
            || local_header_offset == u32::MAX
        {
            return Err(epub_limit("ZIP64 archive entries are not supported"));
        }
        if name_len == 0 {
            return Err(epub_malformed("archive entry has an empty name"));
        }
        if name_len > MAX_EPUB_ENTRY_NAME_BYTES {
            return Err(epub_limit(format!(
                "archive entry name exceeds the {MAX_EPUB_ENTRY_NAME_BYTES} byte limit"
            )));
        }

        aggregate_names = aggregate_names
            .checked_add(name_len)
            .ok_or_else(|| epub_limit("aggregate archive entry-name length overflows"))?;
        if aggregate_names > MAX_EPUB_ARCHIVE_NAME_BYTES {
            return Err(epub_limit(format!(
                "aggregate archive entry-name length exceeds the {} byte limit",
                MAX_EPUB_ARCHIVE_NAME_BYTES
            )));
        }

        aggregate_uncompressed = aggregate_uncompressed
            .checked_add(uncompressed_size)
            .ok_or_else(|| epub_limit("aggregate inflated size overflows"))?;
        if aggregate_uncompressed > MAX_EPUB_ARCHIVE_UNCOMPRESSED_BYTES {
            return Err(epub_limit(format!(
                "aggregate inflated size exceeds the {} byte limit",
                MAX_EPUB_ARCHIVE_UNCOMPRESSED_BYTES
            )));
        }
        if uncompressed_size > MAX_EPUB_ENTRY_UNCOMPRESSED_BYTES {
            return Err(epub_limit(format!(
                "one inflated entry exceeds the {} byte limit",
                MAX_EPUB_ENTRY_UNCOMPRESSED_BYTES
            )));
        }
        if (compressed_size == 0 && uncompressed_size > 0)
            || (compressed_size > 0
                && uncompressed_size / compressed_size > MAX_EPUB_COMPRESSION_RATIO)
        {
            return Err(epub_limit(format!(
                "archive entry exceeds the {MAX_EPUB_COMPRESSION_RATIO}:1 compression-ratio limit"
            )));
        }

        cursor = fixed_end
            .checked_add(name_len)
            .and_then(|value| value.checked_add(extra_len))
            .and_then(|value| value.checked_add(comment_len))
            .ok_or_else(|| epub_malformed("central-directory entry range overflows"))?;
        if cursor > central.len() {
            return Err(epub_malformed("central-directory entry is truncated"));
        }
    }

    Ok(entry_count)
}

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn epub_malformed(context: impl Into<String>) -> crate::Error {
    crate::Error::Malformed {
        format: crate::Format::Epub,
        context: context.into(),
    }
}

fn epub_limit(context: impl Into<String>) -> crate::Error {
    epub_malformed(format!("archive resource limit: {}", context.into()))
}

fn epub_content_limit(context: impl Into<String>) -> crate::Error {
    crate::Error::ResourceLimit {
        context: format!("EPUB content: {}", context.into()),
    }
}

fn read_entry(
    source: &Arc<dyn ByteSource>,
    index: &HashMap<String, ZipEntryLoc>,
    path: &str,
) -> crate::Result<Vec<u8>> {
    let loc = index.get(path).ok_or_else(|| crate::Error::NotFound {
        what: format!("{} (in EPUB archive)", path),
    })?;

    // Read compressed data via random access
    let compressed_size = usize::try_from(loc.compressed_size)
        .map_err(|_| epub_limit("compressed entry cannot be addressed on this platform"))?;
    let declared_size = usize::try_from(loc.uncompressed_size)
        .map_err(|_| epub_limit("inflated entry cannot be addressed on this platform"))?;
    let compressed = source.read_at(loc.data_offset, compressed_size)?;

    // Decompress
    match loc.compression {
        0 => {
            if compressed.len() != declared_size {
                return Err(epub_malformed(
                    "stored entry size does not match its central-directory declaration",
                ));
            }
            Ok(compressed)
        }
        8 => {
            // Deflate. The uncompressed size is an untrusted central-directory
            // field. The preflight has bounded its aggregate, and using the
            // declared entry size itself as the inflate cap ensures a size that
            // was under-declared cannot allocate past that aggregate budget.
            let out =
                crate::util::bounded_inflate(&compressed, loc.uncompressed_size, declared_size)?;
            if out.len() != declared_size {
                return Err(epub_malformed(
                    "inflated entry size does not match its central-directory declaration",
                ));
            }
            Ok(out)
        }
        method => Err(crate::Error::Malformed {
            format: crate::Format::Epub,
            context: format!("unsupported compression method: {}", method),
        }),
    }
}

fn read_content_entry(
    source: &Arc<dyn ByteSource>,
    index: &HashMap<String, ZipEntryLoc>,
    path: &str,
    limit: u64,
    description: &str,
) -> crate::Result<Vec<u8>> {
    let loc = index.get(path).ok_or_else(|| crate::Error::NotFound {
        what: format!("{} (in EPUB archive)", path),
    })?;
    if loc.uncompressed_size > limit {
        return Err(epub_content_limit(format!(
            "{description} exceeds the {limit} byte limit"
        )));
    }
    read_entry(source, index, path)
}

// ============================================================================
// Font deobfuscation (OCF §Resource Obfuscation)
// ============================================================================

/// How an asset is obfuscated: candidate XOR keys (one per identifier the
/// key could derive from) and how many leading bytes they cover.
pub(crate) struct FontObfuscation {
    candidates: Vec<Vec<u8>>,
    prefix_len: usize,
}

const IDPF_ALGORITHM: &str = "http://www.idpf.org/2008/embedding";
const ADOBE_ALGORITHM: &str = "http://ns.adobe.com/pdf/enc#RC";

/// Every dc:identifier value in the OPF. The obfuscation key derives from
/// the package unique-identifier, which is not reliably the first
/// identifier, so all of them become key candidates (validated by font
/// magic on use).
fn collect_identifiers(opf_str: &str) -> Vec<String> {
    use quick_xml::Reader;
    use quick_xml::events::Event;

    let mut reader = Reader::from_str(opf_str);
    let mut identifiers = Vec::new();
    let mut in_identifier = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.name().local_name().as_ref() == b"identifier" => {
                in_identifier = true;
            }
            Ok(Event::Text(t)) if in_identifier => {
                let text = t.xml_content().unwrap_or_default().trim().to_string();
                if !text.is_empty() {
                    identifiers.push(text);
                }
            }
            Ok(Event::End(e)) if e.name().local_name().as_ref() == b"identifier" => {
                in_identifier = false;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    identifiers
}

/// Parse META-INF/encryption.xml into a path → obfuscation map.
///
/// Only the two font-obfuscation schemes are handled (IDPF and Adobe);
/// entries with other algorithms (true DRM) are ignored — those assets pass
/// through untouched, as before. Each referenced URI is indexed both as
/// written (container-root-relative per spec) and resolved against the OPF
/// directory (a common real-world deviation).
fn parse_encryption_xml(
    xml: &[u8],
    identifiers: &[String],
    opf_base: &str,
) -> HashMap<String, FontObfuscation> {
    use quick_xml::Reader;
    use quick_xml::events::Event;

    let content = String::from_utf8_lossy(xml);
    let mut reader = Reader::from_str(&content);

    let mut fonts = HashMap::new();
    let mut current_algorithm: Option<&'static str> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.name();
                let local = name.local_name();
                if local.as_ref() == b"EncryptionMethod" {
                    current_algorithm = e.attributes().flatten().find_map(|a| {
                        if a.key.local_name().as_ref() != b"Algorithm" {
                            return None;
                        }
                        let value: &[u8] = &a.value;
                        match value {
                            v if v == IDPF_ALGORITHM.as_bytes() => Some(IDPF_ALGORITHM),
                            v if v == ADOBE_ALGORITHM.as_bytes() => Some(ADOBE_ALGORITHM),
                            _ => None,
                        }
                    });
                } else if local.as_ref() == b"CipherReference"
                    && let Some(algorithm) = current_algorithm
                    && let Some(uri) = e.attributes().flatten().find_map(|a| {
                        (a.key.local_name().as_ref() == b"URI")
                            .then(|| String::from_utf8_lossy(&a.value).to_string())
                    })
                {
                    // URIs may be percent-encoded; archive names are literal.
                    let path = percent_encoding::percent_decode_str(&uri)
                        .decode_utf8_lossy()
                        .to_string();
                    let (candidates, prefix_len): (Vec<Vec<u8>>, usize) = match algorithm {
                        IDPF_ALGORITHM => {
                            (identifiers.iter().map(|id| idpf_key(id)).collect(), 1040)
                        }
                        _ => (
                            identifiers.iter().filter_map(|id| adobe_key(id)).collect(),
                            1024,
                        ),
                    };
                    let candidates: Vec<Vec<u8>> =
                        candidates.into_iter().filter(|k| !k.is_empty()).collect();
                    if !candidates.is_empty() {
                        for key_path in [path.clone(), format!("{opf_base}{path}")] {
                            fonts.insert(
                                key_path,
                                FontObfuscation {
                                    candidates: candidates.clone(),
                                    prefix_len,
                                },
                            );
                        }
                    }
                }
            }
            Ok(Event::End(e)) if e.name().local_name().as_ref() == b"EncryptedData" => {
                current_algorithm = None;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    fonts
}

/// IDPF key: SHA-1 of the unique identifier with whitespace removed.
fn idpf_key(identifier: &str) -> Vec<u8> {
    let cleaned: String = identifier
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\r' | '\n'))
        .collect();
    if cleaned.is_empty() {
        return Vec::new();
    }
    sha1_smol::Sha1::from(cleaned.as_bytes())
        .digest()
        .bytes()
        .to_vec()
}

/// Adobe key: the 16 bytes of the identifier's UUID (hex digits only).
fn adobe_key(identifier: &str) -> Option<Vec<u8>> {
    let hex: String = identifier
        .rsplit(':')
        .next()
        .unwrap_or(identifier)
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    if hex.len() != 32 {
        return None;
    }
    (0..16)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

const FONT_MAGICS: [&[u8]; 6] = [
    &[0x00, 0x01, 0x00, 0x00], // TrueType
    b"OTTO",                   // CFF OpenType
    b"true",                   // legacy TrueType
    b"ttcf",                   // TrueType collection
    b"wOFF",
    b"wOF2",
];

/// XOR the obfuscated prefix back to plain bytes, trying each candidate key
/// until the result looks like a font. If none do, the key derives from an
/// identifier that is no longer in the OPF and the original bytes are
/// returned unchanged — no worse than before.
fn deobfuscate_font(data: Vec<u8>, obfuscation: &FontObfuscation) -> Vec<u8> {
    // Already plain? Some books list unobfuscated fonts in encryption.xml.
    if FONT_MAGICS.iter().any(|magic| data.starts_with(magic)) {
        return data;
    }
    let end = obfuscation.prefix_len.min(data.len());
    for key in &obfuscation.candidates {
        let mut attempt = data.clone();
        for (i, byte) in attempt[..end].iter_mut().enumerate() {
            *byte ^= key[i % key.len()];
        }
        if FONT_MAGICS.iter().any(|magic| attempt.starts_with(magic)) {
            return attempt;
        }
    }
    data
}

fn compression_to_u16(method: zip::CompressionMethod) -> u16 {
    match method {
        zip::CompressionMethod::Stored => 0,
        zip::CompressionMethod::Deflated => 8,
        _ => 255,
    }
}

/// Prepend base path to TOC entry hrefs (NCX/nav use relative paths).
///
/// TOC hrefs are URLs: percent-escapes are decoded here (path and fragment
/// separately) so the stored hrefs match literal archive entry names.
fn prepend_base_to_toc(entries: &[TocEntry], base: &str) -> Vec<TocEntry> {
    entries
        .iter()
        .map(|entry| {
            let href = if entry.href.is_empty() {
                entry.href.clone()
            } else if entry.href.starts_with('#') {
                crate::util::percent_decode_href(&entry.href).into_owned()
            } else {
                crate::import::resolve_relative_path(base, &entry.href)
            };
            TocEntry {
                title: entry.title.clone(),
                href,
                children: prepend_base_to_toc(&entry.children, base),
                play_order: entry.play_order,
                target: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::MemorySource;

    #[derive(Clone)]
    struct CentralClaim {
        name: Vec<u8>,
        compressed_size: u32,
        uncompressed_size: u32,
    }

    fn central_only_archive(claims: impl IntoIterator<Item = CentralClaim>) -> Vec<u8> {
        let claims: Vec<CentralClaim> = claims.into_iter().collect();
        let mut central = Vec::new();
        for claim in &claims {
            central.extend_from_slice(&ZIP_CENTRAL_ENTRY_SIGNATURE.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes()); // version made by
            central.extend_from_slice(&20u16.to_le_bytes()); // version needed
            central.extend_from_slice(&0u16.to_le_bytes()); // flags
            central.extend_from_slice(&0u16.to_le_bytes()); // stored
            central.extend_from_slice(&0u16.to_le_bytes()); // time
            central.extend_from_slice(&0u16.to_le_bytes()); // date
            central.extend_from_slice(&0u32.to_le_bytes()); // CRC-32
            central.extend_from_slice(&claim.compressed_size.to_le_bytes());
            central.extend_from_slice(&claim.uncompressed_size.to_le_bytes());
            central.extend_from_slice(&(claim.name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // extra length
            central.extend_from_slice(&0u16.to_le_bytes()); // comment length
            central.extend_from_slice(&0u16.to_le_bytes()); // disk start
            central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // local header offset
            central.extend_from_slice(&claim.name);
        }

        let entry_count = u16::try_from(claims.len()).unwrap();
        let central_size = u32::try_from(central.len()).unwrap();
        let mut bytes = central;
        bytes.extend_from_slice(&ZIP_EOCD_SIGNATURE.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes()); // disk
        bytes.extend_from_slice(&0u16.to_le_bytes()); // central disk
        bytes.extend_from_slice(&entry_count.to_le_bytes());
        bytes.extend_from_slice(&entry_count.to_le_bytes());
        bytes.extend_from_slice(&central_size.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes()); // central offset
        bytes.extend_from_slice(&0u16.to_le_bytes()); // comment length
        bytes
    }

    fn preflight_error(bytes: Vec<u8>) -> String {
        preflight_archive(&MemorySource::new(bytes))
            .expect_err("hostile archive should fail preflight")
            .to_string()
    }

    #[test]
    fn epub_preflight_rejects_entry_count_before_reading_central_directory() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&ZIP_EOCD_SIGNATURE.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&((MAX_EPUB_ARCHIVE_ENTRIES + 1) as u16).to_le_bytes());
        bytes.extend_from_slice(&((MAX_EPUB_ARCHIVE_ENTRIES + 1) as u16).to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());

        let error = preflight_error(bytes);
        assert!(error.contains("archive entry count exceeds the 20000 entry limit"));
    }

    #[test]
    fn epub_preflight_rejects_aggregate_inflated_size_without_inflating_data() {
        let claim = CentralClaim {
            name: b"asset.bin".to_vec(),
            // A plausible ratio keeps this test focused on the aggregate.
            compressed_size: 128 * 1024,
            uncompressed_size: 100 * 1024 * 1024,
        };
        let error = preflight_error(central_only_archive([claim.clone(), claim.clone(), claim]));
        assert!(error.contains("aggregate inflated size exceeds the 268435456 byte limit"));
    }

    #[test]
    fn epub_preflight_rejects_one_oversized_inflated_entry() {
        let error = preflight_error(central_only_archive([CentralClaim {
            name: b"asset.bin".to_vec(),
            compressed_size: 256 * 1024,
            uncompressed_size: 129 * 1024 * 1024,
        }]));
        assert!(error.contains("one inflated entry exceeds the 134217728 byte limit"));
    }

    #[test]
    fn epub_preflight_rejects_one_pathological_entry_name() {
        let error = preflight_error(central_only_archive([CentralClaim {
            name: vec![b'x'; MAX_EPUB_ENTRY_NAME_BYTES + 1],
            compressed_size: 0,
            uncompressed_size: 0,
        }]));
        assert!(error.contains("archive entry name exceeds the 2048 byte limit"));
    }

    #[test]
    fn epub_preflight_rejects_pathological_aggregate_entry_names() {
        let name_count = MAX_EPUB_ARCHIVE_NAME_BYTES / MAX_EPUB_ENTRY_NAME_BYTES + 1;
        let claims = (0..name_count).map(|index| {
            let mut name = format!("{index:08x}").into_bytes();
            name.resize(MAX_EPUB_ENTRY_NAME_BYTES, b'x');
            CentralClaim {
                name,
                compressed_size: 0,
                uncompressed_size: 0,
            }
        });
        let error = preflight_error(central_only_archive(claims));
        assert!(
            error.contains("aggregate archive entry-name length exceeds the 8388608 byte limit")
        );
    }

    #[test]
    fn test_prepend_base_to_toc_simple() {
        let entries = vec![
            TocEntry::new("Chapter 1", "text/ch1.xhtml"),
            TocEntry::new("Chapter 2", "text/ch2.xhtml"),
        ];

        let result = prepend_base_to_toc(&entries, "OEBPS/");

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].href, "OEBPS/text/ch1.xhtml");
        assert_eq!(result[1].href, "OEBPS/text/ch2.xhtml");
    }

    #[test]
    fn test_prepend_base_to_toc_with_fragments() {
        let entries = vec![
            TocEntry::new("Section 1", "text/ch1.xhtml#section1"),
            TocEntry::new("Section 2", "text/ch1.xhtml#section2"),
        ];

        let result = prepend_base_to_toc(&entries, "epub/");

        assert_eq!(result[0].href, "epub/text/ch1.xhtml#section1");
        assert_eq!(result[1].href, "epub/text/ch1.xhtml#section2");
    }

    #[test]
    fn test_prepend_base_to_toc_preserves_anchor_only() {
        let entries = vec![
            TocEntry::new("Internal Link", "#footnote1"),
            TocEntry::new("Empty", ""),
        ];

        let result = prepend_base_to_toc(&entries, "OEBPS/");

        // Anchor-only hrefs should not be modified
        assert_eq!(result[0].href, "#footnote1");
        // Empty hrefs should not be modified
        assert_eq!(result[1].href, "");
    }

    #[test]
    fn test_prepend_base_to_toc_nested() {
        let mut parent = TocEntry::new("Part I", "text/part1.xhtml");
        parent.children = vec![
            TocEntry::new("Chapter 1", "text/ch1.xhtml"),
            TocEntry::new("Chapter 2", "text/ch2.xhtml"),
        ];
        let entries = vec![parent];

        let result = prepend_base_to_toc(&entries, "epub/");

        assert_eq!(result[0].href, "epub/text/part1.xhtml");
        assert_eq!(result[0].children.len(), 2);
        assert_eq!(result[0].children[0].href, "epub/text/ch1.xhtml");
        assert_eq!(result[0].children[1].href, "epub/text/ch2.xhtml");
    }

    #[test]
    fn test_prepend_base_to_toc_deeply_nested() {
        let grandchild = TocEntry::new("Section", "text/ch1.xhtml#sec1");
        let mut child = TocEntry::new("Chapter 1", "text/ch1.xhtml");
        child.children = vec![grandchild];
        let mut parent = TocEntry::new("Part I", "text/part1.xhtml");
        parent.children = vec![child];
        let entries = vec![parent];

        let result = prepend_base_to_toc(&entries, "content/");

        assert_eq!(result[0].href, "content/text/part1.xhtml");
        assert_eq!(result[0].children[0].href, "content/text/ch1.xhtml");
        assert_eq!(
            result[0].children[0].children[0].href,
            "content/text/ch1.xhtml#sec1"
        );
    }
}
