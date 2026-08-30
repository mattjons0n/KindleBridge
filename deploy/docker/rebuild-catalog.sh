#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 STOPPED_DATA_VOLUME" >&2
  exit 64
fi

data_volume=$1
image=${KINDLE_BRIDGE_IMAGE:-kindle-bridge:local}

case "$data_volume" in
  *','*|'') echo "Data volume name is invalid." >&2; exit 64 ;;
esac

if ! docker volume inspect "$data_volume" >/dev/null 2>&1; then
  echo "Data volume does not exist: $data_volume" >&2
  exit 66
fi

if [ -n "$(docker ps --quiet --filter "volume=${data_volume}")" ]; then
  echo "Refusing catalog rebuild while a running container uses the data volume: $data_volume" >&2
  exit 73
fi

docker run --rm \
  --user 1000:1000 \
  --read-only \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=volume,src=${data_volume},dst=/data" \
  --env CATALOG_DATABASE_PATH=/data/catalog.sqlite \
  --entrypoint node \
  "$image" \
  dist/server/maintenance.js prepare-rebuild

echo "Derived catalog rows cleared; profiles, roots, stable book identities, and deliveries were retained."
echo "Restart with the same source mounts and request a deep rescan for every enabled root."
