//! Fuzz the KFX container-level parsers in `boko::kfx::container`.
//!
//! These functions consume untrusted byte ranges cut straight out of a KFX
//! file (header, container info, index table, doc symbols, entity payloads).
//! The invariant is "no panics": every function must return an error, an
//! empty result, or the input unchanged on malformed data.
//!
//! Run with: `cargo +nightly fuzz run container_parse`

#![no_main]

use boko::kfx::container::{
    extract_doc_symbols, parse_container_header, parse_container_info, parse_index_table,
    skip_enty_header,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = parse_container_header(data);
    let _ = parse_container_info(data);
    let _ = extract_doc_symbols(data);
    let _ = skip_enty_header(data);

    // Exercise a couple of representative header lengths, including the value
    // the real parser passes (the container's own header_len) when available.
    let _ = parse_index_table(data, 0);
    let _ = parse_index_table(data, usize::MAX);
    if let Ok(header) = parse_container_header(data) {
        let _ = parse_index_table(data, header.header_len);
    }
});
