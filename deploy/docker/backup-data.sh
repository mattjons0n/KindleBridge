#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 DATA_VOLUME ABSOLUTE_BACKUP_DIRECTORY" >&2
  exit 64
fi

data_volume=$1
backup_directory=$2
image=${KINDLE_BRIDGE_IMAGE:-kindle-bridge:local}

case "$backup_directory" in
  /*) ;;
  *) echo "Backup directory must be an absolute path." >&2; exit 64 ;;
esac

case "$backup_directory" in
  *,*) echo "Backup directory cannot contain a comma." >&2; exit 64 ;;
esac

if [ ! -d "$backup_directory" ]; then
  echo "Backup directory does not exist: $backup_directory" >&2
  exit 66
fi

docker volume inspect "$data_volume" >/dev/null
if [ -n "$(docker ps --quiet --filter "volume=${data_volume}")" ]; then
  echo "Refusing backup while a running container uses the data volume: $data_volume" >&2
  exit 73
fi
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="kindle-bridge-data-${timestamp}.tar.gz"
archive_path="$backup_directory/$archive"
checksum_path="$archive_path.sha256"
complete=0
archive_reserved=0
checksum_reserved=0

cleanup_reservations() {
  if [ "$complete" -eq 0 ]; then
    if [ "$archive_reserved" -eq 1 ]; then rm -f -- "$archive_path"; fi
    if [ "$checksum_reserved" -eq 1 ]; then rm -f -- "$checksum_path"; fi
  fi
}
trap cleanup_reservations 0 1 2 15

# Reserve both exact outputs atomically. `set -C` makes redirection fail when a
# same-second backup or retry already owns either name, so no existing backup
# can be silently replaced by tar or checksum redirection.
if ! (umask 077; set -C; : > "$archive_path") 2>/dev/null; then
  echo "Refusing to overwrite existing backup: $archive_path" >&2
  exit 73
fi
archive_reserved=1
if ! (umask 077; set -C; : > "$checksum_path") 2>/dev/null; then
  echo "Refusing to overwrite existing checksum: $checksum_path" >&2
  exit 73
fi
checksum_reserved=1

docker run --rm \
  --user 0:0 \
  --read-only \
  --network none \
  --cap-drop ALL \
  --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  --mount "type=volume,src=${data_volume},dst=/data,readonly" \
  --mount "type=bind,src=${backup_directory},dst=/backup" \
  --env "ARCHIVE=${archive}" \
  --entrypoint sh \
  "$image" \
  -c 'set -eu; tar -C /data -czf "/backup/$ARCHIVE" .; cd /backup; test -s "$ARCHIVE"; sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"; sha256sum -c "$ARCHIVE.sha256"'

complete=1

echo "Created $backup_directory/$archive"
echo "Created $backup_directory/$archive.sha256"
