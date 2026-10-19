/**
 * Shared helpers for the dsh-compaction-tune bundle scripts.
 *
 * Every script loads DSH's own entry-list YAML dialect (`entryListSchema`) and
 * the installation's own `js-yaml`, so a generated patch round-trips exactly
 * the way the Cordis Loader reads it -- `!!js` markers included.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Loader row id of the preset this bundle adds. */
export const TUNED_PRESET_ROW_ID = 'preset-standard-tuned';
/** Loader row id of the shipped preset it derives from. */
export const UPSTREAM_PRESET_ROW_ID = 'preset-standard';
/** Preset id (inside the declaration) this bundle adds. */
export const TUNED_PRESET_ID = 'standard-tuned';
/** Preset id of the shipped declaration. */
export const UPSTREAM_PRESET_ID = 'standard';
export const PRESET_PLUGIN_NAME = '@deepseek-ai/dsh-agent-preset';
export const REGISTRY_ROW_ID = 'agent-preset-registry';
export const COMPACTION_ROW_ID = 'compaction-basic';
export const PRESET_DISPLAY_NAME = 'standard (compaction-tuned)';
export const PRESET_DESCRIPTION = 'The shipped standard preset with the compaction threshold and retained tail read from HARNESS_COMPACTION_THRESHOLD_RATIO and HARNESS_COMPACTION_RETAIN_RATIO at boot.';
export const PRESET_ORDER = 1;

export const THRESHOLD_ENV = 'HARNESS_COMPACTION_THRESHOLD_RATIO';
export const RETAIN_ENV = 'HARNESS_COMPACTION_RETAIN_RATIO';
export const THRESHOLD_ENV_ALIAS = 'DSH_COMPACTION_THRESHOLD_RATIO';
export const RETAIN_ENV_ALIAS = 'DSH_COMPACTION_RETAIN_RATIO';
export const ENV_KEYS = [THRESHOLD_ENV, RETAIN_ENV, THRESHOLD_ENV_ALIAS, RETAIN_ENV_ALIAS];
export const DEFAULT_THRESHOLD_RATIO = 0.4;
export const DEFAULT_RETAIN_RATIO = 0.16;
export const HEADROOM_TOKENS = 65536;

/**
 * The single `!!js` expression this bundle injects into the preset's
 * `compaction-basic` row. Edit this constant and re-run `sync.mjs`; the
 * generated patch is checked against it by `verify.mjs`.
 */
export const EXPRESSION = `(() => {
  const env = process.env;
  const thresholdRatio = Number(env.HARNESS_COMPACTION_THRESHOLD_RATIO ?? env.DSH_COMPACTION_THRESHOLD_RATIO ?? 0.4);
  const retainRatio = Number(env.HARNESS_COMPACTION_RETAIN_RATIO ?? env.DSH_COMPACTION_RETAIN_RATIO ?? Math.min(0.16, thresholdRatio / 2));
  if (!(thresholdRatio > 0 && thresholdRatio <= 1)) {
    throw new Error('compaction threshold ratio must be in (0, 1], got ' + thresholdRatio + '; set HARNESS_COMPACTION_THRESHOLD_RATIO');
  }
  if (!(retainRatio > 0 && retainRatio < thresholdRatio)) {
    throw new Error('compaction retain ratio must be in (0, ' + thresholdRatio + '), got ' + retainRatio + '; set HARNESS_COMPACTION_RETAIN_RATIO');
  }
  return { thresholdRatio, retainRatio };
})()`;

/** The Loader's own expression wrapper, so verification evaluates what DSH evaluates. */
export const evaluateExpression = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }');

/** Absolute path of the dsh installation, from `which dsh` unless given. */
export function resolveInstallDir(explicit) {
  let dir;
  if (explicit !== undefined) dir = realpathSync(resolve(explicit));
  else {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    let bin;
    try {
      bin = execFileSync(finder, ['dsh'], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    } catch {
      throw new Error('cannot find the dsh CLI on PATH; pass --install <path of the installed @deepseek-ai/dsh package>');
    }
    if (bin === undefined) throw new Error('cannot find the dsh CLI on PATH; pass --install <path of the installed @deepseek-ai/dsh package>');
    const real = realpathSync(bin);
    dir = dirname(dirname(real));
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh') throw new Error(`${dir} is not the @deepseek-ai/dsh package (found ${JSON.stringify(manifest.name)})`);
  return dir;
}

/** dsh installation anchor plus the YAML dialect and parser that installation ships. */
export function loadDshTools(installDir) {
  const require = createRequire(join(installDir, 'package.json'));
  const yaml = require('js-yaml');
  const include = require('@deepseek-ai/cordis-plugin-include');
  if (include.entryListSchema === undefined) throw new Error('@deepseek-ai/cordis-plugin-include exports no entryListSchema');
  return { require, yaml, entryListSchema: include.entryListSchema, installDir };
}

/** The shipped `standard` preset patch file that this bundle is generated from. */
export function resolvePresetSource(installDir, explicit) {
  if (explicit !== undefined) return resolve(explicit);
  const require = createRequire(join(installDir, 'package.json'));
  return join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets', 'standard.patch.yml');
}

export function dshVersion(installDir) {
  return JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version;
}

export function readEntryList(tools, file) {
  const data = tools.yaml.load(readFileSync(file, 'utf8'), { schema: tools.entryListSchema });
  if (!Array.isArray(data)) throw new Error(`${file} must hold a top-level YAML array of loader entries`);
  return data;
}

export function dumpEntryList(tools, data) {
  return tools.yaml.dump(data, { schema: tools.entryListSchema, noRefs: true, lineWidth: -1 });
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** One row inserted by an `insert:` patch. */
export function findInsertedRow(entries, rowId) {
  for (const entry of entries) {
    for (const row of entry?.insert ?? []) if (row?.id === rowId) return row;
  }
  throw new Error(`no inserted loader row has id ${JSON.stringify(rowId)}`);
}

/** One plugin row of a preset declaration, searched through nested group configs. */
export function findPlugin(rows, rowId) {
  for (const row of rows ?? []) {
    if (row?.id === rowId) return row;
    if (Array.isArray(row?.config)) {
      const hit = findPlugin(row.config, rowId);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * The complete patch list this bundle ships: the tuned preset declaration plus
 * the registry override that selects it. `sync.mjs` writes exactly this and
 * `verify.mjs` asserts the written file still equals it.
 */
export function buildPatchList(upstream) {
  const standard = findInsertedRow(upstream, UPSTREAM_PRESET_ROW_ID);
  if (standard.config?.id !== UPSTREAM_PRESET_ID) {
    throw new Error(`${UPSTREAM_PRESET_ROW_ID} no longer declares preset id ${JSON.stringify(UPSTREAM_PRESET_ID)}`);
  }
  const tuned = {
    id: TUNED_PRESET_ID,
    name: PRESET_DISPLAY_NAME,
    description: PRESET_DESCRIPTION,
    order: PRESET_ORDER,
    plugins: structuredClone(standard.config.plugins)
  };
  const compaction = findPlugin(tuned.plugins, COMPACTION_ROW_ID);
  if (compaction === undefined) throw new Error(`the shipped preset declares no ${COMPACTION_ROW_ID} plugin row`);
  compaction.config = { __jsExpr: EXPRESSION };
  return [
    { insert: [{ id: TUNED_PRESET_ROW_ID, name: PRESET_PLUGIN_NAME, config: tuned }] },
    { id: REGISTRY_ROW_ID, config: { default: TUNED_PRESET_ID, selectedDefault: TUNED_PRESET_ID } }
  ];
}

/** Run `fn` with exactly the four knobs set to `values`, restoring the process afterwards. */
export function withEnv(values, fn) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function resolveDshHome(explicit) {
  if (explicit !== undefined) return resolve(explicit);
  const fromEnv = process.env.DSH_HOME;
  return resolve(fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh'));
}

/** Routes this profile declares; `reservedCompletionTokens` is the session request header maxTokens. */
export const MODELS = [
  { label: 'opencode-go/deepseek-v4.1-flash', contextWindow: 1000000, reservedCompletionTokens: 384000 },
  { label: 'mimo-v2.6-* , muse-spark-1.3-*', contextWindow: 1048576, reservedCompletionTokens: 131072 }
];

/** Mirror of `@deepseek-ai/dsh-compaction-basic` `resolveCompactSpec`. */
export function compactSpec(model, thresholdRatio, retainRatio) {
  const messageBudgetTokens = model.contextWindow - model.reservedCompletionTokens;
  const pressureBudgetTokens = messageBudgetTokens - HEADROOM_TOKENS;
  if (pressureBudgetTokens <= 0) return { error: 'pressure budget <= 0 (TargetPressureConfigError)' };
  const ratioTerm = model.contextWindow * thresholdRatio;
  const thresholdTokens = Math.floor(Math.min(ratioTerm, pressureBudgetTokens));
  const retainTokens = Math.floor(messageBudgetTokens * retainRatio);
  if (retainTokens >= thresholdTokens) return { error: `retainTokens ${retainTokens} >= thresholdTokens ${thresholdTokens}` };
  return { thresholdTokens, retainTokens, binding: ratioTerm <= pressureBudgetTokens ? 'ratio' : 'headroom cap' };
}

export function formatSpecTable(cases) {
  const lines = [];
  for (const model of MODELS) {
    lines.push(`  ${model.label}  (contextWindow ${model.contextWindow}, reserved completion ${model.reservedCompletionTokens})`);
    for (const [label, thresholdRatio, retainRatio] of cases) {
      const spec = compactSpec(model, thresholdRatio, retainRatio);
      const detail = spec.error === undefined
        ? `trigger ${spec.thresholdTokens} tokens, retain ${spec.retainTokens} tokens (${spec.binding})`
        : spec.error;
      lines.push(`    ${label.padEnd(26)} ratio ${String(thresholdRatio).padEnd(7)} retain ${String(retainRatio).padEnd(8)} -> ${detail}`);
    }
  }
  return lines.join('\n');
}
