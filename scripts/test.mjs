#!/usr/bin/env node
// Hermetic offline tests: never read a developer's live Pi configuration or
// require their installed Fabric package to have a particular policy patch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kiro-suite-'));
try {
    const tests = fs.readdirSync(path.join(root, 'dist/tests')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(root, 'dist/tests', name));
    const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...tests], {
        cwd: root, stdio: 'inherit', env: {
            ...process.env, PI_CODING_AGENT_DIR: profile,
            PI_KIRO_ACP_CONFIG: path.join(profile, 'kiro-acp.json'), PI_OFFLINE: '1',
            PI_KIRO_CREDIT_TASK_ID: '', PI_KIRO_CREDIT_OWNER_PID: '',
        },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally { fs.rmSync(profile, { recursive: true, force: true }); }
