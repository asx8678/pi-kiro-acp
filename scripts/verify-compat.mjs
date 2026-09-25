#!/usr/bin/env node
// Real installed packages, disposable copies/profiles, no model requests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const keep = process.argv.includes('--keep');
const installed = process.argv.slice(2).find(arg => arg !== '--keep') || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'npm/node_modules');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-compat-'));
const profile = path.join(temp, 'profile'), modules = path.join(profile, 'npm/node_modules');
const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_KIRO_ACP_CONFIG: path.join(profile, 'kiro-acp.json'), PI_OFFLINE: '1', PI_KIRO_CREDIT_TASK_ID: '', PI_KIRO_CREDIT_OWNER_PID: '' };
const run = (file, args = []) => {
    const result = spawnSync(process.execPath, [path.join(root, file), ...args], { cwd: temp, env, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, `${file}: ${result.error ?? result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
};
try {
    const pi = fs.realpathSync(execFileSync(process.platform === 'win32' ? 'where' : 'which', [process.env.PI_BIN || 'pi'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]);
    const require = createRequire(pi);
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
        let sdk = path.dirname(pi);
        while (!fs.existsSync(path.join(sdk, 'package.json'))) {
            const parent = path.dirname(sdk);
            if (parent === sdk) throw new Error('Cannot locate Pi package');
            sdk = parent;
        }
        const directory = name === '@earendil-works/pi-coding-agent' ? sdk
            : require.resolve.paths(name).map(base => path.join(base, name)).find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
        if (!directory) throw new Error(`Cannot locate ${name}`);
        const link = path.join(modules, name); fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(directory, link, 'dir');
    }
    for (const [name, directory] of [['pi-fabric', 'dist'], ['pi-fovea', 'src']]) {
        const source = path.resolve(installed, name), target = path.join(modules, name);
        fs.mkdirSync(target, { recursive: true });
        // Include declared skill/resource trees too: child Pi instances load them
        // even when the foreground compatibility probe uses --no-skills.
        fs.cpSync(source, target, { recursive: true,
            filter: file => !['node_modules', '.git'].includes(path.basename(file)),
        });
        // Test from reviewed originals even if the source installation is patched.
        const restore = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) restore(file);
            else if (entry.name.endsWith('.kiro-acp-original')) { fs.copyFileSync(file, file.slice(0, -'.kiro-acp-original'.length)); fs.unlinkSync(file); }
        } };
        restore(path.join(target, directory));
        fs.symlinkSync(fs.existsSync(path.join(source, 'node_modules')) ? path.join(source, 'node_modules') : path.dirname(source), path.join(target, 'node_modules'), 'dir');
    }
    const fabric = path.join(modules, 'pi-fabric'), fovea = path.join(modules, 'pi-fovea');
    console.log(run('fixtures/compat-fovea.mjs', [fovea, 'before']));
    for (const [script, target] of [['scripts/patch-fabric.mjs', fabric], ['scripts/patch-fovea.mjs', fovea]]) {
        run(script, [target]); run(script, [target]); run(script, [target, '--check']);
    }
    console.log(run('fixtures/compat-fabric.mjs', [fabric]));
    console.log(run('fixtures/compat-fovea.mjs', [fovea, 'after']));
    console.log(run('fixtures/compat-host.mjs', [profile]));
    console.log(JSON.stringify({ result: 'passed', productionPackagesChanged: false, paidPrompts: 0 }));
} finally {
    if (keep) console.log(JSON.stringify({ retainedProfile: profile }));
    else fs.rmSync(temp, { recursive: true, force: true });
}
