#!/usr/bin/env node
/**
 * Regenerate `cordis.patch.yml` from the installed DSH's shipped presets:
 * parse each upstream with DSH's own entry-list dialect, copy it verbatim,
 * swap in the tuned preset id and the `!!js` compaction knobs, then dump the
 * patch layer back.
 *
 * Usage: node scripts/sync.mjs [--install <dsh package dir>]
 *                                [--from-standard <standard.patch.yml>]
 *                                [--from-minimal <minimal.patch.yml>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const root = join(import.meta.dirname, '..');
const installDir = L.resolveInstallDir(option('install'));
const sources = L.resolvePresetSources(installDir, {
  standard: option('from-standard'),
  minimal: option('from-minimal')
});
const tools = L.loadDshTools(installDir);
const upstreamText = Object.fromEntries(
  Object.entries(sources).map(([name, file]) => [name, readFileSync(file, 'utf8')])
);
const upstream = Object.fromEntries(
  Object.entries(sources).map(([name, file]) => [name, L.readEntryList(tools, file)])
);
const patches = L.buildPatchList(upstream);
const version = L.dshVersion(installDir);
const digests = Object.fromEntries(
  Object.entries(upstreamText).map(([name, text]) => [name, L.sha256(text)])
);

const header = [
  '# dsh-compaction-tune - GENERATED FILE, do not hand-edit.',
  '#',
  '# Adds one @deepseek-ai/dsh-agent-preset row per source preset. Each row is a',
  '# verbatim copy of that shipped preset, with exactly one change: its',
  '# `' + L.COMPACTION_ROW_ID + '` row carries one `!!js` expression.',
  ...L.TUNED_PRESETS.map((spec) => (
    '#   - `' + spec.rowId + '` (preset id `' + spec.id + '`, shown as 「' + spec.name + '」)'
    + ' -- copy of the shipped `' + spec.source + '` preset'
  )),
  '#',
  '# That expression reads',
  '# ' + L.THRESHOLD_ENV + ' (or ' + L.THRESHOLD_ENV_ALIAS + ') and',
  '# ' + L.RETAIN_ENV + ' (or ' + L.RETAIN_ENV_ALIAS + ') at boot and returns the',
  '# compaction policy; the retained tail defaults to min(' + L.DEFAULT_RETAIN_RATIO + ', threshold / 2) so a',
  '# tiny threshold cannot trip compaction-basic\'s retainRatio < thresholdRatio check.',
  '#',
  '# The second patch selects the default preset as the profile default.',
  '#',
  '# source: @deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '#         @deepseek-ai/dsh-web-app/presets/minimal.patch.yml',
  '# dsh:    ' + version,
  '# sha256: ' + digests.standard + '  (standard)',
  '#         ' + digests.minimal + '  (minimal)',
  '#',
  '# Regenerate with `node scripts/sync.mjs`; detect upstream drift with',
  '# `node scripts/check.mjs`; prove the result with `node scripts/verify.mjs`.',
  ''
].join('\n');

writeFileSync(join(root, 'cordis.patch.yml'), header + L.dumpEntryList(tools, patches));

/**
 * Keep the previous timestamp when only the timestamp would change, so a
 * no-op regeneration leaves the worktree clean.
 * @param path - the upstream.json being rewritten.
 * @param next - the document without its timestamp.
 * @returns the previous timestamp, or undefined when the content moved.
 */
function unchangedStamp(path, next) {
  try {
    const { generatedAt, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof generatedAt !== 'string' || JSON.stringify(rest) !== JSON.stringify(next)) return undefined;
    return generatedAt;
  } catch {
    return undefined;
  }
}

const upstreamPath = join(root, 'upstream.json');
const stamp = {
  dshVersion: version,
  sources: Object.fromEntries(
    L.SOURCE_PRESET_NAMES.map((name) => [name, { path: sources[name], sha256: digests[name] }])
  )
};
writeFileSync(upstreamPath, JSON.stringify({
  ...stamp,
  generatedAt: unchangedStamp(upstreamPath, stamp) ?? new Date().toISOString()
}, null, 2) + '\n');

console.log(`wrote cordis.patch.yml from ${L.SOURCE_PRESET_NAMES.map((name) => sources[name]).join(' and ')}`);
for (const name of L.SOURCE_PRESET_NAMES) {
  console.log(`  ${name}: sha256 ${digests[name].slice(0, 16)}...`);
}
console.log(`  dsh ${version}`);
