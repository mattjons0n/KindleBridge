//! Profiling harness: convert a large synthetic book in a tight loop so
//! `perf record` can attribute time to the hot conversion paths.
//!
//! Usage: `profile_convert <kfx|azw3|epub|md> <iterations> <chapters>`

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{Cursor, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use boko::export::{Azw3Exporter, EpubExporter, Exporter, KfxExporter, MarkdownExporter};
use boko::{Book, Format};

/// Counts allocations and total bytes so optimizations can be measured by
/// allocation churn (deterministic) rather than wall-clock (noisy under load).
struct CountingAlloc;
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

fn build_synthetic_epub(chapters: usize) -> Vec<u8> {
    use zip::write::SimpleFileOptions;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip.start_file("META-INF/container.xml", deflated).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
    zip.start_file("OEBPS/style.css", deflated).unwrap();
    zip.write_all(b"body{margin:1em;font-family:serif}p{text-indent:1em;margin:.2em 0}p.first{text-indent:0}em{font-style:italic}li strong{color:#333}table td{padding:.2em;border:1px solid #999}").unwrap();

    let mut manifest = String::new();
    let mut spine = String::new();
    for i in 0..chapters {
        let mut body = format!("<h1>Chapter {}</h1>", i + 1);
        for p in 0..40 {
            body.push_str(&format!(
                "<p class=\"{}\">Paragraph {p} of chapter {i} with <em>emphasis</em>, a <a href=\"chapter_{}.xhtml\">link</a>, and <span class=\"note\">spans</span> exercising the cascade and IR transform.</p>",
                if p == 0 { "first" } else { "body" }, (i + 1) % chapters,
            ));
        }
        body.push_str("<ul><li><strong>alpha</strong></li><li>beta</li></ul><table><tr><td>a</td><td>b</td></tr></table>");
        let doc = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>Chapter {}</title><link rel=\"stylesheet\" href=\"style.css\"/></head><body>{body}</body></html>",
            i + 1
        );
        zip.start_file(format!("OEBPS/chapter_{i}.xhtml"), deflated)
            .unwrap();
        zip.write_all(doc.as_bytes()).unwrap();
        manifest.push_str(&format!(
            "<item id=\"ch{i}\" href=\"chapter_{i}.xhtml\" media-type=\"application/xhtml+xml\"/>"
        ));
        spine.push_str(&format!("<itemref idref=\"ch{i}\"/>"));
    }
    zip.start_file("OEBPS/content.opf", deflated).unwrap();
    zip.write_all(format!(r#"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:bench</dc:identifier><dc:title>Synthetic</dc:title><dc:language>en</dc:language></metadata><manifest><item id="css" href="style.css" media-type="text/css"/>{manifest}</manifest><spine>{spine}</spine></package>"#).as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fmt = args.get(1).map(String::as_str).unwrap_or("kfx");
    let iters: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(50);
    let chapters: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(100);

    let epub = build_synthetic_epub(chapters);
    let target = match fmt {
        "azw3" => Format::Azw3,
        "epub" => Format::Epub,
        "md" => Format::Markdown,
        _ => Format::Kfx,
    };

    // Warm up once (fills any lazy statics), then reset counters.
    {
        let book = Book::from_bytes(&epub, Format::Epub).unwrap();
        let mut buf = Cursor::new(Vec::new());
        let _ = KfxExporter::new().export(&book, &mut buf);
    }
    ALLOCS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);

    let ir_only = fmt == "ir";
    let mut total = 0usize;
    for _ in 0..iters {
        let book = Book::from_bytes(&epub, Format::Epub).unwrap();
        if ir_only {
            // Parse + build IR for every chapter, no export.
            for entry in book.spine() {
                total = total.wrapping_add(book.load_chapter(entry.id).unwrap().node_count());
            }
            continue;
        }
        let mut buf = Cursor::new(Vec::new());
        match target {
            Format::Kfx => KfxExporter::new().export(&book, &mut buf).unwrap(),
            Format::Azw3 => Azw3Exporter::new().export(&book, &mut buf).unwrap(),
            Format::Epub => EpubExporter::new().export(&book, &mut buf).unwrap(),
            Format::Markdown => MarkdownExporter::new().export(&book, &mut buf).unwrap(),
            _ => unreachable!(),
        }
        total = total.wrapping_add(buf.into_inner().len());
    }
    let allocs = ALLOCS.load(Ordering::Relaxed);
    let bytes = BYTES.load(Ordering::Relaxed);
    eprintln!(
        "{fmt}: {iters}it x {chapters}ch  allocs={allocs} ({} k/it)  bytes={bytes} ({} MB/it)  checksum {total}",
        allocs / iters as u64,
        bytes / iters as u64 / 1_048_576,
    );
}
