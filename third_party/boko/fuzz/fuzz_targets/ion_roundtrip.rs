//! Fuzz the hand-rolled Ion binary reader/writer pair in `boko::kfx::ion`.
//!
//! Arbitrary bytes are fed to `IonParser`; whenever they parse to a value,
//! that value is serialized with `IonWriter` and the produced bytes must
//! parse again. `IonValue` does not implement `PartialEq`, so the invariant
//! checked is "writer output is always readable", not full value equality.
//! A parse failure on arbitrary input is fine; a panic anywhere, or a parse
//! failure on writer-produced bytes, is a bug.
//!
//! Run with: `cargo +nightly fuzz run ion_roundtrip`

#![no_main]

use boko::kfx::ion::{IonParser, IonWriter};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(value) = IonParser::new(data).parse() else {
        return;
    };

    let mut writer = IonWriter::new();
    writer.write_bvm();
    writer.write_value(&value);
    let bytes = writer.into_bytes();

    IonParser::new(&bytes)
        .parse()
        .expect("IonWriter produced bytes that IonParser rejects");
});
