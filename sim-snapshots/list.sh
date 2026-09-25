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
print(f"{sys.argv[2]}")
print(f"    {m['source']['device']}  |  app {m['app']['versionRange']}  |  migration {m['app']['migrationCounter']}  |  {m['schemaEra']}")
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
