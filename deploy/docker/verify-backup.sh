#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 BACKUP_ARCHIVE" >&2
  exit 64
fi

archive_path=$1
checksum_path=$archive_path.sha256
if [ ! -f "$archive_path" ] || [ ! -f "$checksum_path" ]; then
  echo "The archive and adjacent .sha256 file are both required." >&2
  exit 66
fi

# Read exactly one digest token from the sidecar, then hash the archive named
# by the caller. This deliberately does not trust the filename stored in a
# sidecar, so a renamed/stale sidecar cannot authenticate a different archive.
expected=$(awk 'NR == 1 { print $1; next } { exit 1 }' "$checksum_path")
case "$expected" in
  ""|*[!0-9a-fA-F]*) echo "Invalid backup checksum sidecar." >&2; exit 65 ;;
esac
if [ "${#expected}" -ne 64 ]; then
  echo "Invalid backup checksum sidecar." >&2
  exit 65
fi
actual=$(sha256sum "$archive_path" | awk '{ print $1 }')
if [ "$actual" != "$expected" ]; then
  echo "Backup checksum does not match the selected archive." >&2
  exit 65
fi
