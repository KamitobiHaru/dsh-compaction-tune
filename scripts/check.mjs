#!/usr/bin/env node
/**
 * Report whether the installed DSH still ships the presets this bundle was
 * generated from. Exits non-zero on drift so a DSH upgrade is noticed before
 * the frozen plugin lists quietly fall behind.
 *
 * Usage: node scripts/check.mjs [--install <dsh package dir>]
 *                                [--from-standard <standard.patch.yml>]
 *                                [--from-minimal <minimal.patch.yml>]
 */
import { readFileSync } from 'node:fs';
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
const stamp = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'));
const version = L.dshVersion(installDir);

console.log(`dsh:      ${version}   (generated against ${stamp.dshVersion})`);
let drifted = false;
for (const name of L.SOURCE_PRESET_NAMES) {
  const digest = L.sha256(readFileSync(sources[name], 'utf8'));
  const stamped = stamp.sources?.[name]?.sha256;
  const same = digest === stamped;
  if (!same) drifted = true;
  console.log(`${name}: ${sources[name]}`);
  console.log(`  sha256:   ${digest}`);
  console.log(`  stamped:  ${stamped ?? '(none)'}${same ? '' : '   CHANGED'}`);
}
if (!drifted && version === stamp.dshVersion) {
  console.log('\nup to date: the frozen presets still match the shipped ones.');
  process.exit(0);
}
console.error('\nDRIFT: the shipped presets are no longer the ones this bundle froze.');
if (version !== stamp.dshVersion) console.error(`  dsh ${stamp.dshVersion} -> ${version}`);
for (const name of L.SOURCE_PRESET_NAMES) {
  const digest = L.sha256(readFileSync(sources[name], 'utf8'));
  if (digest !== stamp.sources?.[name]?.sha256) {
    console.error(`  the content of presets/${name}.patch.yml changed`);
  }
}
console.error('\nnext: node scripts/sync.mjs && git diff && node scripts/verify.mjs');
process.exit(1);
