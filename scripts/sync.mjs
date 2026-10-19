#!/usr/bin/env node
/**
 * Regenerate `cordis.patch.yml` from the installed DSH's shipped `standard`
 * preset: parse upstream with DSH's own entry-list dialect, swap in the tuned
 * preset id and the `!!js` compaction knobs, then dump the patch layer back.
 *
 * Usage: node scripts/sync.mjs [--install <dsh package dir>] [--from <standard.patch.yml>]
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
const source = L.resolvePresetSource(installDir, option('from'));
const tools = L.loadDshTools(installDir);
const upstreamText = readFileSync(source, 'utf8');
const upstream = L.readEntryList(tools, source);
const patches = L.buildPatchList(upstream);
const version = L.dshVersion(installDir);
const digest = L.sha256(upstreamText);

const header = [
  '# dsh-compaction-tune - GENERATED FILE, do not hand-edit.',
  '#',
  '# Adds one @deepseek-ai/dsh-agent-preset row (`' + L.TUNED_PRESET_ROW_ID + '`, preset id',
  '# `' + L.TUNED_PRESET_ID + '`): a verbatim copy of the shipped `standard` preset whose',
  '# `' + L.COMPACTION_ROW_ID + '` row carries one `!!js` expression. That expression reads',
  '# ' + L.THRESHOLD_ENV + ' (or ' + L.THRESHOLD_ENV_ALIAS + ') and',
  '# ' + L.RETAIN_ENV + ' (or ' + L.RETAIN_ENV_ALIAS + ') at boot and returns the',
  '# compaction policy; the retained tail defaults to min(' + L.DEFAULT_RETAIN_RATIO + ', threshold / 2) so a',
  '# tiny threshold cannot trip compaction-basic\'s retainRatio < thresholdRatio check.',
  '#',
  '# The second patch selects that preset as the profile default.',
  '#',
  '# source: @deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '# dsh:    ' + version,
  '# sha256: ' + digest,
  '#',
  '# Regenerate with `node scripts/sync.mjs`; detect upstream drift with',
  '# `node scripts/check.mjs`; prove the result with `node scripts/verify.mjs`.',
  ''
].join('\n');

writeFileSync(join(root, 'cordis.patch.yml'), header + L.dumpEntryList(tools, patches));
writeFileSync(join(root, 'upstream.json'), JSON.stringify({
  dshVersion: version,
  upstreamPath: source,
  upstreamSha256: digest,
  generatedAt: new Date().toISOString()
}, null, 2) + '\n');

console.log(`wrote cordis.patch.yml from ${source}`);
console.log(`  dsh ${version}, upstream sha256 ${digest.slice(0, 16)}...`);
