#!/usr/bin/env node
// Produce an npm tarball from the already compiled, offline-tested package.
// The downloadable ZIP also includes source, tests and docs. No credentials/state.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!fs.existsSync(path.join(root, 'dist/src/index.js'))) {
  throw new Error('Run npm run build first.');
}
const tests = fs.readdirSync(path.join(root, 'dist/tests'))
  .filter(name => name.endsWith('.test.js'))
  .map(name => path.join('dist/tests', name));
const tested = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (tested.status !== 0) process.exit(tested.status ?? 1);
const out = path.join(root, 'release');
fs.mkdirSync(out, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = spawnSync(npm, ['pack', '--ignore-scripts', '--pack-destination', out], {
  cwd: root, stdio: 'inherit', shell: process.platform === 'win32'
});
if (packed.status !== 0) process.exit(packed.status ?? 1);
