//! Fuzz every importer path behind `Book::from_bytes`.
//!
//! The first input byte selects the format; the rest is the file payload.
//! Mirrors the drive sequence in `tests/parser_crash_corpus.rs`: importers
//! must return `Err` on malformed input, never panic. Minimized crashers
//! belong in `tests/fixtures/crashes/` where the crash-corpus test replays
//! them forever.
//!
//! Run with: `cargo +nightly fuzz run from_bytes`

#![no_main]

use boko::{Book, Format};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&selector, payload)) = data.split_first() else {
        return;
    };
    let format = match selector % 4 {
        0 => Format::Epub,
        1 => Format::Azw3,
        2 => Format::Mobi,
        _ => Format::Kfx,
    };

    let Ok(book) = Book::from_bytes(payload, format) else {
        return;
    };
    let _ = book.metadata();
    let spine: Vec<_> = book.spine().to_vec();
    for entry in &spine {
        let _ = book.load_raw(entry.id);
        let _ = book.load_chapter(entry.id);
    }
    let _ = book.resolve_links();
    let assets: Vec<_> = book.list_assets().to_vec();
    for asset in assets.iter().take(8) {
        let _ = book.load_asset(asset);
    }
    let _ = book.load_asset("does/not/exist");
});
