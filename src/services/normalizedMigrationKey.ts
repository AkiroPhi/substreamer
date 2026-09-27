/**
 * The blob-to-SQL ETL's completion key and the version it stamps.
 *
 * A leaf module on purpose. These live here rather than in `dataModelUpgradeService`
 * because the Navidrome re-key also has to stamp them, and importing them from there
 * pulled `migrationService` — and everything it reaches — into the re-key's module
 * initialisation graph, for the sake of two string constants.
 *
 * VERSIONED rather than a boolean: when the migration gains a step, bump this so
 * already-stamped installs re-run (the ETL is idempotent upserts) rather than stacking a
 * second migration on top of the first.
 */
export const MIGRATION_DONE_KEY = 'substreamer-normalized-migration-complete';
export const MIGRATION_VERSION = '3';
