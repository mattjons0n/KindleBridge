# Kindle Bridge — Backlog

## Reconsider automatic safe-write test cadence

**Status:** Backlog — no behavior change yet.

Evaluate whether the exact-byte create/read/compare/delete test needs to run after every clean Kindle connection, or whether it can run only on first use and again after relevant application/device changes, browser or USB faults, interrupted transfers, or an explicit diagnostic request.

Any future change must preserve:

- collision-resistant, no-overwrite book transfers;
- current-session ownership of every created MTP handle;
- exact-handle cleanup and the bounded recovery journal;
- post-transfer handle, parent, filename, and size verification;
- fail-closed behavior after an interrupted or unverified write.

Before changing the policy, measure the safe-write test separately from inventory on the physical `0x1949 / 0x9981` Kindle. Kindle Bridge now labels those phases separately, prunes `.sdr` sidecars, skips redundant managed-file reads, and maintains a portable Kindle-resident metadata cache with a browser-local fallback. Measure again before assuming the self-test is the remaining bottleneck; a first scan and genuine cache misses can still require bounded full-object reads.

Acceptance requires tests for every retained trigger and failure path, plus a fresh physical Kindle transfer/reconnect/recovery run.

## Probe partial-object metadata reads on the physical Kindle

**Status:** Backlog — do not enable without device evidence.

Run a bounded, read-only physical capability probe for MTP `GetPartialObject` (`0x101b`) on the known `0x1949 / 0x9981` Kindle. If the device advertises and correctly implements it, a future version could read only the PalmDB/MOBI metadata region on a cache miss instead of downloading an entire supported book.

Do not enable MTP `GetObjectPropList` (`0x9805`) for this device. Calibre's pinned libmtp table maps [the exact `0x1949 / 0x9981` model](https://github.com/kovidgoyal/calibre/blob/2601151d9233e8312b4e307222a9b3b05e2729bd/src/calibre/devices/mtp/unix/upstream/music-players.h#L2602-L2605) to `DEVICE_FLAGS_ANDROID_BUGS`, whose [definition explicitly includes the broken `GetObjectPropList` flag](https://github.com/kovidgoyal/calibre/blob/2601151d9233e8312b4e307222a9b3b05e2729bd/src/calibre/devices/mtp/unix/upstream/device-flags.h#L310-L319). The current implementation must continue using conservative per-object metadata reads unless new physical evidence and fault tests justify a different path.

Acceptance for a partial-read implementation requires exact operation-support capture, bounded byte/range handling, malformed/truncated response tests, fallback to the existing full-object path, transport-fault retirement, and a fresh physical inventory/matching run. A synthetic DeviceInfo fixture is not evidence of device support.

## Add a bounded KFX sidecar metadata reader

**Status:** Backlog — KFX/AZW8 presence is supported, embedded matching metadata is not yet parsed.

Real KFX metadata uses a different container from PalmDB/MOBI. Calibre handles it with a dedicated reader, often targeting `<book>.sdr/assets/metadata.kfx`; Kindle Bridge now avoids downloading an entire KFX/AZW8 book only to fail the MOBI parser. Until a bounded reader exists, unmanaged KFX/AZW8 objects remain visible and make metadata-based absence unknown. Managed Kindle Bridge filename tokens continue to provide their existing stronger evidence.

Acceptance requires strict container/field/count/byte bounds, malformed and hostile fixtures, exact parent-sidecar association, no traversal of unrelated `.sdr` assets, no whole-book fallback, and physical reconciliation against the known Kindle.
