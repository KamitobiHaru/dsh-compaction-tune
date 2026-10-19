#!/usr/bin/env node
/**
 * Prove three things before this bundle is installed or upgraded:
 *   1. `cordis.patch.yml` is exactly the generator's output for the installed
 *      shipped preset -- the tuned preset is upstream plus one injected config;
 *   2. DSH's own dump/parse dialect round-trips the `!!js` markers;
 *   3. the injected expression yields the expected policy for a table of
 *      environment values and refuses invalid ones.
 * Finally it prints the resulting token thresholds for this profile's models.
 *
 * Usage: node scripts/verify.mjs [--install <dsh package dir>] [--from <standard.patch.yml>]
 */
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const root = join(import.meta.dirname, '..');
const installDir = L.resolveInstallDir(option('install'));
const tools = L.loadDshTools(installDir);
const source = L.resolvePresetSource(installDir, option('from'));
const upstream = L.readEntryList(tools, source);
const written = L.readEntryList(tools, join(root, 'cordis.patch.yml'));

let failed = 0;
function check(label, body) {
  try {
    body();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
/** Trim `!!js` sources so a dump that adds a trailing newline still compares equal. */
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === '__jsExpr' && typeof value === 'string' ? value.trim() : normalize(value);
    }
    return out;
  }
  return node;
}
/** Drop the injected config from every compaction-basic row so both sides compare. */
function scrub(rows) {
  const copy = normalize(rows);
  const visit = (rows) => {
    for (const row of rows ?? []) {
      if (row?.id === L.COMPACTION_ROW_ID) delete row.config;
      for (const key of ['config', 'plugins']) if (Array.isArray(row?.[key])) visit(row[key]);
    }
  };
  visit(copy);
  return copy;
}

console.log(`dsh ${L.dshVersion(installDir)}`);
console.log(`upstream ${source}`);
console.log('');

check('cordis.patch.yml is exactly what the generator produces', () => {
  assert(isDeepStrictEqual(normalize(written), normalize(L.buildPatchList(upstream))), 'the file differs from `node scripts/sync.mjs` output');
});
check('the shipped preset round-trips through the DSH dump/parse dialect', () => {
  const again = tools.yaml.load(L.dumpEntryList(tools, upstream), { schema: tools.entryListSchema });
  assert(isDeepStrictEqual(normalize(again), normalize(upstream)), 'a !!js marker or scalar was lost in the round trip');
});

const standard = L.findInsertedRow(upstream, L.UPSTREAM_PRESET_ROW_ID);
const tuned = L.findInsertedRow(written, L.TUNED_PRESET_ROW_ID);

check('the tuned preset is the shipped preset plus only the injected compaction config', () => {
  assert(isDeepStrictEqual(scrub(tuned.config.plugins), scrub(standard.config.plugins)), 'plugin rows differ beyond compaction-basic');
});
check('the tuned preset changes only id/name/description/order', () => {
  const expected = structuredClone(standard.config);
  expected.id = L.TUNED_PRESET_ID;
  expected.name = L.PRESET_DISPLAY_NAME;
  expected.description = L.PRESET_DESCRIPTION;
  expected.order = L.PRESET_ORDER;
  assert(isDeepStrictEqual(scrub([tuned.config])[0], scrub([expected])[0]), 'a field of the preset declaration differs from the generator');
});
check('the registry override selects the tuned preset and still supplies the required default', () => {
  const row = written.find((entry) => entry.id === L.REGISTRY_ROW_ID);
  assert(row !== undefined, 'the file carries no agent-preset-registry override');
  assert(isDeepStrictEqual(row.config, { default: L.TUNED_PRESET_ID, selectedDefault: L.TUNED_PRESET_ID }), `unexpected registry config ${JSON.stringify(row.config)}`);
});
check('no other row is patched', () => {
  const ids = written.filter((entry) => entry.insert === undefined).map((entry) => entry.id);
  assert(ids.every((id) => id === L.REGISTRY_ROW_ID), `unexpected patch targets ${JSON.stringify(ids)}`);
});

const compaction = L.findPlugin(tuned.config.plugins, L.COMPACTION_ROW_ID);
const expression = compaction?.config?.__jsExpr;
check('compaction-basic carries exactly the expression scripts/lib.mjs declares', () => {
  assert(typeof expression === 'string' && expression.trim() === L.EXPRESSION.trim(), 'the expression in the file is not the one scripts/lib.mjs declares');
});

console.log('');
console.log('environment knobs, evaluated through the Loader expression wrapper:');
const cases = [
  { env: {}, expect: { thresholdRatio: L.DEFAULT_THRESHOLD_RATIO, retainRatio: L.DEFAULT_RETAIN_RATIO } },
  { env: { [L.THRESHOLD_ENV]: '0.4' }, expect: { thresholdRatio: 0.4, retainRatio: L.DEFAULT_RETAIN_RATIO } },
  { env: { [L.THRESHOLD_ENV]: '0.001' }, expect: { thresholdRatio: 0.001, retainRatio: 0.0005 } },
  { env: { [L.THRESHOLD_ENV]: '1' }, expect: { thresholdRatio: 1, retainRatio: L.DEFAULT_RETAIN_RATIO } },
  { env: { [L.THRESHOLD_ENV]: '0.4', [L.RETAIN_ENV]: '0.1' }, expect: { thresholdRatio: 0.4, retainRatio: 0.1 } },
  { env: { [L.THRESHOLD_ENV_ALIAS]: '0.3' }, expect: { thresholdRatio: 0.3, retainRatio: L.DEFAULT_RETAIN_RATIO } }
];
for (const { env, expect } of cases) {
  check(`${JSON.stringify(env)} -> ${JSON.stringify(expect)}`, () => {
    const got = L.withEnv(env, () => L.evaluateExpression({}, expression));
    assert(isDeepStrictEqual(got, expect), `got ${JSON.stringify(got)}`);
  });
}
for (const value of ['0', '1.5', 'abc', '-0.1', '']) {
  check(`threshold ${JSON.stringify(value)} is refused`, () => {
    let threw = false;
    try {
      L.withEnv({ [L.THRESHOLD_ENV]: value }, () => L.evaluateExpression({}, expression));
    } catch {
      threw = true;
    }
    assert(threw, 'the expression accepted an invalid ratio');
  });
}
check('an explicit retain at the threshold is refused', () => {
  let threw = false;
  try {
    L.withEnv({ [L.THRESHOLD_ENV]: '0.4', [L.RETAIN_ENV]: '0.4' }, () => L.evaluateExpression({}, expression));
  } catch {
    threw = true;
  }
  assert(threw, 'the expression accepted retainRatio = thresholdRatio');
});

console.log('');
console.log('effective compaction policy (threshold = floor(min(contextWindow * ratio, budget - 65536))):');
const declared = L.collectProfileModels({ home: option('home'), profile: option('profile'), installDir });
if (declared.note !== undefined) console.log(`  note: ${declared.note}, showing sample routes`);
else console.log(`  models from ${declared.file}`);
for (const row of declared.missing) console.log(`  warning: ${row.label} ${row.reason}`);
console.log(L.formatSpecTable([
  ['DSH default (0.8)', 0.8, 0.16],
  ['bundle default (0.4)', L.DEFAULT_THRESHOLD_RATIO, L.DEFAULT_RETAIN_RATIO],
  ['test value (0.001)', 0.001, 0.0005]
], declared.models.length > 0 ? declared.models : L.FALLBACK_MODELS));

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
