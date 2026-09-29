#!/usr/bin/env bash
# Restore a Substreamer fixture onto a running Android emulator or device, so a migration
# can be run against the same source data as many times as needed.
#
#   ./restore-android.sh <snapshot>                 # onto the only attached device
#   ./restore-android.sh <snapshot> -s emulator-5556
#
# Takes EITHER shape of fixture:
#   * an Android capture (app-data.tar.gz — the whole /data/data tree)
#   * an iOS capture     (substreamer7.db + image-cache.tar.gz + music-cache.tar.gz)
#
# The iOS ones are portable because nothing stores an absolute path: a downloaded track
# lives at {Paths.document}/music-cache/{albumId}/{songId}.{ext} (musicCacheService.ts:7),
# derived at runtime, and both platforms lay out SQLite/, music-cache/ and image-cache/
# the same way under their own document dir. So an iOS fixture gives Android the
# downloads — and the re-key file-move coverage — that no Android capture has.
#
# Metro may be running: restoring is repeatable, so the worst a dev client can do is
# consume the restored state, and you just restore again. (Metro DOES matter when
# CAPTURING a fixture — the source state there is irreplaceable.)
#
# The iOS twin is restore.sh. The split is real: iOS copies into a simulator container on
# disk, Android has to go through adb + run-as because app data is not readable otherwise.
set -euo pipefail

PKG=com.ghenry22.substream2
SNAP=""
SERIAL_ID=""

# macOS ships bash 3.2, where an empty array under `set -u` counts as unbound. A helper
# sidesteps the array entirely.
adbx() {
  if [[ -n "$SERIAL_ID" ]]; then adb -s "$SERIAL_ID" "$@"; else adb "$@"; fi
}

# ONE argument to `adb shell`, always. `adb shell` joins its args and the DEVICE shell
# re-parses the result, so an unquoted pipe or word-split runs the tail outside run-as, as
# the wrong user, silently. That is not theoretical: it is why an earlier version of this
# script cleared nothing and then hung forever.
appsh() { adbx shell "run-as $PKG sh -c '$1'"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s) SERIAL_ID="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1"; exit 1 ;;
    *) SNAP="$1"; shift ;;
  esac
done
[[ -n "$SNAP" ]] || { echo "usage: restore-android.sh <snapshot-dir-name> [-s <serial>]"; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)/$SNAP"
[[ -d "$SRC" ]] || { echo "No such snapshot: $SRC"; exit 1; }

if [[ -f "$SRC/app-data.tar.gz" ]]; then
  KIND=android
elif [[ -f "$SRC/substreamer7.db" ]]; then
  KIND=ios
else
  echo "Snapshot has neither app-data.tar.gz nor substreamer7.db — not a fixture."; exit 1
fi

command -v adb >/dev/null || { echo "adb not on PATH. Add \$HOME/Library/Android/sdk/platform-tools."; exit 1; }

DEVCOUNT=$(adb devices | grep -cw "device" || true)
if [[ -z "$SERIAL_ID" && "$DEVCOUNT" -gt 1 ]]; then
  echo "More than one device attached — pass -s <serial>:"; adb devices; exit 1
fi
[[ "$DEVCOUNT" -ge 1 ]] || { echo "No device/emulator attached."; exit 1; }

adbx wait-for-device
[[ "$(adbx shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] \
  || { echo "Device is attached but not finished booting."; exit 1; }

adbx shell pm list packages 2>/dev/null | grep -q "^package:$PKG$" \
  || { echo "$PKG is not installed on the target. Install a DEBUG build first."; exit 1; }

# run-as only works on a debuggable build, and it is the only way in without root.
adbx shell run-as "$PKG" true 2>/dev/null \
  || { echo "run-as refused: the installed build is not debuggable. Install a debug build."; exit 1; }

echo "Restoring $SNAP  ($KIND fixture)"
echo "Stopping the app so the restore is not torn..."
adbx shell am force-stop "$PKG"

TMP="$(mktemp -d -t substreamer-restore)"
trap 'rm -rf "$TMP"' EXIT
REMOTE=/data/local/tmp/substreamer-restore.tar

push_and_extract() {  # $1 = local .tar, already laid out relative to the app data dir
  adbx push "$1" "$REMOTE" >/dev/null
  # No `-C`: toybox tar refuses to chdir into the app dir even though the shell can, and
  # run-as already starts us there (/data/user/0/<pkg>), so the CWD is already right — and
  # extracting as the app uid is what gets ownership right.
  adbx shell "run-as $PKG tar -xf $REMOTE" \
    || { echo "Extract FAILED — app data is now partial. Re-run the restore."; adbx shell rm -f "$REMOTE"; exit 1; }
  adbx shell rm -f "$REMOTE"
}

if [[ "$KIND" == "android" ]]; then
  echo "Clearing existing app data..."
  # Only the app-owned trees. Deliberately NOT `pm clear`, which would also drop the
  # package's granted permissions and re-trigger first-run flows.
  appsh 'rm -rf files databases shared_prefs no_backup cache; true'

  # Decompress on the HOST. On-device gzip of a few hundred MB under an emulator is
  # minutes of CPU for no benefit — the push runs at hundreds of MB/s either way.
  echo "Decompressing $(du -h "$SRC/app-data.tar.gz" | awk '{print $1}')..."
  gzip -dc "$SRC/app-data.tar.gz" > "$TMP/app.tar"
else
  # iOS fixture: replace only the three trees it owns and leave the rest of the Android
  # app data alone — the dev-launcher bundle and shared_prefs belong to the target, not
  # to the fixture, and clearing them buys nothing.
  echo "Clearing SQLite / music-cache / image-cache..."
  # The `._*` sweep clears AppleDouble strays a previous run may have left beside the
  # three trees; removing only the trees themselves leaves them behind.
  appsh 'rm -rf files/SQLite files/music-cache files/image-cache files/._*; mkdir -p files; true'

  # Stage the exact layout that must land under the app data dir, then ship one tar.
  mkdir -p "$TMP/stage/files/SQLite"
  cp "$SRC/substreamer7.db" "$TMP/stage/files/SQLite/substreamer7.db"
  # No -wal/-shm on purpose: restore.sh deletes them on iOS too, and a WAL without its
  # own database is worse than none.
  for cache in image-cache music-cache; do
    if [[ -f "$SRC/$cache.tar.gz" ]]; then
      echo "Staging ${cache}..."
      tar -C "$TMP/stage/files" -xzf "$SRC/$cache.tar.gz"
    else
      # A fixture without this cache genuinely had none; the rm above already left it gone.
      echo "No ${cache} in this snapshot — leaving it absent."
    fi
  done
  # COPYFILE_DISABLE: macOS tar otherwise writes an AppleDouble `._x` sibling for every
  # entry, which lands in the app's music-cache as a phantom file beside each track —
  # measured, 47 downloads arrived as 94 files. The Android side has no use for them and
  # the cache reconcile would see them as strays.
  COPYFILE_DISABLE=1 tar -C "$TMP/stage" -cf "$TMP/app.tar" files
fi

echo "Pushing $(du -h "$TMP/app.tar" | awk '{print $1}')..."
echo "Extracting as the app user (this takes a minute)..."
push_and_extract "$TMP/app.tar"

echo "Verifying..."
# `stat`, not `cat | wc -c` — the database is tens of MB and there is no reason to stream
# it over adb just to learn its size.
DBSIZE=$(adbx shell "run-as $PKG stat -c %s files/SQLite/substreamer7.db" 2>/dev/null | tr -d '\r')
case "$DBSIZE" in
  ''|*[!0-9]*) echo "  FAILED: no database present after restore."; exit 1 ;;
esac
[[ "$DBSIZE" -gt 100000 ]] || { echo "  FAILED: database is only $DBSIZE bytes — the extract did not land."; exit 1; }
echo "  database: $DBSIZE bytes"
DLFILES=$(adbx shell "run-as $PKG find files/music-cache -type f" 2>/dev/null | tr -d '\r' | grep -c . || true)
echo "  downloaded files: $DLFILES"
adbx shell "run-as $PKG du -sh files" 2>/dev/null | sed 's/^/  /'

echo "Done. Launch the app to run the migration."
echo "NOTE: every run consumes the fixture — re-run this script before each attempt."
