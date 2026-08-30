//! WASM bindings for browser-based ebook conversion.
//!
//! This module exposes the core conversion functions to JavaScript via wasm-bindgen.

use std::io::{self, Cursor, Seek, SeekFrom, Write};
use wasm_bindgen::prelude::*;

use crate::model::{Book, Format, TocEntry};

/// Maximum AZW3 bytes the browser converter may allocate (200 MiB).
pub const MAX_AZW3_OUTPUT_BYTES: usize = 200 * 1024 * 1024;

/// Seekable in-memory output that rejects an extending write before its inner
/// `Vec` can grow beyond `limit`. AZW3 exporters seek back to patch headers,
/// so a plain `Write::take` wrapper is not sufficient.
struct CappedCursor {
    inner: Cursor<Vec<u8>>,
    limit: usize,
}

impl CappedCursor {
    fn new(limit: usize) -> Self {
        Self {
            inner: Cursor::new(Vec::new()),
            limit,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.inner.into_inner()
    }

    fn limit_error(&self) -> io::Error {
        io::Error::other(format!("AZW3 output exceeds the {} byte limit", self.limit))
    }
}

impl Write for CappedCursor {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let position = usize::try_from(self.inner.position()).map_err(|_| self.limit_error())?;
        let end = position
            .checked_add(buf.len())
            .ok_or_else(|| self.limit_error())?;
        if end.max(self.inner.get_ref().len()) > self.limit {
            return Err(self.limit_error());
        }
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl Seek for CappedCursor {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => self.inner.get_ref().len() as i128 + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.inner.position()) + i128::from(offset),
        };
        if target < 0 || target > self.limit as i128 {
            return Err(self.limit_error());
        }
        let target = target as u64;
        self.inner.set_position(target);
        Ok(target)
    }
}

/// Initialize panic hook for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "wasm")]
    console_error_panic_hook::set_once();
}

/// Parse a format name (as used by the JS API) into a [`Format`].
fn parse_format(name: &str) -> Result<Format, JsValue> {
    match name.to_ascii_lowercase().as_str() {
        "epub" => Ok(Format::Epub),
        "azw3" => Ok(Format::Azw3),
        "mobi" | "azw" => Ok(Format::Mobi),
        "kfx" => Ok(Format::Kfx),
        "markdown" | "md" => Ok(Format::Markdown),
        _ => Err(JsValue::from_str(&format!("unknown format: {name}"))),
    }
}

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Convert an ebook from one format to another.
///
/// `from` and `to` are format names: `"epub"`, `"azw3"`, `"mobi"`, `"kfx"`,
/// or `"markdown"` (`"md"`). Any importable `from` (EPUB, AZW3, MOBI, KFX)
/// can be converted to any exportable `to` (EPUB, AZW3, KFX, Markdown).
///
/// Takes the raw input bytes and returns the converted output bytes
/// (UTF-8 text for Markdown).
#[wasm_bindgen]
pub fn convert(data: &[u8], from: &str, to: &str) -> Result<Vec<u8>, JsValue> {
    let from = parse_format(from)?;
    let to = parse_format(to)?;

    if !from.can_import() {
        return Err(JsValue::from_str(&format!(
            "format not supported as input: {from:?}"
        )));
    }
    if !to.can_export() {
        return Err(JsValue::from_str(&format!(
            "format not supported as output: {to:?}"
        )));
    }

    let book = Book::from_bytes(data, from).map_err(js_err)?;

    if to == Format::Azw3 {
        let mut output = CappedCursor::new(MAX_AZW3_OUTPUT_BYTES);
        book.export(to, &mut output).map_err(js_err)?;
        Ok(output.into_inner())
    } else {
        let mut output = Cursor::new(Vec::new());
        book.export(to, &mut output).map_err(js_err)?;
        Ok(output.into_inner())
    }
}

/// Inspect an ebook's metadata without converting it.
///
/// `from` is the input format name (see [`convert`]). Returns a JSON string:
/// `{"title": ..., "authors": [...], "language": ..., "chapters": n, "toc_entries": n}`.
/// Call `JSON.parse` on the result in JavaScript.
#[wasm_bindgen]
pub fn book_info(data: &[u8], from: &str) -> Result<JsValue, JsValue> {
    let from = parse_format(from)?;
    if !from.can_import() {
        return Err(JsValue::from_str(&format!(
            "format not supported as input: {from:?}"
        )));
    }

    let book = Book::from_bytes(data, from).map_err(js_err)?;
    let meta = book.metadata();

    fn count_toc(entries: &[TocEntry]) -> usize {
        entries.iter().map(|e| 1 + count_toc(&e.children)).sum()
    }

    fn json_string(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    out.push_str(&format!("\\u{:04x}", c as u32));
                }
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    let authors: Vec<String> = meta.authors.iter().map(|a| json_string(a)).collect();
    let json = format!(
        "{{\"title\":{},\"authors\":[{}],\"language\":{},\"chapters\":{},\"toc_entries\":{}}}",
        json_string(&meta.title),
        authors.join(","),
        json_string(&meta.language),
        book.spine().len(),
        count_toc(book.toc()),
    );

    Ok(JsValue::from_str(&json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_cursor_rejects_n_plus_one_before_growing() {
        let mut output = CappedCursor::new(8);
        output.write_all(b"12345678").unwrap();
        assert_eq!(output.inner.get_ref().len(), 8);

        let error = output.write_all(b"9").unwrap_err();
        assert!(error.to_string().contains("8 byte limit"));
        assert_eq!(output.inner.get_ref().len(), 8);
        assert_eq!(output.inner.position(), 8);
    }

    #[test]
    fn capped_cursor_allows_in_place_header_patches() {
        let mut output = CappedCursor::new(8);
        output.write_all(b"12345678").unwrap();
        output.seek(SeekFrom::Start(2)).unwrap();
        output.write_all(b"AB").unwrap();
        assert_eq!(output.into_inner(), b"12AB5678");
    }
}
