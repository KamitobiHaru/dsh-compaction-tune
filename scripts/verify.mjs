#!/usr/bin/env node
/**
 * Prove three things before this bundle is installed or upgraded:
 *   1. `cordis.patch.yml` is exactly the generator's output for the installed
 *      shipped presets -- each tuned preset is its source plus one injected
 *      config;
 *   2. DSH's own dump/parse dialect round-trips the `!!js` markers;
 *   3. the injected expression yields the expected policy for a table of
 *      environment values and refuses invalid ones.
 * Finally it prints the resulting token thresholds for this profile's models.
 *
 * Usage: node scripts/verify.mjs [--install <dsh package dir>]
 *                                [--from-standard <standard.patch.yml>]
 *                                [--from-minimal <minimal.patch.yml>]
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
const sources = L.resolvePresetSources(installDir, {
  standard: option('from-standard'),
  minimal: option('from-minimal')
});
const upstream = Object.fromEntries(
  Object.entries(sources).map(([name, file]) => [name, L.readEntryList(tools, file)])
);
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
/** The plugin rows of a declaration, including nested group configs. */
function allRows(rows, found = []) {
  for (const row of rows ?? []) {
    found.push(row);
    if (Array.isArray(row.config)) allRows(row.config, found);
  }
  return found;
}
/**
 * The package a plugin spec belongs to. A spec may name a subpath export
 * (`@scope/pkg/list-agents`), whose package is still the scope and the first
 * segment.
 */
function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

console.log(`dsh ${L.dshVersion(installDir)}`);
for (const name of L.SOURCE_PRESET_NAMES) console.log(`${name} ${sources[name]}`);
console.log('');

check('cordis.patch.yml is exactly what the generator produces', () => {
  assert(isDeepStrictEqual(normalize(written), normalize(L.buildPatchList(upstream))), 'the file differs from `node scripts/sync.mjs` output');
});
check('the shipped presets round-trip through the DSH dump/parse dialect', () => {
  for (const name of L.SOURCE_PRESET_NAMES) {
    const again = tools.yaml.load(L.dumpEntryList(tools, upstream[name]), { schema: tools.entryListSchema });
    assert(isDeepStrictEqual(normalize(again), normalize(upstream[name])), `a !!js marker or scalar was lost in the ${name} round trip`);
  }
});

check('the file carries one declaration row per tuned preset', () => {
  const insert = written.filter((entry) => entry.insert !== undefined);
  assert(insert.length === 1, `expected one insert patch, found ${insert.length}`);
  const ids = insert[0].insert.map((row) => row.id);
  const expected = L.TUNED_PRESETS.map((spec) => spec.rowId);
  assert(isDeepStrictEqual(ids, expected), `inserted rows ${JSON.stringify(ids)} do not match ${JSON.stringify(expected)}`);
});

for (const spec of L.TUNED_PRESETS) {
  const source = L.findInsertedRow(upstream[spec.source], spec.sourceRowId);
  const tuned = L.findInsertedRow(written, spec.rowId);

  check(`${spec.id} is the shipped ${spec.source} preset plus only the injected compaction config`, () => {
    assert(isDeepStrictEqual(scrub(tuned.config.plugins), scrub(source.config.plugins)), 'plugin rows differ beyond compaction-basic');
  });
  check(`${spec.id} changes only id/name/description/order`, () => {
    const expected = structuredClone(source.config);
    expected.id = spec.id;
    expected.name = spec.name;
    expected.description = spec.description;
    expected.order = spec.order;
    assert(isDeepStrictEqual(scrub([tuned.config])[0], scrub([expected])[0]), 'a field of the preset declaration differs from the generator');
  });
  check(`${spec.id} keeps the shipped ${spec.source} plugin list verbatim`, () => {
    const wanted = allRows(source.config.plugins).map((row) => row.id);
    const got = allRows(tuned.config.plugins).map((row) => row.id);
    assert(isDeepStrictEqual(got, wanted), `plugin rows differ: ${JSON.stringify(got)} vs ${JSON.stringify(wanted)}`);
  });
  check(`${spec.id} declares its id, display name, description and order`, () => {
    assert(tuned.name === L.PRESET_PLUGIN_NAME, `${tuned.id} mounts ${tuned.name}`);
    assert(tuned.config?.id === spec.id, `${tuned.id} declares preset id ${JSON.stringify(tuned.config?.id)}`);
    assert(tuned.config?.name === spec.name, `${tuned.id} declares name ${JSON.stringify(tuned.config?.name)}`);
    assert(tuned.config?.description === spec.description, `${tuned.id} declares description ${JSON.stringify(tuned.config?.description)}`);
    assert(tuned.config?.order === spec.order, `${tuned.id} declares order ${JSON.stringify(tuned.config?.order)}`);
  });
  check(`${spec.id} mounts no plugin outside the installed DSH`, () => {
    for (const plugin of allRows(tuned.config.plugins)) {
      const name = plugin.name;
      if (name.startsWith('cordis:') || name.startsWith('.')) continue;
      tools.require.resolve(`${packageOf(name)}/package.json`);
    }
  });

  const compaction = L.findPlugin(tuned.config.plugins, L.COMPACTION_ROW_ID);
  check(`${spec.id} carries exactly the expression scripts/lib.mjs declares`, () => {
    const expression = compaction?.config?.__jsExpr;
    assert(typeof expression === 'string' && expression.trim() === L.EXPRESSION.trim(), 'the expression in the file is not the one scripts/lib.mjs declares');
  });
}

check('the compact preset keeps the shipped minimal compaction group as it is', () => {
  // The `minimal` source ships no tool-result-pruner and no toolResultPruner
  // isolation realm; the tuned copy must not add either.
  const spec = L.TUNED_PRESETS.find((candidate) => candidate.source === 'minimal');
  const tuned = L.findInsertedRow(written, spec.rowId);
  const group = L.findPlugin(tuned.config.plugins, 'compaction');
  assert(group !== undefined, 'the compact preset declares no compaction group');
  assert(!Object.keys(group.isolate ?? {}).includes('toolResultPruner'), 'the compact preset isolates a toolResultPruner service it does not mount');
  assert(
    !allRows(group.config).some((row) => row.name === '@deepseek-ai/dsh-compaction-tool-result-pruner'),
    'the compact preset mounts a tool-result-pruner the shipped minimal preset does not'
  );
});

check('the registry override selects the default preset and still supplies the required default', () => {
  const row = written.find((entry) => entry.id === L.REGISTRY_ROW_ID);
  assert(row !== undefined, 'the file carries no agent-preset-registry override');
  assert(
    isDeepStrictEqual(row.config, { default: L.DEFAULT_TUNED_PRESET_ID, selectedDefault: L.DEFAULT_TUNED_PRESET_ID }),
    `unexpected registry config ${JSON.stringify(row.config)}`
  );
});
check('no other row is patched', () => {
  const ids = written.filter((entry) => entry.insert === undefined).map((entry) => entry.id);
  assert(ids.every((id) => id === L.REGISTRY_ROW_ID), `unexpected patch targets ${JSON.stringify(ids)}`);
});

const expression = L.findPlugin(
  L.findInsertedRow(written, L.TUNED_PRESETS[0].rowId).config.plugins,
  L.COMPACTION_ROW_ID
)?.config?.__jsExpr;

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
