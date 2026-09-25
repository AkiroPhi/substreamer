# Simulator fixture packages

Captured simulator state — a database plus its caches — that can be restored over and over
to test migrations and upgrades against **real data** rather than seeded rows.

**Nothing in here is committed except this file and the two scripts.** A snapshot is
gigabytes of real listening history, downloaded audio and library metadata; it belongs on
the machine that made it and nowhere else. `.gitignore` tracks the folder and ignores its
contents.

## Why bother

Unit tests seed the rows they expect. A real install has the rows nobody expected: an
install last opened three releases ago, a single-song download keyed `song:<id>`, a corrupt
index, half-converted blob storage. Every one of those has already found a bug that a
green test suite missed.

## Using one

```sh
./list.sh                                            # what is available, and what each covers
./restore.sh substreamer-v8.0.70-74_ipad-air-m4_mig28_47dl
```

`restore.sh` targets the **booted** simulator. It terminates the app first (a live WAL
gives a torn copy), replaces the database and both caches, and clears a cache the snapshot
does not have rather than leaving the previous fixture's copy behind. Relaunch the app
afterwards.

## Capturing one

```sh
APP=com.ghenry22.substream2
DOCS="$(xcrun simctl get_app_container booted $APP data)/Documents"
DEST="sim-snapshots/substreamer-<version>_<device>_mig<N>_<M>dl"

mkdir -p "$DEST"
sqlite3 "$DOCS/SQLite/substreamer7.db" ".backup '$DEST/substreamer7.db'"
tar -C "$DOCS" -czf "$DEST/music-cache.tar.gz" music-cache
tar -C "$DOCS" -czf "$DEST/image-cache.tar.gz" image-cache
```

Use `.backup`, not `cp`. It goes through SQLite's backup API and is consistent even with
the app running; copying the file while a WAL is live is not.

## Naming

    substreamer-<app version>_<device>_mig<counter>_<downloads>dl

The **migration counter** is the identifier that actually matters for migration testing —
it says where the upgrade starts from. Read it with:

```sh
sqlite3 <snapshot>/substreamer7.db "SELECT value FROM storage WHERE key='substreamer-migration';"
```

To turn a counter into an app version, find the release that introduced it:

```sh
for t in $(git tag --sort=v:refname); do
  m=$(git show "$t:src/services/migrationService.ts" </dev/null 2>/dev/null \
      | grep -E '^[[:space:]]+id: [0-9]+,' | tr -dc '0-9\n' | sort -n | tail -1)
  echo "$t $m"
done
```

A counter usually spans several releases, hence ranges like `v8.0.70-74`.

## manifest.json

Each snapshot carries one, so a test run can choose a fixture without opening anything.
Beyond the counts, two fields earn their place:

- **`exercises`** — what this fixture can actually prove.
- **`doesNotExercise`** — what it cannot, stated explicitly. Both current fixtures have
  every cached `album_id` already canonical, so neither covers album *directory* renaming.
  Without that line written down, a green run reads as broader coverage than it is.

Also record `knownIssues`. One fixture carries a corrupt index that predates any migration
work; without the note, a failure gets blamed on the code under test.

## What makes a set worth having

Fixtures are valuable in proportion to how *unlike each other* they are. Worth collecting:

- an install from **below the current migration baseline** — the upgrade path with the most
  steps, and the least exercised
- one **with downloads**, ideally where album ids are legacy too, so directory renaming is
  covered for the first time
- one at **library scale** — tens of thousands of rows, to catch anything quadratic
- one from a **different server** (Gonic, Airsonic, Subsonic), since id shapes and
  capabilities differ
- one **mid-migration** — killed part way, to prove resumption

## Automating against these

The split worth keeping: anything **SQL-only** — the migration chain, a re-key, collision
handling — runs headlessly against a restored database with no simulator at all, so it can
run on every change. Anything touching **files or UI** needs a booted simulator and is
slow. Keeping the two apart is what makes the cheap half worth running often.
