#!/usr/bin/env node
/**
 * Report whether the installed DSH still ships the preset this bundle was
 * generated from. Exits non-zero on drift so a DSH upgrade is noticed before
 * the frozen plugin list quietly falls behind.
 *
 * Usage: node scripts/check.mjs [--install <dsh package dir>] [--from <standard.patch.yml>]
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
const source = L.resolvePresetSource(installDir, option('from'));
const stamp = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'));
const digest = L.sha256(readFileSync(source, 'utf8'));
const version = L.dshVersion(installDir);

console.log(`dsh:      ${version}   (generated against ${stamp.dshVersion})`);
console.log(`upstream: ${source}`);
console.log(`sha256:   ${digest}`);
console.log(`stamped:  ${stamp.upstreamSha256}`);

if (digest === stamp.upstreamSha256 && version === stamp.dshVersion) {
  console.log('\nup to date: the frozen preset still matches the shipped standard preset.');
  process.exit(0);
}
console.error('\nDRIFT: the shipped standard preset is no longer the one this bundle froze.');
if (version !== stamp.dshVersion) console.error(`  dsh ${stamp.dshVersion} -> ${version}`);
if (digest !== stamp.upstreamSha256) console.error('  the content of presets/standard.patch.yml changed');
console.error('\nnext: node scripts/sync.mjs && git diff && node scripts/verify.mjs');
process.exit(1);
