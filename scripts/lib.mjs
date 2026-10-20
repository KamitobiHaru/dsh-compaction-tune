/**
 * Shared helpers for the dsh-compaction-tune bundle scripts.
 *
 * Every script loads DSH's own entry-list YAML dialect (`entryListSchema`) and
 * the installation's own `js-yaml`, so a generated patch round-trips exactly
 * the way the Cordis Loader reads it -- `!!js` markers included.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const PRESET_PLUGIN_NAME = '@deepseek-ai/dsh-agent-preset';
export const REGISTRY_ROW_ID = 'agent-preset-registry';
export const COMPACTION_ROW_ID = 'compaction-basic';

/**
 * The shipped presets this bundle derives from, by preset name.
 *
 * `standard` carries the full tool catalog; `minimal` carries the two-tool
 * surface (a persistent shell and `read_image`) and a one-line system prompt.
 */
export const SOURCE_PRESET_NAMES = ['standard', 'minimal'];

/**
 * The tuned presets this bundle ships.
 *
 * Each one is a verbatim copy of a shipped preset whose `compaction-basic`
 * row carries the `!!js` policy expression; every other row -- the persona,
 * the tool rows, the compaction group's other members and its `isolate` map --
 * is the shipped declaration's own text, so the copy differs from its source
 * in exactly one place.
 */
export const TUNED_PRESETS = [
  {
    /** Preset id (inside the declaration); sessions record this id. */
    id: 'high-performance',
    /** Loader row id of the declaration row. */
    rowId: 'preset-high-performance',
    /** Name of the shipped preset this one copies. */
    source: 'standard',
    /** Loader row id of the shipped declaration. */
    sourceRowId: 'preset-standard',
    /** Shown by the preset picker (`config.name ?? config.id`). */
    name: '高性能',
    description: '采用更激进的压缩策略，使得准确性更高。',
    /** Roster position. */
    order: 1
  },
  {
    id: 'high-performance-minimal',
    rowId: 'preset-high-performance-minimal',
    source: 'minimal',
    sourceRowId: 'preset-minimal',
    name: '高性能精简',
    description: '官方 minimal 预设，加上可定制的压缩策略。',
    order: 3
  }
];

/** The tuned preset the profile default points at. */
export const DEFAULT_TUNED_PRESET_ID = TUNED_PRESETS[0].id;

export const THRESHOLD_ENV = 'HARNESS_COMPACTION_THRESHOLD_RATIO';
export const RETAIN_ENV = 'HARNESS_COMPACTION_RETAIN_RATIO';
export const THRESHOLD_ENV_ALIAS = 'DSH_COMPACTION_THRESHOLD_RATIO';
export const RETAIN_ENV_ALIAS = 'DSH_COMPACTION_RETAIN_RATIO';
export const ENV_KEYS = [THRESHOLD_ENV, RETAIN_ENV, THRESHOLD_ENV_ALIAS, RETAIN_ENV_ALIAS];
export const DEFAULT_THRESHOLD_RATIO = 0.4;
/**
 * Retained verbatim tail as a fraction of the message budget
 * (`contextWindow - maxTokens`). 0.05 keeps ~31K tokens on a 1M/384K route and
 * ~46K on a 1M/131K route: ~8% of the 0.4 trigger, in the 30-50K band other
 * agents effectively keep. The derived fallback `min(0.05, threshold/2)` still
 * shrinks it for deliberately tiny test thresholds.
 */
export const DEFAULT_RETAIN_RATIO = 0.05;
export const HEADROOM_TOKENS = 65536;

/**
 * The single `!!js` expression this bundle injects into the preset's
 * `compaction-basic` row, generated from the two defaults above so the file
 * cannot drift from them. Re-run `sync.mjs` after editing; `verify.mjs`
 * checks the generated text against this constant.
 */
export const EXPRESSION = `(() => {
  const env = process.env;
  const thresholdRatio = Number(env.HARNESS_COMPACTION_THRESHOLD_RATIO ?? env.DSH_COMPACTION_THRESHOLD_RATIO ?? ${DEFAULT_THRESHOLD_RATIO});
  const retainRatio = Number(env.HARNESS_COMPACTION_RETAIN_RATIO ?? env.DSH_COMPACTION_RETAIN_RATIO ?? Math.min(${DEFAULT_RETAIN_RATIO}, thresholdRatio / 2));
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

/**
 * The shipped preset patch files this bundle is generated from, keyed by
 * preset name. An explicit path overrides the shipped one for that preset.
 * @param installDir - the dsh installation to read the shipped presets from.
 * @param explicit - optional per-preset path overrides.
 * @returns the patch file path of every source preset.
 */
export function resolvePresetSources(installDir, explicit = {}) {
  const require = createRequire(join(installDir, 'package.json'));
  const dir = join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets');
  const sources = {};
  for (const name of SOURCE_PRESET_NAMES) {
    const override = explicit[name];
    sources[name] = override !== undefined ? resolve(override) : join(dir, `${name}.patch.yml`);
  }
  return sources;
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
 * The complete patch list this bundle ships: one tuned preset declaration per
 * source preset, plus the registry override that selects the default one.
 * `sync.mjs` writes exactly this and `verify.mjs` asserts the written file
 * still equals it.
 *
 * Each tuned declaration is its source's plugin list verbatim, with the
 * `compaction-basic` row's config replaced by the policy expression. Nothing
 * else is added, removed, or rewritten -- in particular the `compact` preset
 * keeps the shipped `minimal` compaction group as it is, so it mounts no
 * `tool-result-pruner` and no `toolResultPruner` isolation realm.
 * @param sources - the parsed entry list of every source preset, by name.
 * @returns the patch list this bundle ships.
 */
export function buildPatchList(sources) {
  const rows = TUNED_PRESETS.map((spec) => {
    const source = sources[spec.source];
    if (source === undefined) throw new Error(`no source preset named ${JSON.stringify(spec.source)}`);
    const upstream = findInsertedRow(source, spec.sourceRowId);
    if (upstream.config?.id !== spec.source) {
      throw new Error(`${spec.sourceRowId} no longer declares preset id ${JSON.stringify(spec.source)}`);
    }
    const tuned = {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      order: spec.order,
      plugins: structuredClone(upstream.config.plugins)
    };
    const compaction = findPlugin(tuned.plugins, COMPACTION_ROW_ID);
    if (compaction === undefined) throw new Error(`the shipped ${spec.source} preset declares no ${COMPACTION_ROW_ID} plugin row`);
    compaction.config = { __jsExpr: EXPRESSION };
    return { id: spec.rowId, name: PRESET_PLUGIN_NAME, config: tuned };
  });
  return [
    { insert: rows },
    { id: REGISTRY_ROW_ID, config: { default: DEFAULT_TUNED_PRESET_ID, selectedDefault: DEFAULT_TUNED_PRESET_ID } }
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

/**
 * Sample routes, used only when no profile patch can be read. The printed
 * table is diagnostics: compaction-basic resolves the real numbers at runtime
 * per routed model, so these values never configure anything.
 */
export const FALLBACK_MODELS = [
  { label: 'opencode-go/deepseek-v4.1-flash', contextWindow: 1000000, reservedCompletionTokens: 384000 },
  { label: 'opencode-go/mimo-v2.6-flash', contextWindow: 1048576, reservedCompletionTokens: 131072 }
];

/**
 * Every model declared by one profile's own patch layer
 * (`$DSH_HOME/profiles/<name>/cordis.patch.yml`), across all providers, so the
 * printed table and the coverage warnings describe what is actually routed
 * rather than a hardcoded sample.
 * @param options - profile name, harness home, and dsh installation for the YAML dialect.
 * @returns the declared routes, the declarations missing `contextWindow`, and where they came from.
 */
export function collectProfileModels(options = {}) {
  const file = join(resolveDshHome(options.home), 'profiles', options.profile ?? 'web', 'cordis.patch.yml');
  if (!existsSync(file)) return { file, models: [], missing: [], note: `no profile patch at ${file}` };
  let entries;
  try {
    const tools = loadDshTools(options.installDir ?? resolveInstallDir());
    entries = readEntryList(tools, file);
  } catch (error) {
    return { file, models: [], missing: [], note: `cannot read the profile patch: ${error.message}` };
  }
  const models = [];
  const missing = [];
  const visit = (rows) => {
    for (const row of rows ?? []) {
      const providers = row?.config?.providers;
      if (providers !== null && typeof providers === 'object') {
        for (const [provider, providerConfig] of Object.entries(providers)) {
          for (const model of providerConfig?.models ?? []) {
            const label = `${provider}/${model?.id ?? '?'}`;
            if (typeof model?.contextWindow !== 'number') {
              missing.push({ label, reason: 'declares no contextWindow, so compaction throws TargetPressureConfigError on this route' });
              continue;
            }
            models.push({
              label,
              contextWindow: model.contextWindow,
              reservedCompletionTokens: typeof model.maxTokens === 'number' ? model.maxTokens : undefined
            });
          }
        }
      }
      if (Array.isArray(row?.config)) visit(row.config);
      if (Array.isArray(row?.insert)) visit(row.insert);
    }
  };
  visit(entries);
  return { file, models, missing };
}

/**
 * Mirror of `@deepseek-ai/dsh-compaction-basic` `resolveCompactSpec`.
 * `reservedCompletionTokens` is the session request header maxTokens, so a
 * model that declares none can only be bounded by the ratio term.
 */
export function compactSpec(model, thresholdRatio, retainRatio) {
  const ratioTerm = model.contextWindow * thresholdRatio;
  if (model.reservedCompletionTokens === undefined) {
    return { thresholdTokens: Math.floor(ratioTerm), binding: 'ratio term only; maxTokens not declared, so the headroom cap is unknown' };
  }
  const messageBudgetTokens = model.contextWindow - model.reservedCompletionTokens;
  const pressureBudgetTokens = messageBudgetTokens - HEADROOM_TOKENS;
  if (pressureBudgetTokens <= 0) {
    return { error: `pressure budget <= 0 (${model.contextWindow} - ${model.reservedCompletionTokens} - ${HEADROOM_TOKENS}); TargetPressureConfigError at runtime` };
  }
  const thresholdTokens = Math.floor(Math.min(ratioTerm, pressureBudgetTokens));
  const retainTokens = Math.floor(messageBudgetTokens * retainRatio);
  if (retainTokens >= thresholdTokens) {
    return { error: `retainTokens ${retainTokens} >= thresholdTokens ${thresholdTokens}; compaction-basic refuses this policy at activation` };
  }
  return { thresholdTokens, retainTokens, binding: ratioTerm <= pressureBudgetTokens ? 'ratio' : 'headroom cap' };
}

export function formatSpecTable(cases, models = FALLBACK_MODELS) {
  if (models.length === 0) return '  (no models)';
  const lines = [];
  for (const model of models) {
    const declared = model.reservedCompletionTokens === undefined
      ? 'maxTokens not declared'
      : `maxTokens ${model.reservedCompletionTokens}`;
    lines.push(`  ${model.label}  (contextWindow ${model.contextWindow}, ${declared})`);
    for (const [label, thresholdRatio, retainRatio] of cases) {
      const spec = compactSpec(model, thresholdRatio, retainRatio);
      const detail = spec.error !== undefined
        ? spec.error
        : spec.retainTokens === undefined
          ? `trigger <= ${spec.thresholdTokens} tokens (${spec.binding})`
          : `trigger ${spec.thresholdTokens} tokens, retain ${spec.retainTokens} tokens (${spec.binding})`;
      lines.push(`    ${label.padEnd(26)} ratio ${String(thresholdRatio).padEnd(7)} retain ${String(retainRatio).padEnd(8)} -> ${detail}`);
    }
  }
  return lines.join('\n');
}
