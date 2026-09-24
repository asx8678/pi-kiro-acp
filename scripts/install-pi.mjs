#!/usr/bin/env node
// Pi's local-path installer only registers the package; it runs no lifecycle hook.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/src/config.js';
import { ensureInstallationId } from '../dist/src/installation.js';

if (process.argv.length > 2) throw new Error('Usage: bun run install:pi. Select a profile with PI_CODING_AGENT_DIR and PI_KIRO_ACP_CONFIG.');
const config = loadConfig();
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.env.PI_BIN || 'pi', ['install', root], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
ensureInstallationId(config);
console.log('Pi extension installed. Its private installation ID is ready and will be reused after updates.');
