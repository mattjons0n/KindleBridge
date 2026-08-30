//! Diverse-corpus roundtrip tests.
//!
//! Builds small EPUBs exercising document shapes the single `epictetus` fixture
//! lacks (tables, footnotes, images, nested lists, complex CSS, RTL, non-Latin
//! scripts) and asserts that converting EPUB -> KFX -> EPUB and EPUB -> AZW3 ->
//! EPUB preserves the book's meaning (title + content text) via the semantic
//! comparator in `common`.
//!
//! Each chapter embeds ASCII prose so text retention is measurable regardless of
//! the special markup being exercised; the tables/footnotes/RTL/etc. are there to
//! drive the converter, and a distinctive marker word per book guards against a
//! whole chapter silently vanishing.

mod common;

use boko::model::Format;
use common::{Doc, EpubBuilder, Nav, roundtrip, summarize, word_retention};

/// Minimum fraction of distinct source content words that must survive a
/// roundtrip. Below 1.0 to tolerate legal formatting differences, but high
/// enough that a dropped paragraph/chapter fails the test.
const RETENTION_THRESHOLD: f64 = 0.9;

const COMPLEX_CSS: &str = r"
body { margin: 1em; font-family: serif; line-height: 1.5; }
h1 { font-size: 2em; text-align: center; page-break-before: always; }
h2 { font-size: 1.4em; color: #333; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #666; padding: 0.3em 0.6em; text-align: left; }
thead th { background: #eee; font-weight: bold; }
ul, ol { margin-left: 1.5em; }
.note { font-size: 0.85em; color: #555; }
blockquote { margin: 1em 2em; font-style: italic; }
a { color: #0645ad; text-decoration: underline; }
";

/// The diverse corpus. Each entry is (name, marker-word, builder).
fn corpus() -> Vec<(&'static str, &'static str, EpubBuilder)> {
    vec![
        (
            "tables",
            "voltaic",
            EpubBuilder::new("Tables Book")
                .css(COMPLEX_CSS)
                .doc(Doc::new(
                    "text/ch1.xhtml",
                    "Data",
                    "<h1>Measurements</h1>\
                     <p>The voltaic readings appear in the following table.</p>\
                     <table><thead><tr><th>Sample</th><th>Voltage</th><th>Notes</th></tr></thead>\
                     <tbody>\
                     <tr><td>Alpha</td><td>3.7</td><td>nominal reading</td></tr>\
                     <tr><td>Bravo</td><td>4.1</td><td>slightly elevated</td></tr>\
                     <tr><td>Charlie</td><td>3.9</td><td>within tolerance</td></tr>\
                     </tbody></table>\
                     <p>These figures confirm the hypothesis about power delivery.</p>",
                ))
                .nav(vec![Nav::new("Measurements", "text/ch1.xhtml")]),
        ),
        (
            "footnotes",
            "peripatetic",
            EpubBuilder::new("Footnotes Book")
                .css(COMPLEX_CSS)
                .doc(Doc::new(
                    "text/ch1.xhtml",
                    "Essay",
                    "<h1>An Essay</h1>\
                     <p>The peripatetic philosophers walked while teaching\
                     <a id=\"ref1\" href=\"#fn1\" epub:type=\"noteref\">1</a> their students.\
                     Aristotle founded this tradition<a id=\"ref2\" href=\"#fn2\">2</a>.</p>\
                     <aside id=\"fn1\" epub:type=\"footnote\"><p>1. From the Greek word for walking.\
                     <a href=\"#ref1\">back</a></p></aside>\
                     <aside id=\"fn2\" epub:type=\"footnote\"><p>2. At the Lyceum in Athens.\
                     <a href=\"#ref2\">back</a></p></aside>",
                ))
                .nav(vec![Nav::new("An Essay", "text/ch1.xhtml")]),
        ),
        (
            "images",
            "daguerreotype",
            EpubBuilder::new("Images Book")
                .css(COMPLEX_CSS)
                .cover_png()
                .image("images/fig1.png", common::tiny_png())
                .doc(Doc::new(
                    "text/ch1.xhtml",
                    "Gallery",
                    "<h1>The Gallery</h1>\
                     <p>Below is an early daguerreotype photograph.</p>\
                     <figure><img src=\"../images/fig1.png\" alt=\"a portrait\"/>\
                     <figcaption>Figure one: a portrait study.</figcaption></figure>\
                     <p>Photography transformed how people preserved memories.</p>",
                ))
                .nav(vec![Nav::new("The Gallery", "text/ch1.xhtml")]),
        ),
        (
            "nested_lists",
            "taxonomy",
            EpubBuilder::new("Lists Book")
                .css(COMPLEX_CSS)
                .doc(Doc::new(
                    "text/ch1.xhtml",
                    "Outline",
                    "<h1>Taxonomy Outline</h1>\
                     <p>The classification follows a nested structure.</p>\
                     <ul>\
                     <li>Animals\
                       <ul><li>Mammals<ul><li>Primates</li><li>Rodents</li></ul></li>\
                       <li>Birds</li></ul></li>\
                     <li>Plants\
                       <ol><li>Flowering species</li><li>Conifers</li></ol></li>\
                     </ul>\
                     <p>Each rank subdivides into progressively finer categories.</p>",
                ))
                .nav(vec![Nav::new("Taxonomy Outline", "text/ch1.xhtml")]),
        ),
        (
            "multichapter",
            "quintessence",
            EpubBuilder::new("Multi Chapter Book")
                .css(COMPLEX_CSS)
                .doc(Doc::new(
                    "text/ch1.xhtml",
                    "First",
                    "<h1 id=\"c1\">The First Movement</h1>\
                     <p>Herein begins the quintessence of the argument, with several\
                     distinct paragraphs establishing the premise.</p>\
                     <blockquote><p>A quoted passage of some importance.</p></blockquote>",
                ))
                .doc(Doc::new(
                    "text/ch2.xhtml",
                    "Second",
                    "<h1 id=\"c2\">The Second Movement</h1>\
                     <p>The development section elaborates upon earlier themes with\
                     considerable rhetorical flourish and momentum.</p>\
                     <h2 id=\"c2s1\">A Subsection</h2>\
                     <p>Additional supporting detail resides within this subsection.</p>",
                ))
                .doc(Doc::new(
                    "text/ch3.xhtml",
                    "Third",
                    "<h1 id=\"c3\">The Final Movement</h1>\
                     <p>At last the conclusion draws the disparate threads together\
                     into a single coherent whole.</p>",
                ))
                .nav(vec![
                    Nav::new("The First Movement", "text/ch1.xhtml#c1"),
                    Nav::new("The Second Movement", "text/ch2.xhtml#c2")
                        .with_children(vec![Nav::new("A Subsection", "text/ch2.xhtml#c2s1")]),
                    Nav::new("The Final Movement", "text/ch3.xhtml#c3"),
                ]),
        ),
        (
            "rtl",
            "מרקר",
            EpubBuilder::new("RTL Book")
                .language("he")
                .css(COMPLEX_CSS)
                .doc(
                    Doc::new(
                        "text/ch1.xhtml",
                        "Hebrew",
                        "<h1>כותרת</h1>\
                         <p>מרקר שלום עולם זהו טקסט בעברית לבדיקת כיווניות.</p>\
                         <p>This chapter mixes Hebrew script with English prose to\
                         verify bidirectional handling and retention.</p>",
                    )
                    .lang_dir("he", "rtl"),
                )
                .nav(vec![Nav::new("Hebrew Chapter", "text/ch1.xhtml")]),
        ),
        (
            "nonlatin",
            "quantum",
            EpubBuilder::new("Non Latin Book")
                .css(COMPLEX_CSS)
                .doc(Doc::new(
                    "text/ch1.xhtml",
                    "Mixed Scripts",
                    "<h1>Mixed Scripts</h1>\
                     <p>Greek: Ελληνικά κείμενο. Cyrillic: Русский текст. Japanese: 日本語のテキスト.</p>\
                     <p>The surrounding quantum mechanics discussion remains in English\
                     so that content retention stays measurable across the scripts.</p>",
                ))
                .nav(vec![Nav::new("Mixed Scripts", "text/ch1.xhtml")]),
        ),
    ]
}

/// Run the whole corpus through a roundtrip in `format`, asserting content is
/// preserved.
fn assert_corpus_roundtrips(format: Format) {
    for (name, marker, builder) in corpus() {
        let src = summarize(&mut builder.book());
        assert!(
            !src.words.is_empty(),
            "[{name}] source produced no content words"
        );

        let mut rt_book = roundtrip(&mut builder.book(), format);
        let out = summarize(&mut rt_book);

        assert_eq!(
            out.title, src.title,
            "[{name}] title preserved via {format:?}"
        );
        assert!(
            !out.words.is_empty(),
            "[{name}] roundtrip via {format:?} produced empty text"
        );

        let retention = word_retention(&src, &out);
        assert!(
            retention >= RETENTION_THRESHOLD,
            "[{name}] {format:?} content retention {retention:.3} < {RETENTION_THRESHOLD} \
             (dropped: {:?})",
            src.word_set()
                .into_iter()
                .filter(|w| !out.word_set().contains(w))
                .collect::<Vec<_>>()
        );

        // The distinctive marker must survive verbatim in the roundtripped text.
        let marker_lc = marker.to_lowercase();
        assert!(
            out.words.iter().any(|w| w == &marker_lc)
                || String::from_utf8(common::export_to_bytes(&mut rt_book, Format::Markdown))
                    .unwrap()
                    .contains(marker),
            "[{name}] marker {marker:?} lost via {format:?}"
        );
    }
}

#[test]
fn corpus_roundtrips_through_kfx() {
    assert_corpus_roundtrips(Format::Kfx);
}

#[test]
fn corpus_roundtrips_through_azw3() {
    assert_corpus_roundtrips(Format::Azw3);
}

#[test]
fn corpus_roundtrips_through_epub() {
    // EPUB -> EPUB should be near-lossless; a strong sanity check on the builder,
    // the exporter, and the comparator itself.
    assert_corpus_roundtrips(Format::Epub);
}

#[test]
fn multichapter_structure_preserved_through_azw3() {
    // Spine and TOC structure (not just text) should survive the KF8 writer.
    let (_, _, builder) = corpus()
        .into_iter()
        .find(|(n, _, _)| *n == "multichapter")
        .unwrap();
    let src = summarize(&mut builder.book());
    assert_eq!(src.spine_len, 3);
    assert_eq!(src.toc_count, 4);

    let mut rt = roundtrip(&mut builder.book(), Format::Azw3);
    let out = summarize(&mut rt);
    assert_eq!(out.spine_len, src.spine_len, "spine length via AZW3");
    assert_eq!(out.toc_count, src.toc_count, "TOC count via AZW3");
}
