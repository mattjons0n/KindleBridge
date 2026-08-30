use super::*;

/// Build position_map fragment ($264).
///
/// Maps each section to the list of EIDs it contains. This enables
/// the Kindle reader to track which section contains a given position.
pub(super) fn build_position_map_fragment(ctx: &ExportContext) -> KfxFragment {
    let mut entries = Vec::new();

    // Handle standalone cover section (c0) if present
    // Cover contains both the page_template ID and the storyline content ID
    if let Some(cover_fid) = ctx.cover_fragment_id {
        // Build contains list: [section_id, content_id]
        let mut contains_list = vec![IonValue::Int(cover_fid as i64)];
        if let Some(content_id) = ctx.cover_content_id {
            contains_list.push(IonValue::Int(content_id as i64));
        }
        let entry = IonValue::Struct(vec![
            (KfxSymbol::Contains as u64, IonValue::List(contains_list)),
            (
                KfxSymbol::SectionName as u64,
                IonValue::Symbol(ctx.section_ids[0]),
            ),
        ]);
        entries.push(entry);
    }

    // Build entries for spine chapters, pairing each section with its chapter
    // by key rather than by positional index: a chapter that failed to load
    // has no entry in `chapter_fragments`, and index-based pairing would
    // shift every later section onto the wrong chapter's EIDs.
    for &(section_sym, chapter_id) in &ctx.spine_section_chapters {
        // Skipped/unloadable chapter: emit no entry rather than a wrong one.
        let Some(&fragment_id) = ctx.chapter_fragments.get(&chapter_id) else {
            continue;
        };

        let mut eid_list = Vec::new();

        // Include page_template ID first (required for section start images)
        eid_list.push(IonValue::Int(fragment_id as i64));

        // Add all content fragment IDs for this chapter
        if let Some(content_ids) = ctx.content_ids_by_chapter.get(&chapter_id) {
            for &content_id in content_ids {
                eid_list.push(IonValue::Int(content_id as i64));
            }
        }

        let entry = IonValue::Struct(vec![
            (KfxSymbol::Contains as u64, IonValue::List(eid_list)),
            (KfxSymbol::SectionName as u64, IonValue::Symbol(section_sym)),
        ]);
        entries.push(entry);
    }

    let ion = IonValue::List(entries);
    KfxFragment::singleton(KfxSymbol::PositionMap, ion)
}

/// One entry in the book's ordered position stream.
struct PositionChunk {
    /// Element id.
    eid: u64,
    /// Position count this element covers (chars for text, 1 for rendered
    /// elements and page templates).
    length: i64,
    /// Ordinal of the section this element belongs to.
    section: usize,
}

/// The ordered position stream backing both `$265` and `$550`.
///
/// Reading order, exactly as the renderer walks the book: for each section,
/// its page-template eid (one position) followed by its content eids. This
/// matches the reference position accounting — omitting the page-template
/// eids (or ordering by fragment id rather than reading order) makes every
/// later pid disagree with what the reader computes.
fn position_chunks(ctx: &ExportContext) -> Vec<PositionChunk> {
    let content_len = |eid: u64| -> i64 {
        ctx.content_id_lengths
            .get(&eid)
            .copied()
            .unwrap_or(1)
            .max(1) as i64
    };

    let mut chunks = Vec::new();
    let mut section = 0usize;

    // Standalone cover section (c0): page template, then the cover image.
    if let Some(cover_fid) = ctx.cover_fragment_id {
        chunks.push(PositionChunk {
            eid: cover_fid,
            length: 1,
            section,
        });
        if let Some(content_id) = ctx.cover_content_id {
            chunks.push(PositionChunk {
                eid: content_id,
                length: content_len(content_id),
                section,
            });
        }
        section += 1;
    }

    // Spine sections in reading order, pairing each with its chapter by key
    // (an unloadable chapter has no fragment id and must not shift others).
    for &(_, chapter_id) in &ctx.spine_section_chapters {
        let Some(&fragment_id) = ctx.chapter_fragments.get(&chapter_id) else {
            continue;
        };
        chunks.push(PositionChunk {
            eid: fragment_id,
            length: 1,
            section,
        });
        if let Some(content_ids) = ctx.content_ids_by_chapter.get(&chapter_id) {
            for &eid in content_ids {
                chunks.push(PositionChunk {
                    eid,
                    length: content_len(eid),
                    section,
                });
            }
        }
        section += 1;
    }

    chunks
}

/// Iterate `(eid, length, start_pid)` over the book's position stream.
/// Shared with the page-list generator in navigation.rs.
pub(super) fn page_position_chunks(ctx: &ExportContext) -> Vec<(u64, i64, i64)> {
    let mut out = Vec::new();
    let mut pid = 0i64;
    for chunk in position_chunks(ctx) {
        out.push((chunk.eid, chunk.length, pid));
        pid += chunk.length;
    }
    out
}

/// Build position_id_map fragment ($265).
///
/// Maps cumulative positions (PIDs) to EIDs, walking the position stream in
/// reading order. Terminated by the required `{eid: 0, pid: total}` entry.
pub(super) fn build_position_id_map_fragment(ctx: &ExportContext) -> KfxFragment {
    let mut entries = Vec::new();
    let mut pid = 0i64;

    for chunk in position_chunks(ctx) {
        // Note: eid comes first, then pid - matching Amazon's format
        entries.push(IonValue::Struct(vec![
            (KfxSymbol::Eid as u64, IonValue::Int(chunk.eid as i64)),
            (KfxSymbol::Pid as u64, IonValue::Int(pid)),
        ]));
        pid += chunk.length;
    }

    // Add terminator entry with eid=0 and pid=max_pid
    // This is required by Amazon's format to indicate the end of content
    // and provides the max position ID for location count calculation
    entries.push(IonValue::Struct(vec![
        (KfxSymbol::Eid as u64, IonValue::Int(0)),
        (KfxSymbol::Pid as u64, IonValue::Int(pid)),
    ]));

    let ion = IonValue::List(entries);
    KfxFragment::singleton(KfxSymbol::PositionIdMap, ion)
}

/// Interior location cadence within a single element.
///
/// Observed contract of Kindle Previewer output: a location at every element
/// start, plus one every 150 positions inside long elements — consecutive
/// locations are never more than 150 positions apart. (kfxlib's regenerator
/// uses a flat 110-position cadence instead; the element-aligned rule matches
/// real Previewer output far more closely — 97% count parity on a reference
/// comparison book.)
const KFX_POSITIONS_PER_LOCATION: i64 = 150;

/// Build location_map fragment ($550).
///
/// One location per element start plus interior fills every
/// [`KFX_POSITIONS_PER_LOCATION`] positions inside long elements.
pub(super) fn build_location_map_fragment(ctx: &ExportContext) -> KfxFragment {
    let mut location_entries = Vec::new();

    for chunk in position_chunks(ctx) {
        let mut offset = 0i64;
        while offset < chunk.length.max(1) {
            location_entries.push(IonValue::Struct(vec![
                (KfxSymbol::Id as u64, IonValue::Int(chunk.eid as i64)),
                (KfxSymbol::Offset as u64, IonValue::Int(offset)),
            ]));
            offset += KFX_POSITIONS_PER_LOCATION;
        }
    }

    // Wrap in locations list structure
    let ion = IonValue::List(vec![IonValue::Struct(vec![(
        KfxSymbol::Locations as u64,
        IonValue::List(location_entries),
    )])]);

    KfxFragment::singleton(KfxSymbol::LocationMap, ion)
}

/// Build container_entity_map fragment ($419).
///
/// Lists all entities in the container for the reader to enumerate, plus an
/// `entity_dependencies` graph that tells Kindle how sections reach their
/// image data: section → external_resource → bcRawMedia location.
pub(super) fn build_container_entity_map_fragment(
    container_id: &str,
    fragments: &[KfxFragment],
    ctx: &ExportContext,
) -> KfxFragment {
    // Collect all non-singleton entity name symbols (including bcRawMedia
    // location strings — Kindle requires these so it can resolve resource
    // dependencies).
    let mut entity_names: Vec<IonValue> = Vec::new();

    for frag in fragments {
        if frag.fid.starts_with('$') {
            continue;
        }
        if let Some(symbol_id) = ctx.symbols.get(&frag.fid) {
            entity_names.push(IonValue::Symbol(symbol_id));
        }
    }

    let container_entry = IonValue::Struct(vec![
        (
            KfxSymbol::Id as u64,
            IonValue::String(container_id.to_string()),
        ),
        (KfxSymbol::Contains as u64, IonValue::List(entity_names)),
    ]);

    // Build entity_dependencies: section → [resource short names], and
    // external_resource → ['resource/<name>'] (the bcRawMedia symbol).
    let mut dependencies: Vec<IonValue> = Vec::new();

    for (section_name, short_names) in &ctx.section_resource_deps {
        if short_names.is_empty() {
            continue;
        }
        let Some(section_sym) = ctx.symbols.get(section_name) else {
            continue;
        };
        let deps: Vec<IonValue> = short_names
            .iter()
            .filter_map(|n| ctx.symbols.get(n).map(IonValue::Symbol))
            .collect();
        if deps.is_empty() {
            continue;
        }
        dependencies.push(IonValue::Struct(vec![
            (KfxSymbol::Id as u64, IonValue::Symbol(section_sym)),
            (
                KfxSymbol::MandatoryDependencies as u64,
                IonValue::List(deps),
            ),
        ]));
    }

    // Collect every distinct resource short name actually used and emit its
    // bcRawMedia location as a dependency.
    let mut all_short_names: BTreeSet<&String> = BTreeSet::new();
    for short_names in ctx.section_resource_deps.values() {
        for n in short_names {
            all_short_names.insert(n);
        }
    }
    for short_name in all_short_names {
        let Some(resource_sym) = ctx.symbols.get(short_name) else {
            continue;
        };
        let raw_name = format!("resource/{short_name}");
        let Some(raw_sym) = ctx.symbols.get(&raw_name) else {
            continue;
        };
        dependencies.push(IonValue::Struct(vec![
            (KfxSymbol::Id as u64, IonValue::Symbol(resource_sym)),
            (
                KfxSymbol::MandatoryDependencies as u64,
                IonValue::List(vec![IonValue::Symbol(raw_sym)]),
            ),
        ]));
    }

    let mut ion_fields = vec![(
        KfxSymbol::ContainerList as u64,
        IonValue::List(vec![container_entry]),
    )];
    if !dependencies.is_empty() {
        ion_fields.push((
            KfxSymbol::EntityDependencies as u64,
            IonValue::List(dependencies),
        ));
    }
    let ion = IonValue::Struct(ion_fields);

    KfxFragment::singleton(KfxSymbol::ContainerEntityMap, ion)
}

/// Largest per-section position count in the book.
///
/// Sections above 65536 positions need the `reflow-section-size` content
/// feature declared (see `build_content_features_fragment`); without it the
/// renderer's position handling overflows deep into the section — paging
/// crashes partway through long chapters, and "go to page" crashes outright.
pub(super) fn max_section_position_count(ctx: &ExportContext) -> i64 {
    let mut per_section: Vec<i64> = Vec::new();
    for chunk in position_chunks(ctx) {
        if per_section.len() <= chunk.section {
            per_section.resize(chunk.section + 1, 0);
        }
        per_section[chunk.section] += chunk.length;
    }
    per_section.into_iter().max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ChapterId;
    use crate::kfx::fragment::FragmentData;

    /// Extract (section_symbol, contains_eids) pairs from a position_map fragment.
    fn extract_entries(frag: &KfxFragment) -> Vec<(u64, Vec<i64>)> {
        let FragmentData::Ion(IonValue::List(entries)) = &frag.data else {
            panic!("expected Ion list fragment data");
        };
        entries
            .iter()
            .map(|entry| {
                let IonValue::Struct(fields) = entry else {
                    panic!("expected struct entry");
                };
                let mut section = None;
                let mut eids = Vec::new();
                for (id, value) in fields {
                    if *id == KfxSymbol::SectionName as u64 {
                        if let IonValue::Symbol(s) = value {
                            section = Some(*s);
                        }
                    } else if *id == KfxSymbol::Contains as u64
                        && let IonValue::List(list) = value
                    {
                        for item in list {
                            if let IonValue::Int(i) = item {
                                eids.push(*i);
                            }
                        }
                    }
                }
                (section.expect("entry must have section_name"), eids)
            })
            .collect()
    }

    /// Extract (eid, offset) pairs from a location_map fragment.
    fn extract_locations(frag: &KfxFragment) -> Vec<(i64, i64)> {
        let FragmentData::Ion(IonValue::List(outer)) = &frag.data else {
            panic!("expected list");
        };
        let IonValue::Struct(fields) = &outer[0] else {
            panic!("expected struct");
        };
        let (_, IonValue::List(entries)) = fields
            .iter()
            .find(|(id, _)| *id == KfxSymbol::Locations as u64)
            .expect("locations field")
        else {
            panic!("expected list");
        };
        entries
            .iter()
            .map(|e| {
                let IonValue::Struct(f) = e else { panic!() };
                let mut id = 0;
                let mut off = 0;
                for (k, v) in f {
                    if let IonValue::Int(n) = v {
                        if *k == KfxSymbol::Id as u64 {
                            id = *n;
                        } else if *k == KfxSymbol::Offset as u64 {
                            off = *n;
                        }
                    }
                }
                (id, off)
            })
            .collect()
    }

    /// Kindle Previewer's observed location contract: a location at every
    /// element start, plus one every 150 positions inside long elements —
    /// consecutive locations are never more than 150 positions apart.
    #[test]
    fn location_map_marks_element_starts_and_150_interior_fills() {
        let mut ctx = ExportContext::new();
        let ch = ChapterId(1);
        ctx.register_spine_section("c0", ch);
        ctx.chapter_fragments.insert(ch, 90);
        ctx.content_ids_by_chapter.insert(ch, vec![100, 101, 102]);
        ctx.content_id_lengths.insert(100, 40); // short text
        ctx.content_id_lengths.insert(101, 380); // long text: 2 interior fills
        ctx.content_id_lengths.insert(102, 1); // image

        let frag = build_location_map_fragment(&ctx);
        let locs = extract_locations(&frag);

        assert_eq!(
            locs,
            vec![
                (90, 0),    // page template start
                (100, 0),   // element start
                (101, 0),   // element start
                (101, 150), // interior fill
                (101, 300), // interior fill
                (102, 0),   // element start
            ]
        );
    }

    #[test]
    fn position_map_pairs_sections_with_chapters_by_key() {
        let mut ctx = ExportContext::new();
        let (ch1, ch2, ch3) = (ChapterId(1), ChapterId(2), ChapterId(3));
        let c0 = ctx.register_spine_section("c0", ch1);
        let c1 = ctx.register_spine_section("c1", ch2);
        let c2 = ctx.register_spine_section("c2", ch3);

        ctx.chapter_fragments.insert(ch1, 90);
        ctx.chapter_fragments.insert(ch2, 95);
        ctx.chapter_fragments.insert(ch3, 100);
        ctx.content_ids_by_chapter.insert(ch1, vec![91]);
        ctx.content_ids_by_chapter.insert(ch2, vec![96, 97]);
        ctx.content_ids_by_chapter.insert(ch3, vec![101]);

        let frag = build_position_map_fragment(&ctx);
        let entries = extract_entries(&frag);
        assert_eq!(
            entries,
            vec![
                (c0, vec![90, 91]),
                (c1, vec![95, 96, 97]),
                (c2, vec![100, 101]),
            ]
        );
    }

    #[test]
    fn position_map_skips_failed_chapter_without_shifting_sections() {
        // Simulate chapter 2 failing to load: its spine section was
        // registered, but the chapter was never surveyed, so it has no
        // fragment ID and no content IDs.
        let mut ctx = ExportContext::new();
        let (ch1, ch2, ch3) = (ChapterId(1), ChapterId(2), ChapterId(3));
        let c0 = ctx.register_spine_section("c0", ch1);
        let _c1 = ctx.register_spine_section("c1", ch2);
        let c2 = ctx.register_spine_section("c2", ch3);

        // Only chapters 1 and 3 were surveyed successfully.
        ctx.chapter_fragments.insert(ch1, 90);
        ctx.chapter_fragments.insert(ch3, 100);
        ctx.content_ids_by_chapter.insert(ch1, vec![91]);
        ctx.content_ids_by_chapter.insert(ch3, vec![101]);

        let frag = build_position_map_fragment(&ctx);
        let entries = extract_entries(&frag);

        // The failed chapter's section produces no entry, and — critically —
        // section c2 still maps to chapter 3's EIDs. (The old positional
        // pairing would have placed chapter 3's EIDs under section c1.)
        assert_eq!(entries, vec![(c0, vec![90, 91]), (c2, vec![100, 101])]);
    }
}
