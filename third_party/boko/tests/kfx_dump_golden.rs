//! Golden regression test for `boko kfx-dump` field reports.
//!
//! Runs the CLI binary against the epictetus.kfx fixture with `-f` for every
//! supported field report and compares the combined stdout byte-for-byte
//! against a checked-in expected file. This pins the human-readable report
//! format so accidental output changes are caught in CI instead of by hand.
//!
//! Deliberately NOT goldened: the default full dump (~28k lines — too much
//! fixture churn for the signal it adds). The 14 field reports (~1000 lines)
//! were verified deterministic across runs before the fixture was recorded.
//!
//! To regenerate the fixture after an intentional output change:
//!
//! ```sh
//! cargo run --bin boko -- kfx-dump tests/fixtures/epictetus.kfx \
//!   -f anchors -f container -f content -f dependencies -f document \
//!   -f features -f locations -f metadata -f navigation -f positions \
//!   -f reading_orders -f resources -f sections -f storylines \
//!   > tests/fixtures/kfx_dump_fields.expected
//! ```

use std::process::Command;

/// All field reports supported by `boko kfx-dump -f`, in the order they are
/// passed on the command line (reports are emitted in argument order).
const FIELDS: [&str; 14] = [
    "anchors",
    "container",
    "content",
    "dependencies",
    "document",
    "features",
    "locations",
    "metadata",
    "navigation",
    "positions",
    "reading_orders",
    "resources",
    "sections",
    "storylines",
];

#[test]
fn kfx_dump_field_reports_match_golden() {
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/epictetus.kfx");
    // Normalize CRLF: on Windows, git checkout (without the .gitattributes
    // `-text` guard) and console pipes can introduce \r\n on either side.
    let expected = include_str!("fixtures/kfx_dump_fields.expected").replace("\r\n", "\n");
    let expected = expected.as_str();

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_boko"));
    cmd.arg("kfx-dump").arg(fixture);
    for field in FIELDS {
        cmd.arg("-f").arg(field);
    }

    let output = cmd.output().expect("failed to run boko kfx-dump");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "kfx-dump exited with {:?}; stderr:\n{stderr}",
        output.status.code()
    );
    assert!(
        stderr.is_empty(),
        "kfx-dump field-report mode wrote to stderr:\n{stderr}"
    );

    let stdout = String::from_utf8(output.stdout)
        .expect("kfx-dump stdout was not UTF-8")
        .replace("\r\n", "\n");
    if stdout != expected {
        // Point at the first divergent line for a readable failure instead of
        // dumping two ~1000-line blobs.
        let mismatch = expected
            .lines()
            .zip(stdout.lines())
            .enumerate()
            .find(|(_, (want, got))| want != got);
        match mismatch {
            Some((idx, (want, got))) => panic!(
                "kfx-dump output diverges from tests/fixtures/kfx_dump_fields.expected \
                 at line {}:\n  expected: {want}\n  actual:   {got}\n\
                 (expected {} lines, got {}; see test header for regeneration command)",
                idx + 1,
                expected.lines().count(),
                stdout.lines().count(),
            ),
            None => panic!(
                "kfx-dump output is a prefix/extension of the golden file: \
                 expected {} lines, got {} (see test header for regeneration command)",
                expected.lines().count(),
                stdout.lines().count(),
            ),
        }
    }
}
