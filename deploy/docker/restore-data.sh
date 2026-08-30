#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 ABSOLUTE_BACKUP_ARCHIVE NEW_DATA_VOLUME" >&2
  exit 64
fi

archive_path=$1
target_volume=$2
image=${KINDLE_BRIDGE_IMAGE:-kindle-bridge:local}
reservation_token="kindle-bridge-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$"

case "$archive_path" in
  /*) ;;
  *) echo "Backup archive must be an absolute path." >&2; exit 64 ;;
esac

case "$archive_path" in
  *,*) echo "Backup archive path cannot contain a comma." >&2; exit 64 ;;
esac

if [ ! -f "$archive_path" ] || [ ! -f "$archive_path.sha256" ]; then
  echo "The archive and adjacent .sha256 file are both required." >&2
  exit 66
fi

if docker volume inspect "$target_volume" >/dev/null 2>&1; then
  echo "Refusing to overwrite existing Docker volume: $target_volume" >&2
  exit 73
fi

archive_directory=$(dirname "$archive_path")
archive_name=$(basename "$archive_path")
docker volume create \
  --label "org.kindle-bridge.restore-token=${reservation_token}" \
  "$target_volume" >/dev/null
actual_token=$(docker volume inspect \
  --format '{{ index .Labels "org.kindle-bridge.restore-token" }}' \
  "$target_volume")
if [ "$actual_token" != "$reservation_token" ]; then
  echo "Refusing restore: the target volume was created by another actor." >&2
  exit 73
fi
if [ -n "$(docker ps --all --quiet --filter "volume=${target_volume}")" ]; then
  echo "Refusing restore: the reserved volume is already attached to a container." >&2
  exit 73
fi

if ! docker run --rm \
  --user 0:0 \
  --read-only \
  --network none \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add FOWNER \
  --security-opt no-new-privileges:true \
  --mount "type=volume,src=${target_volume},dst=/data" \
  --mount "type=bind,src=${archive_directory},dst=/backup,readonly" \
  --env "ARCHIVE=${archive_name}" \
  --entrypoint sh \
  "$image" \
  -c 'set -eu; /usr/share/kindle-bridge/source/deploy/docker/verify-backup.sh "/backup/$ARCHIVE"; tar -C /data -xzf "/backup/$ARCHIVE"; chown -R 1000:1000 /data'; then
  echo "Restore failed. The new volume was left in place for inspection: $target_volume" >&2
  exit 74
fi

if ! docker run --rm \
  --user 1000:1000 \
  --read-only \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=volume,src=${target_volume},dst=/data,readonly" \
  --env CATALOG_DATABASE_PATH=/data/catalog.sqlite \
  --entrypoint node \
  "$image" \
  dist/server/maintenance.js verify; then
  echo "Restore extraction finished, but catalog integrity verification failed. The volume was left for inspection: $target_volume" >&2
  exit 74
fi

echo "Restored into new Docker volume: $target_volume"
echo "Set KINDLE_BRIDGE_DATA_VOLUME=$target_volume before starting the service."
