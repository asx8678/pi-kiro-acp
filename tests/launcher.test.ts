import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { FABRIC_PATCH_FILES, FABRIC_POLICY_VERSION, REVIEWED_FABRIC_VERSION } from '../src/policy/fabric.js';

const script = (name: string) => new URL(`../../scripts/${name}.mjs`, import.meta.url);
const temporary = (t: { after(fn: () => void): void }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-launcher-test-'));
    // Fixtures contain only generated JSON/scripts; no repository or user trees.
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const json = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
function ready(dir: string) {
    const root = path.join(dir, 'npm/node_modules/pi-fabric');
    const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    json(path.join(root, 'package.json'), { name: 'pi-fabric', version: REVIEWED_FABRIC_VERSION });
    json(path.join(dir, 'npm/package.json'), { dependencies: { 'pi-fabric': REVIEWED_FABRIC_VERSION } });
    json(path.join(dir, 'settings.json'), { packages: [`npm:pi-fabric@${REVIEWED_FABRIC_VERSION}`] });
    const policy = new URL('../src/policy/fabric.js', import.meta.url);
    const files = Object.fromEntries(FABRIC_PATCH_FILES.map(name => {
        const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '// inert');
        return [name, sha('// inert')];
    }));
    json(path.join(root, '.kiro-acp-policy.json'), { version: FABRIC_POLICY_VERSION, fabricVersion: REVIEWED_FABRIC_VERSION, policy: policy.href, policyHash: sha(fs.readFileSync(policy)), files });
}

test('launcher skips healthy/absent Fabric and maintenance commands; repairs and rechecks drift', async t => {
    const { preparePi } = await import(script('prepare-pi').href);
    const dir = temporary(t), messages: string[] = [];
    let calls = 0;
    const options = { dir, env: {}, report: (s: string) => messages.push(s), repair: () => { calls++; ready(dir); } };
    preparePi(options); assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(dir), []);
    ready(dir); preparePi(options); assert.equal(calls, 0); assert.deepEqual(messages, []);
    json(path.join(dir, 'npm/node_modules/pi-fabric/.kiro-acp-policy.json'), { version: 2 });
    preparePi(options); assert.equal(calls, 1);
    preparePi(options); assert.equal(calls, 1);
    json(path.join(dir, 'settings.json'), { packages: ['npm:pi-fabric'] });
    preparePi(options); assert.equal(calls, 2);
    json(path.join(dir, 'npm/node_modules/pi-fabric/package.json'), { name: 'pi-fabric', version: 'future' });
    preparePi({ ...options, args: ['update'] }); assert.equal(calls, 2);
    preparePi(options); assert.equal(calls, 3);
    json(path.join(dir, 'npm/node_modules/pi-fabric/.kiro-acp-policy.json'), {});
    assert.throws(() => preparePi({ ...options, repair: () => {} }), /routing guard/);
    assert.throws(() => preparePi({ ...options, env: { PI_FABRIC_DEPTH: '1' } }), /foreground Pi/);
    assert.equal(calls, 3);
});

test('offline startup refuses package installation and preserves settings; local patch repair stays possible', async t => {
    const { preparePi } = await import(script('prepare-pi').href);
    const dir = temporary(t); ready(dir);
    const settings = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
    json(path.join(dir, 'npm/node_modules/pi-fabric/package.json'), { name: 'pi-fabric', version: 'future' });
    for (const options of [{ args: ['--offline'], env: {} }, { args: [], env: { PI_OFFLINE: 'true' } }])
        assert.throws(() => preparePi({ dir, ...options, report: () => {} }), /before offline startup/);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), settings);
    assert.equal(fs.readdirSync(dir).some(name => name.startsWith('fabric-repair-backup-')), false);
    assert.equal(fs.existsSync(path.join(dir, '.kiro-acp-fabric-repair.lock')), false);
    ready(dir); json(path.join(dir, 'npm/node_modules/pi-fabric/.kiro-acp-policy.json'), {});
    preparePi({ dir, env: {}, args: ['--offline'], report: () => {}, repair: (options: { offline: boolean }) => {
        assert.equal(options.offline, true); ready(dir);
    } });
});

test('managed shell launcher preserves upstream binary, arguments, stdout, cwd and exit status', async t => {
    const { installLauncher } = await import(script('install-launcher').href);
    const home = temporary(t), realPi = path.join(home, "upstream pi's cli");
    fs.writeFileSync(realPi, `#!/bin/sh\nexec '${process.execPath}' -e 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}));process.exit(7)' -- "$@"\n`, { mode: 0o700 });
    const original = fs.readFileSync(realPi, 'utf8'), rc = path.join(home, '.zshrc');
    fs.writeFileSync(rc, '# existing config\n');
    const options = { home, shell: 'zsh', realPi, report: () => {} };
    const { launcher } = installLauncher(options);
    installLauncher(options);
    assert.equal(fs.readdirSync(home).filter(name => name.startsWith('.zshrc.kiro-acp-backup-')).length, 1);
    assert.equal(fs.readFileSync(realPi, 'utf8'), original);
    assert.ok(fs.readFileSync(rc, 'utf8').startsWith('# existing config\n'));
    const profile = path.join(home, 'profile'); fs.mkdirSync(profile);
    const args = ['--mode', 'json', 'a b', "'quote'", '$(false)', '`false`'];
    const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_KIRO_ACP_CONFIG: path.join(profile, 'kiro-acp.json') };
    const result = spawnSync(launcher, args, { cwd: home, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: home });
    assert.equal(result.stderr, '');
    // A failed repair must never enter the upstream executable.
    ready(profile); json(path.join(profile, 'npm/node_modules/pi-fabric/.kiro-acp-policy.json'), {});
    const failed = spawnSync(launcher, ['--offline'], { cwd: home, env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(failed.error); assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /Unrecognized pi-fabric code/);
    fs.writeFileSync(launcher, '# custom executable');
    assert.throws(() => installLauncher(options), /unmanaged launcher/);
});

test('repair lock waits for other processes, releases on failure and recovers a dead owner', { timeout: 15000 }, async t => {
    const { withFabricLock } = await import(script('fabric-lock').href);
    const dir = temporary(t), lock = path.join(dir, '.kiro-acp-fabric-repair.lock');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import {withFabricLock} from ${JSON.stringify(script('fabric-lock').href)};
        withFabricLock(${JSON.stringify(dir)}, () => { fs.writeSync(1, 'locked\\n'); fs.readFileSync(0); });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { child.stdin.end(); });
    await once(child, 'spawn');
    await once(child.stdout, 'data');
    assert.throws(() => withFabricLock(dir, () => assert.fail('overlapping repair'), 0), /Another Fabric repair/);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, child.pid);
    child.stdin.end(); const [code] = await once(child, 'exit'); assert.equal(code, 0);
    assert.equal(fs.existsSync(lock), false);
    json(lock, { pid: child.pid });
    assert.throws(() => withFabricLock(dir, () => { throw new Error('repair failed'); }), /repair failed/);
    assert.equal(fs.existsSync(lock), false);
    json(lock, {});
    assert.throws(() => withFabricLock(dir, () => assert.fail('incomplete lock'), 0), /lock is incomplete/);
});
