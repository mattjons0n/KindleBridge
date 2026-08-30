//! End-to-end AZW3 export of a book large enough to force multi-record
//! index splitting.
//!
//! The KF8 writer stores INDX entry data behind u16 IDXT offsets and CNCX
//! labels behind offsets whose low 16 bits address within a single record, so
//! books with ~2800+ chunks or >64 KB of index labels must be split across
//! multiple INDX data records / CNCX records (offset convention:
//! `record_number << 16 | offset_within_record`). Before the split was
//! implemented these books failed export with an InvalidData error (and
//! before that, silently produced corrupt files).
//!
//! This book forces every split at production thresholds:
//! - 3500 spine files -> 3500 chunks (>2800), splitting both the skeleton and
//!   chunk/fragment INDX entry data past one 64 KB data record;
//! - the chunk selectors (~22 bytes x 3500) exceed one CNCX record;
//! - 3500 NCX entries split the NCX INDX entry data;
//! - the long TOC titles (~70 bytes x 3500) span several NCX CNCX records.

mod common;

use boko::model::Format;
use common::{Doc, EpubBuilder, Nav, count_toc, export_to_bytes, roundtrip};

const CHAPTERS: usize = 3500;

// The fixture must stay in the >2800-chunk regime (one chunk per spine file)
// that forces the skeleton and chunk indexes past a single INDX data record.
const _: () = assert!(CHAPTERS > 2800);

fn chapter_title(i: usize) -> String {
    format!("Chapter {i:04} of the Extraordinarily Verbose Compendium of Split Indexes")
}

#[test]
fn azw3_export_splits_large_indexes_and_roundtrips() {
    let mut builder = EpubBuilder::new("Large Split Book");
    let mut nav = Vec::new();
    for i in 0..CHAPTERS {
        let file = format!("text/ch{i:04}.xhtml");
        let title = chapter_title(i);
        // Unique markers in the first, a middle, and the last chapter guard
        // against whole chapters silently vanishing.
        let marker = match i {
            0 => " The aardwolfen prowls here.",
            1750 => " The midpointer balances here.",
            i if i == CHAPTERS - 1 => " The zymurgist ferments here.",
            _ => "",
        };
        let body = format!(
            "<h1 id=\"c{i}\">{title}</h1>\
             <p>Body paragraph of chapter {i} with enough prose to be a real \
             chunk of content.{marker}</p>"
        );
        builder = builder.doc(Doc::new(&file, &title, &body));
        nav.push(Nav::new(&title, &format!("{file}#c{i}")));
    }
    let builder = builder.nav(nav);

    // Sanity-check that this book actually exceeds the single-record limits,
    // so the test keeps forcing the split paths if the fixture is ever tuned.
    let title_bytes: usize = (0..CHAPTERS).map(|i| chapter_title(i).len() + 2).sum();
    assert!(
        title_bytes > 2 * 0x10000,
        "fixture must overflow multiple CNCX records ({title_bytes} bytes of labels)"
    );

    let mut book = builder.book();
    assert_eq!(book.spine().len(), CHAPTERS);
    assert_eq!(count_toc(book.toc()), CHAPTERS);

    // Export to AZW3 (this errored with InvalidData before multi-record
    // splitting) and import the result back with boko.
    let mut rt = roundtrip(&mut book, Format::Azw3);

    // Structure survives: one spine part and one TOC entry per chapter.
    assert_eq!(
        rt.spine().len(),
        CHAPTERS,
        "spine length must survive the multi-record skeleton index"
    );
    assert_eq!(
        count_toc(rt.toc()),
        CHAPTERS,
        "TOC entry count must survive the multi-record NCX index"
    );

    // TOC titles must resolve to the *right* strings, including entries whose
    // CNCX offsets land in the second and later records. An off-by-one in the
    // record rollover would scramble or drop these.
    let toc = rt.toc();
    for i in [0, 1, 1170, 1750, 2339, 3000, CHAPTERS - 1] {
        assert_eq!(
            toc[i].title,
            chapter_title(i),
            "TOC title {i} must match (CNCX record-boundary regression)"
        );
    }

    // Text from the start, middle, and end of the book survives.
    let markdown = String::from_utf8(export_to_bytes(&mut rt, Format::Markdown))
        .expect("markdown output is utf-8");
    for marker in ["aardwolfen", "midpointer", "zymurgist"] {
        assert!(
            markdown.contains(marker),
            "marker {marker:?} lost in AZW3 roundtrip"
        );
    }
}
