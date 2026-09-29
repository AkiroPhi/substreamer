#!/usr/bin/env bash
# Show every fixture package, so a test run can pick one without opening each README.
#   ./list.sh
set -euo pipefail
cd "$(dirname "$0")"
for d in substreamer-*/; do
  m="${d}manifest.json"
  [[ -f "$m" ]] || { echo "${d%/}  (no manifest)"; continue; }
  python3 - "$m" "${d%/}" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
c = m.get("contents", {})
src = m.get("source", {})
app = m.get("app", {})
print(f"{sys.argv[2]}")
plat = m.get("platform", src.get("platform", "ios"))
if m.get("derived"):
    # A hand-derived variant carries only what it changed; the rest lives in its base.
    print(f"    [{plat}] derived from {m.get('basedOn', '?')}")
    for line in m.get("whatChanged", []):
        print(f"    ~ {line}")
else:
    print(f"    [{plat}] {src.get('device','?')}  |  app {app.get('versionRange','?')}"
          f"  |  migration {app.get('migrationCounter','?')}  |  {m.get('schemaEra','?')}")
srv = m.get("server")
if srv:
    print(f"    server: {srv.get('type','?')} {srv.get('version','?')}")
if c:
    print(f"    downloads: {c.get('musicCacheFiles', 0)} files"
          + (f", {c.get('cachedSongsWithLegacyIds')} of {c.get('cachedSongs')} songs re-key" if c.get('cachedSongs') else "")
          + (f"  |  library: {c['songs']} songs, {c.get('songsWithLegacyIds', 0)} re-key" if c.get('songs') else ""))
for line in m.get("exercises", []):
    print(f"    + {line}")
for line in m.get("doesNotExercise", []):
    print(f"    - {line}")
for line in m.get("knownIssues", []):
    print(f"    ! {line}")
print()
PY
done
