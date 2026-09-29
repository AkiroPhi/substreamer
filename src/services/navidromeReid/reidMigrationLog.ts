/**
 * Append the re-key's decision and outcome to `migration-log.txt`.
 *
 * NOT the library-sync diagnostic log. That one is gated behind a flag file that is off
 * by default, so on a user's device the whole pass left no trace — which is exactly why
 * a TestFlight report had to be reproduced on a fixture instead of read. The migration
 * log is always written and is already viewable and shareable in Settings > Logging,
 * alongside the other logs, so a user can simply send it.
 *
 * Appended rather than written: `runMigrations` owns the file and writes the numbered
 * chain's section first; this adds its own section after it.
 */

import { File, Paths } from 'expo-file-system';

import { currentServerInfo, hasServerAnswered, probedServerVersion, reidVerdict } from './reidMarker';

const LOG_FILE_NAME = 'migration-log.txt';

/** One line per fact, so a shared log is greppable and diffable between runs. */
function stateLines(verdict: string): string[] {
  const { serverType, serverVersion } = currentServerInfo();
  return [
    `  server type      : ${serverType ?? '(unknown)'}`,
    `  version (stored) : ${serverVersion ?? '(none)'}`,
    `  version (probed) : ${probedServerVersion() ?? '(no answer this launch)'}`,
    `  server answered  : ${hasServerAnswered() ? 'yes' : 'no'}`,
    `  verdict          : ${verdict}`,
  ];
}

/**
 * Record what the re-key did, or why it did nothing.
 *
 * Best-effort: a log write must never be the thing that fails a migration, so every
 * failure is swallowed — this is the one place where that is the right call, because
 * nothing reads the file back.
 */
export function appendReidLog(
  headline: string,
  detail: readonly string[] = [],
  /**
   * The verdict that CAUSED this outcome. Must be passed by anything logging after the
   * pass finished: `reidVerdict()` reads the marker, and a completed marker makes it
   * return `skip` — so a successful run used to record "verdict: skip", which reads as
   * though the pass had declined to do anything.
   */
  verdict: string = reidVerdict(),
): void {
  try {
    const lines = [
      '',
      `--- Navidrome re-key: ${headline} ---`,
      `  at               : ${new Date().toISOString()}`,
      ...stateLines(verdict),
      ...detail.map((d) => `  ${d}`),
      '',
    ];
    new File(Paths.document, LOG_FILE_NAME).write(`${lines.join('\n')}\n`, { append: true });
  } catch {
    /* the pass matters more than its record of itself */
  }
}
