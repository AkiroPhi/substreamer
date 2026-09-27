#!/usr/bin/env node
/**
 * Run the same checks GitHub Actions runs, read out of the workflow itself.
 *
 * Deliberately NOT a hand-maintained copy of the step list. A copy drifts, and the way
 * you find out is a red build on master — which is exactly how `validate-intl` got
 * missed. Parsing `.github/workflows/tests.yml` means a step added there is picked up
 * here with no second edit.
 *
 * Two kinds of step are skipped, both reported so the difference is never silent:
 *   - `npm ci`, which would wipe and reinstall node_modules on every local run
 *   - anything gated on `github.ref`, which is publishing (the coverage badge and its
 *     commit), not validation
 *
 * Fails fast on the first non-zero exit, as the workflow does.
 */

const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const WORKFLOW = join(__dirname, '..', '.github', 'workflows', 'tests.yml');

/** Split the `steps:` block into one entry per `- ` item, keeping each step's lines. */
function parseSteps(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (start === -1) return [];
  const steps = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    // A new job would dedent past the steps list; stop there.
    if (/^\s{0,4}\S/.test(line) && line.trim() !== '') break;
    if (/^\s*- /.test(line)) {
      if (current) steps.push(current);
      current = [line.replace(/^\s*- /, '')];
    } else if (current && line.trim() !== '') {
      current.push(line.trim());
    }
  }
  if (current) steps.push(current);
  return steps;
}

function fieldOf(step, key) {
  const hit = step.find((l) => l.startsWith(`${key}:`));
  return hit === undefined ? null : hit.slice(key.length + 1).trim();
}

const steps = parseSteps(readFileSync(WORKFLOW, 'utf8'));
const toRun = [];
const skipped = [];

for (const step of steps) {
  const run = fieldOf(step, 'run');
  if (run === null) continue;                       // `uses:` steps — checkout, setup-node
  const name = fieldOf(step, 'name') ?? run;
  const gate = fieldOf(step, 'if');
  if (gate !== null && gate.includes('github.ref')) {
    skipped.push([name, 'CI-only publishing step']);
    continue;
  }
  if (run === 'npm ci') {
    skipped.push([name || run, 'would reinstall node_modules']);
    continue;
  }
  if (run === '|') {
    // A multiline block that is not ref-gated: cannot be reproduced faithfully here.
    skipped.push([name, 'multiline block — run it in CI']);
    continue;
  }
  toRun.push([name, run]);
}

if (toRun.length === 0) {
  console.error('local-ci: parsed no runnable steps from the workflow — has its shape changed?');
  process.exit(1);
}

console.log(`local-ci: ${toRun.length} step(s) from ${WORKFLOW.replace(process.cwd() + '/', '')}\n`);
for (const [name, why] of skipped) console.log(`  skipped  ${name}  (${why})`);
if (skipped.length > 0) console.log('');

const started = Date.now();
for (const [name, cmd] of toRun) {
  console.log(`\x1b[1m▶ ${name}\x1b[0m\n  ${cmd}`);
  const res = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error(`\n\x1b[31m✗ ${name} failed (exit ${res.status ?? 'signal'})\x1b[0m`);
    console.error('  This is what CI would report. Fix it before pushing.');
    process.exit(res.status ?? 1);
  }
}
console.log(`\n\x1b[32m✓ all ${toRun.length} CI steps passed\x1b[0m (${Math.round((Date.now() - started) / 1000)}s)`);
