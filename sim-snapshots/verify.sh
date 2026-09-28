#!/usr/bin/env bash
#
# Restore a fixture, boot the app, wait for the migration chain and the Navidrome re-key
# to settle, then ASSERT the end state. One line per run; repeat it to catch anything
# timing-dependent — the write-ordering bug this was built for failed 5 runs in 6 and
# would have looked fixed after a single green one.
#
#   ./verify.sh label            one cycle
#   for i in 1 2 3 4 5 6; do ./verify.sh "run-$i"; done
#
# Needs: a booted simulator with the app installed, and Metro running if it is a dev
# build. A dev client with no Metro boots into nothing and every field reads empty —
# if the migration counter stays at the fixture's value, check Metro first.
set -u
cd "$(dirname "$0")/.."
SNAPDIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="${1:-run}"
xcrun simctl terminate booted com.ghenry22.substream2 >/dev/null 2>&1; sleep 1
"$SNAPDIR/restore.sh" substreamer-v8.0.70-74_ipad-air-m4_mig28_47dl >/dev/null 2>&1
DOCS="$(xcrun simctl get_app_container booted com.ghenry22.substream2 data)/Documents"
DB="$DOCS/SQLite/substreamer7.db"
BASE=$(wc -l < "$DOCS/library-sync-diagnostics.log" 2>/dev/null || echo 0)
xcrun simctl launch booted com.ghenry22.substream2 >/dev/null 2>&1
# wait for the pass to resolve
for i in $(seq 1 100); do
  grep -q "\[reid\] \(complete\|failed\)" <(tail -n +$((BASE+1)) "$DOCS/library-sync-diagnostics.log" 2>/dev/null) && break
  sleep 2
done
REID=$(tail -n +$((BASE+1)) "$DOCS/library-sync-diagnostics.log" 2>/dev/null | grep -o "\[reid\] \(complete\|failed.*\)" | head -1)
# wait for the refill sync to finish
for i in $(seq 1 90); do
  grep -q "run done" <(tail -n +$((BASE+1)) "$DOCS/library-sync-diagnostics.log" 2>/dev/null) && break
  sleep 2
done
sleep 3
CNT=$(sqlite3 "$DB" "SELECT json_extract(value,'\$.state.completedVersion') FROM storage WHERE key='substreamer-migration';" 2>/dev/null)
ETL=$(sqlite3 "$DB" "SELECT COALESCE((SELECT value FROM storage WHERE key='substreamer-normalized-migration-complete'),'UNSET');" 2>/dev/null)
SONGS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM songs;" 2>/dev/null)
LEG=$(sqlite3 "$DB" "SELECT COUNT(*) FROM songs WHERE length(id)=32;" 2>/dev/null)
DUP=$(sqlite3 "$DB" "SELECT COUNT(*) FROM (SELECT title,album_id,disc_number,track FROM songs GROUP BY title,album_id,disc_number,track HAVING COUNT(*)>1);" 2>/dev/null)
DL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM cached_songs;" 2>/dev/null)
FILES=$(find "$DOCS/music-cache" -type f 2>/dev/null | wc -l | tr -d ' ')
# 1 duplicate is the known Navidrome-side same-path pair; legacy must be 0.
if [ "$REID" = "[reid] complete" ] && [ "$ETL" = "3" ] && [ "$CNT" = "42" ] && [ "$LEG" = "0" ] && [ "${DUP:-9}" -le 1 ] && [ "$DL" = "47" ] && [ "$FILES" = "47" ]; then V="PASS"; else V="FAIL"; fi
printf "%-9s %-4s cnt=%-3s etl=%-5s songs=%-6s legacy=%-3s dup=%-3s dl=%s/%s  %s\n" \
  "$LABEL" "$V" "$CNT" "$ETL" "$SONGS" "$LEG" "$DUP" "$DL" "$FILES" "${REID:0:40}"
