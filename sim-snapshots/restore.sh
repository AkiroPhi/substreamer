#!/usr/bin/env bash
# Restore a Substreamer simulator fixture over the BOOTED simulator, so a migration can be
# run against the same source data as many times as needed.
#
#   ./list.sh                 # what is available
#   ./restore.sh <snapshot>   # put one on the booted simulator
#
# Terminates the app first: copying over a live WAL gives a torn database.
set -euo pipefail

SNAP="${1:?usage: restore.sh <snapshot-dir-name>}"
SRC="$(cd "$(dirname "$0")" && pwd)/$SNAP"
[[ -d "$SRC" ]] || { echo "No such snapshot: $SRC"; exit 1; }

BUNDLE=com.ghenry22.substream2
CONTAINER=$(xcrun simctl get_app_container booted "$BUNDLE" data)
DOCS="$CONTAINER/Documents"

if xcrun simctl spawn booted launchctl list 2>/dev/null | grep -q "$BUNDLE"; then
  echo "App is running — terminating so the restore is not torn."
  xcrun simctl terminate booted "$BUNDLE" || true
  sleep 1
fi

echo "Restoring database..."
rm -f "$DOCS/SQLite/substreamer7.db" "$DOCS/SQLite/substreamer7.db-wal" "$DOCS/SQLite/substreamer7.db-shm"
cp "$SRC/substreamer7.db" "$DOCS/SQLite/substreamer7.db"

# Caches are restored wholesale. The music cache in particular is the point of a fixture
# that has one: the re-key's file move is the only irreversible step and the only one the
# in-memory tests cannot reach.
for cache in image-cache music-cache; do
  if [[ -f "$SRC/$cache.tar.gz" ]]; then
    echo "Restoring ${cache}..."
    rm -rf "${DOCS:?}/$cache"
    tar -C "$DOCS" -xzf "$SRC/$cache.tar.gz"
  else
    # A snapshot without this cache means the fixture genuinely had none; leaving a
    # previous fixture's copy behind would be worse than an empty one.
    echo "Clearing ${cache} (not in snapshot)..."
    rm -rf "${DOCS:?}/$cache"
  fi
done

echo "Done. Relaunch the app."
