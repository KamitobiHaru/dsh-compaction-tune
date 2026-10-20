#!/usr/bin/env node
/**
 * Write the compaction knobs into `$DSH_HOME/.env` and show what they resolve to.
 * DSH refuses `DSH_*` names in a `.env` file (bootstrap-only), so this script
 * uses the `HARNESS_COMPACTION_*` names the bundle reads first.
 *
 * The two knobs apply to every tuned preset this bundle ships, so one machine
 * has one compaction policy; a preset only decides which tools the agent sees.
 *
 * Usage:
 *   node scripts/set-ratio.mjs 0.001                 # threshold only, retain derived
 *   node scripts/set-ratio.mjs 0.001 --retain 0.0005 # both knobs
 *   node scripts/set-ratio.mjs --unset               # remove both lines
 *   node scripts/set-ratio.mjs --show                # print the current table only
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const positional = argv.filter((value, index) => !value.startsWith('--') && !(index > 0 && argv[index - 1].startsWith('--') && argv[index - 1] !== '--unset'));

const home = L.resolveDshHome(option('home'));
const file = join(home, '.env');
const keys = new Set([L.THRESHOLD_ENV, L.RETAIN_ENV, L.THRESHOLD_ENV_ALIAS, L.RETAIN_ENV_ALIAS]);

// Every route the profile declares, read from its own patch layer, so the table
// covers all providers instead of a hardcoded sample.
const declared = L.collectProfileModels({ home, profile: option('profile'), installDir: option('install') });
if (declared.note !== undefined) console.log(`note: ${declared.note}`);
else console.log(`models from ${declared.file}`);
if (declared.missing.length > 0) {
  for (const row of declared.missing) console.log(`warning: ${row.label} ${row.reason}`);
}

function show(current) {
  const threshold = current[L.THRESHOLD_ENV];
  const retain = current[L.RETAIN_ENV];
  const cases = [
    ['DSH default (0.8)', 0.8, 0.16],
    ['bundle default (0.4)', L.DEFAULT_THRESHOLD_RATIO, L.DEFAULT_RETAIN_RATIO]
  ];
  if (threshold !== undefined) {
    const t = Number(threshold);
    cases.push([`current (${threshold})`, t, retain === undefined ? Math.min(L.DEFAULT_RETAIN_RATIO, t / 2) : Number(retain)]);
  }
  console.log(L.formatSpecTable(cases, declared.models.length > 0 ? declared.models : L.FALLBACK_MODELS));
}

const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
const current = {};
for (const line of existing.split(/\r?\n/)) {
  const [key, ...rest] = line.split('=');
  if (keys.has(key.trim())) current[key.trim()] = rest.join('=').trim();
}

if (flag('show') || (positional.length === 0 && !flag('unset'))) {
  console.log(`knobs in ${file}: ${Object.keys(current).length === 0 ? '(none)' : JSON.stringify(current)}`);
  console.log('');
  show(current);
  process.exit(0);
}

const lines = existing.split(/\r?\n/).filter((line) => !keys.has(line.split('=')[0].trim()));
while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

if (flag('unset')) {
  const next = lines.length === 0 ? '' : lines.join('\n') + '\n';
  if (next === '') {
    if (existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  } else {
    writeFileSync(file, next, { mode: 0o600 });
  }
  console.log(`removed the compaction knobs from ${file}`);
  console.log('restart dsh for the shipped default (0.8 / 0.16) to take effect.');
  process.exit(0);
}

const raw = positional[0];
if (raw === undefined) {
  console.error('usage: node scripts/set-ratio.mjs <thresholdRatio> [--retain <ratio>] [--unset|--show]');
  process.exit(2);
}
const threshold = Number(raw);
if (!(threshold > 0 && threshold <= 1)) {
  console.error(`threshold ratio must be in (0, 1], got ${JSON.stringify(raw)}`);
  process.exit(2);
}
let retain;
if (option('retain') !== undefined) {
  retain = Number(option('retain'));
  if (!(retain > 0 && retain < threshold)) {
    console.error(`retain ratio must be in (0, ${threshold}), got ${JSON.stringify(option('retain'))}`);
    process.exit(2);
  }
}

lines.push(`${L.THRESHOLD_ENV}=${threshold}`);
if (retain !== undefined) lines.push(`${L.RETAIN_ENV}=${retain}`);
writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });

console.log(`wrote ${file}:`);
console.log(`  ${L.THRESHOLD_ENV}=${threshold}`);
console.log(`  ${L.RETAIN_ENV}=${retain === undefined ? `(derived: ${Math.min(L.DEFAULT_RETAIN_RATIO, threshold / 2)})` : retain}`);
console.log('');
console.log(L.formatSpecTable([[
  'current', threshold, retain === undefined ? Math.min(L.DEFAULT_RETAIN_RATIO, threshold / 2) : retain
]], declared.models.length > 0 ? declared.models : L.FALLBACK_MODELS));
console.log('');
console.log('this is read once at boot: restart the dsh that runs this profile to apply it.');
console.log('(an environment variable exported in the launching shell wins over .env and needs no file edit)');
