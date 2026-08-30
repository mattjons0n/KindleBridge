//! EPUB font deobfuscation (OCF §Resource Obfuscation).
//!
//! Fonts listed in META-INF/encryption.xml under the IDPF or Adobe scheme
//! are XOR-obfuscated with a key derived from the package identifier. boko
//! must deobfuscate them at import — a raw obfuscated font shipped into KFX
//! never renders on device. Wrong or missing keys must leave bytes
//! untouched (no worse than before).

use std::io::Write;

use boko::Format;
use zip::write::SimpleFileOptions;

const UUID_ID: &str = "urn:uuid:12345678-1234-1234-1234-123456789abc";

/// A fake TrueType font: valid magic, then patterned bytes.
fn fake_font() -> Vec<u8> {
    let mut font = vec![0x00, 0x01, 0x00, 0x00];
    font.extend((0..2000u32).map(|i| (i % 251) as u8));
    font
}

fn idpf_obfuscate(mut data: Vec<u8>, identifier: &str) -> Vec<u8> {
    let cleaned: String = identifier.split_whitespace().collect();
    let key = sha1_smol::Sha1::from(cleaned.as_bytes()).digest().bytes();
    let end = 1040.min(data.len());
    for (i, byte) in data[..end].iter_mut().enumerate() {
        *byte ^= key[i % key.len()];
    }
    data
}

fn adobe_obfuscate(mut data: Vec<u8>, identifier: &str) -> Vec<u8> {
    // Key derives from the UUID part only — the "d" in "urn:uuid:" is a hex
    // digit and must not leak into the key.
    let uuid = identifier.rsplit(':').next().unwrap();
    let hex: String = uuid.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let key: Vec<u8> = (0..16)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    let end = 1024.min(data.len());
    for (i, byte) in data[..end].iter_mut().enumerate() {
        *byte ^= key[i % key.len()];
    }
    data
}

/// Minimal EPUB with two obfuscated fonts (one per scheme) and a matching
/// encryption.xml. The uuid identifier is deliberately the *second*
/// dc:identifier so key derivation must consider all identifiers.
fn build_epub(encryption_xml: &str, idpf_font: &[u8], adobe_font: &[u8]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let stored =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default();

        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();

        zip.start_file("META-INF/container.xml", deflated).unwrap();
        zip.write_all(br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#).unwrap();

        zip.start_file("META-INF/encryption.xml", deflated).unwrap();
        zip.write_all(encryption_xml.as_bytes()).unwrap();

        zip.start_file("OEBPS/content.opf", deflated).unwrap();
        zip.write_all(
            format!(
                r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier>urn:isbn:9999999999</dc:identifier>
    <dc:identifier id="uid">{UUID_ID}</dc:identifier>
    <dc:title>Font Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="f1" href="fonts/one.ttf" media-type="font/ttf"/>
    <item id="f2" href="fonts/two.ttf" media-type="font/ttf"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>"#
            )
            .as_bytes(),
        )
        .unwrap();

        zip.start_file("OEBPS/text/ch1.xhtml", deflated).unwrap();
        zip.write_all(br#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>text</p></body></html>"#).unwrap();

        zip.start_file("OEBPS/fonts/one.ttf", deflated).unwrap();
        zip.write_all(idpf_font).unwrap();
        zip.start_file("OEBPS/fonts/two.ttf", deflated).unwrap();
        zip.write_all(adobe_font).unwrap();

        zip.finish().unwrap();
    }
    buf.into_inner()
}

// URIs are written OPF-relative here (a common real-world deviation from the
// container-root-relative spec) to cover the both-resolutions indexing.
const ENCRYPTION_XML: &str = r#"<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/one.ttf"/></enc:CipherData>
  </enc:EncryptedData>
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/>
    <enc:CipherData><enc:CipherReference URI="fonts/two.ttf"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>"#;

#[test]
fn obfuscated_fonts_are_deobfuscated_at_import() {
    let plain = fake_font();
    let epub = build_epub(
        ENCRYPTION_XML,
        &idpf_obfuscate(plain.clone(), UUID_ID),
        &adobe_obfuscate(plain.clone(), UUID_ID),
    );

    let book = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    assert_eq!(
        book.load_asset("OEBPS/fonts/one.ttf").expect("idpf font"),
        plain,
        "IDPF-obfuscated font must round-trip to plain bytes"
    );
    assert_eq!(
        book.load_asset("OEBPS/fonts/two.ttf").expect("adobe font"),
        plain,
        "Adobe-obfuscated font must round-trip to plain bytes"
    );
}

#[test]
fn wrong_key_leaves_font_bytes_untouched() {
    let plain = fake_font();
    // Obfuscated with an identifier that is NOT in the OPF: undecodable.
    let scrambled = idpf_obfuscate(plain, "urn:uuid:ffffffff-ffff-ffff-ffff-ffffffffffff");
    let epub = build_epub(ENCRYPTION_XML, &scrambled, &fake_font());

    let book = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    assert_eq!(
        book.load_asset("OEBPS/fonts/one.ttf").expect("font"),
        scrambled,
        "an undecodable font must pass through unchanged"
    );
}

#[test]
fn plain_font_listed_in_encryption_xml_passes_through() {
    // Some books list unobfuscated fonts in encryption.xml.
    let plain = fake_font();
    let epub = build_epub(ENCRYPTION_XML, &plain, &plain);
    let book = boko::Book::from_bytes(&epub, Format::Epub).expect("import epub");
    assert_eq!(book.load_asset("OEBPS/fonts/one.ttf").expect("font"), plain);
}
