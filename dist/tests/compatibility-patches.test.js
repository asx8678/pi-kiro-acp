import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { applyFabricProfile, assertFabricProvider, guardFabricWorker, rejectFabricJev, fabricGuardStatus, FABRIC_PATCH_FILES, FABRIC_POLICY_VERSION, REVIEWED_FABRIC_VERSION } from '../src/policy/fabric.js';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const temporary = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-compat-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
};
test('Fabric policy blocks foreign inference and unsafe worker routes before dispatch', () => {
    assert.doesNotThrow(() => assertFabricProvider('kiro-acp'));
    for (const provider of [undefined, '', 'openai', 'anthropic'])
        assert.throws(() => assertFabricProvider(provider), /Kiro-only/);
    assert.throws(rejectFabricJev, /Jev/);
    for (const request of [{ runner: 'claude' }, { runner: 'veda' }, { model: 'openai/a' }, { model: 'kiro-acp/' }, { extensions: false }, { residency: 'durable' }, { transport: 'tmux' }])
        assert.throws(() => guardFabricWorker(request), /Kiro-only|Efficiency/);
    assert.throws(() => guardFabricWorker({}, { model: 'openai/a' }), /Kiro-only/);
    const request = { model: 'kiro-acp/auto', timeoutMs: 9999999 };
    assert.deepEqual(guardFabricWorker(request), { model: 'kiro-acp/auto', extensions: true, transport: 'process', timeoutMs: 900000 });
    assert.equal(request.timeoutMs, 9999999);
});
test('Fabric merged profile cannot reenable Jev, foreign workers, prewalk or larger bounds', () => {
    const raw = { jev: { enabled: true }, mcp: { jev: { semanticSearch: true } }, agents: { runner: 'claude', extensions: false, model: 'openai/a', maxConcurrent: 9, maxDepth: 9 }, prewalk: { enabled: true }, executor: { maxOutputChars: 99 } };
    const fixed = applyFabricProfile(raw);
    assert.equal(fixed.agents.runner, 'pi');
    assert.equal(fixed.agents.model, 'kiro-acp/auto');
    assert.equal(fixed.agents.maxConcurrent, 2);
    assert.equal(fixed.agents.maxDepth, 1);
    assert.equal(fixed.jev.enabled, false);
    assert.equal(fixed.mcp.jev.semanticSearch, false);
    assert.equal(fixed.prewalk.enabled, false);
    assert.equal(fixed.executor.maxOutputChars, 99);
    assert.equal(raw.jev.enabled, true);
});
test('Fabric profile preserves maxDepth zero without treating other zero limits as disabled', () => {
    const agents = applyFabricProfile({ agents: { maxDepth: 0, maxConcurrent: 0, timeoutMs: 0 } }).agents;
    assert.equal(agents.maxDepth, 0);
    assert.equal(agents.maxConcurrent, 2);
    assert.equal(agents.timeoutMs, 900000);
    for (const maxDepth of [undefined, -1, NaN])
        assert.equal(applyFabricProfile({ agents: { maxDepth } }).agents.maxDepth, 1);
});
test('checked patch upgrades only exact reviewed prior patches and keeps original backups', async (t) => {
    const { checkedPatch } = await import(new URL('../../scripts/checked-patch.mjs', import.meta.url).href);
    const root = temporary(t), file = path.join(root, 'code.js');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1' }));
    fs.writeFileSync(file, 'source');
    const base = { root, packageName: 'fixture', packageVersion: '1', manifestName: 'manifest.json' };
    const prior = { header: '// v2\n', edits: [['source', 'old patch']] };
    checkedPatch({ ...base, specs: [{ name: 'code.js', sha256: sha('source'), ...prior }] });
    const old = fs.readFileSync(file, 'utf8');
    const next = { ...base, specs: [{ name: 'code.js', sha256: sha('source'), header: '// v3\n', edits: [['source', 'new patch']], previous: [prior] }] };
    assert.throws(() => checkedPatch({ ...next, check: true }), /missing or changed/);
    fs.appendFileSync(file, '\n// unrecognized change');
    assert.throws(() => checkedPatch(next), /Modified/);
    fs.writeFileSync(file, old);
    checkedPatch(next);
    checkedPatch({ ...next, check: true });
    checkedPatch(next);
    assert.equal(fs.readFileSync(file, 'utf8'), '// v3\nnew patch');
    assert.equal(fs.readFileSync(file + '.kiro-acp-original', 'utf8'), 'source');
});
test('Fabric readiness binds exact reviewed files, package identity and policy artifact', t => {
    const profile = temporary(t), prior = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = profile;
    t.after(() => { if (prior === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
    else
        process.env.PI_CODING_AGENT_DIR = prior; });
    assert.deepEqual(fabricGuardStatus(), { installed: false, ready: true });
    const root = path.join(profile, 'npm/node_modules/pi-fabric');
    fs.mkdirSync(path.join(root, 'dist/chunks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-fabric', version: REVIEWED_FABRIC_VERSION }));
    const policy = new URL('../src/policy/fabric.js', import.meta.url);
    const manifest = { version: FABRIC_POLICY_VERSION, fabricVersion: REVIEWED_FABRIC_VERSION, policy: policy.href, policyHash: sha(fs.readFileSync(policy)), files: Object.fromEntries(FABRIC_PATCH_FILES.map(name => { fs.writeFileSync(path.join(root, name), '// inert fixture'); return [name, sha('// inert fixture')]; })) };
    const save = (value) => fs.writeFileSync(path.join(root, '.kiro-acp-policy.json'), JSON.stringify(value));
    assert.equal(fabricGuardStatus().ready, false);
    save(manifest);
    assert.equal(fabricGuardStatus().ready, true);
    for (const broken of [{ ...manifest, policy: 'file:///elsewhere.js' }, { ...manifest, policyHash: 'changed' }, { ...manifest, version: 1 }, { ...manifest, fabricVersion: '0.94.0' }, { ...manifest, files: { ...manifest.files, 'dist/extra.js': 'x' } }]) {
        save(broken);
        assert.equal(fabricGuardStatus().ready, false);
    }
    const sameCount = structuredClone(manifest);
    delete sameCount.files[FABRIC_PATCH_FILES[0]];
    sameCount.files['dist/wrong.js'] = sha('');
    save(sameCount);
    assert.equal(fabricGuardStatus().ready, false);
    save(manifest);
    fs.appendFileSync(path.join(root, FABRIC_PATCH_FILES[0]), '\n// edited');
    assert.equal(fabricGuardStatus().ready, false);
    assert.match(fabricGuardStatus().reason, /routing guard is missing or changed.*repair:fabric/);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-fabric', version: '0.94.0' }));
    const mismatch = fabricGuardStatus();
    assert.equal(mismatch.ready, false);
    assert.equal(mismatch.fabricVersion, '0.94.0');
    assert.ok(mismatch.reason?.includes(`requires reviewed Fabric ${REVIEWED_FABRIC_VERSION}`));
});
test('checked patch validates the complete plan, preserves shebang/backups, and checks without writes', async (t) => {
    const moduleUrl = new URL('../../scripts/checked-patch.mjs', import.meta.url).href;
    const { checkedPatch } = await import(moduleUrl);
    const root = temporary(t), source = '#!/usr/bin/env node\noriginal\n';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1' }));
    fs.writeFileSync(path.join(root, 'a.js'), source);
    fs.writeFileSync(path.join(root, 'b.js'), 'original');
    const options = { root, packageName: 'fixture', packageVersion: '1', manifestName: 'manifest.json', specs: [
            { name: 'a.js', sha256: sha(source), header: '// header\n', edits: [['original', 'patched']] },
            { name: 'b.js', sha256: sha('original'), edits: [['original', 'patched']] },
        ] };
    assert.throws(() => checkedPatch({ ...options, check: true }), /missing or changed/);
    assert.equal(fs.existsSync(path.join(root, 'manifest.json')), false);
    assert.throws(() => checkedPatch({ ...options, packageVersion: '2' }), /fresh review/);
    fs.writeFileSync(path.join(root, 'b.js'), 'tampered');
    assert.throws(() => checkedPatch(options), /Unrecognized/);
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), source);
    assert.equal(fs.existsSync(path.join(root, 'a.js.kiro-acp-original')), false);
    fs.writeFileSync(path.join(root, 'b.js'), 'original');
    checkedPatch(options);
    const first = fs.readFileSync(path.join(root, 'a.js'), 'utf8');
    assert.equal(first, '#!/usr/bin/env node\n// header\npatched\n');
    assert.equal(fs.readFileSync(path.join(root, 'a.js.kiro-acp-original'), 'utf8'), source);
    checkedPatch(options);
    checkedPatch({ ...options, check: true });
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), first);
    fs.appendFileSync(path.join(root, 'a.js'), '// local edit');
    assert.throws(() => checkedPatch(options), /Modified/);
});
test('efficiency configuration pins reviewed Fabric without changing package filters', t => {
    const profile = temporary(t), settingsFile = path.join(profile, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ packages: ['npm:pi-fabric@0.94.0', { source: 'npm:pi-fabric', skills: [] }, 'npm:unrelated'] }));
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/configure-efficiency.mjs', import.meta.url))], {
        encoding: 'utf8', timeout: 10000, env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_KIRO_ACP_CONFIG: path.join(profile, 'kiro-acp.json'), PI_OFFLINE: '1' },
    });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const settings = fs.readFileSync(settingsFile, 'utf8');
    assert.deepEqual(JSON.parse(settings).packages, [`npm:pi-fabric@${REVIEWED_FABRIC_VERSION}`, { source: `npm:pi-fabric@${REVIEWED_FABRIC_VERSION}`, skills: [] }, 'npm:unrelated']);
    assert.equal(run().status, 0);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), settings);
    const fovea = path.join(profile, 'npm/node_modules/pi-fovea');
    fs.mkdirSync(fovea, { recursive: true });
    fs.writeFileSync(path.join(fovea, 'package.json'), JSON.stringify({ name: 'pi-fovea', version: 'unknown' }));
    assert.notEqual(run().status, 0);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), settings);
});
test('Fabric repair synchronizes old pins, preserves settings and becomes install-idempotent', async (t) => {
    const { repairFabric } = await import(new URL('../../scripts/repair-fabric.mjs', import.meta.url).href);
    const dir = temporary(t), npmDir = path.join(dir, 'npm'), root = path.join(npmDir, 'node_modules/pi-fabric');
    fs.mkdirSync(root, { recursive: true });
    const settingsFile = path.join(dir, 'settings.json'), packageFile = path.join(npmDir, 'package.json');
    const settings = { npmCommand: ['bun'], theme: 'custom', defaultModel: 'chosen', packages: [
            'npm:pi-fabric@0.94.0', { source: 'npm:pi-fabric', extensions: ['dist/index.js'], skills: [] }, 'npm:unrelated',
        ] };
    const pkg = { private: true, dependencies: { 'pi-fabric': '^0.94.0', 'pi-fovea': '0.31.1' } };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-fabric', version: '0.94.0' }));
    fs.writeFileSync(path.join(npmDir, 'bun.lock'), 'original lock');
    let installs = 0, patches = 0, checks = 0;
    const run = (command, args, options) => {
        if (command === 'bun') {
            installs++;
            assert.deepEqual(args, ['add', '--exact', '--ignore-scripts', `pi-fabric@${REVIEWED_FABRIC_VERSION}`]);
            assert.equal(options?.cwd, npmDir);
            fs.writeFileSync(packageFile, JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, 'pi-fabric': REVIEWED_FABRIC_VERSION } }));
            fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-fabric', version: REVIEWED_FABRIC_VERSION }));
        }
        else {
            assert.equal(command, process.execPath);
            assert.equal(args[1], root);
            assert.ok(args[0]?.endsWith('/patch-fabric.mjs'));
            if (args.includes('--check'))
                checks++;
            else
                patches++;
        }
    };
    const options = { dir, run, report: () => { } };
    repairFabric(options);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { ...settings, packages: [
            `npm:pi-fabric@${REVIEWED_FABRIC_VERSION}`, { ...settings.packages[1], source: `npm:pi-fabric@${REVIEWED_FABRIC_VERSION}` }, 'npm:unrelated',
        ] });
    const backups = () => fs.readdirSync(dir).filter(name => name.startsWith('fabric-repair-backup-'));
    assert.equal(backups().length, 1);
    const backup = path.join(dir, backups()[0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, 'settings.json'), 'utf8')), settings);
    assert.equal(fs.readFileSync(path.join(backup, 'bun.lock'), 'utf8'), 'original lock');
    if (process.platform !== 'win32')
        assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
    repairFabric(options);
    assert.equal(installs, 1);
    assert.equal(patches, 2);
    assert.equal(checks, 2);
    assert.equal(backups().length, 1);
});
test('Fabric repair refuses failed patches and concurrent settings edits before publishing its pin', async (t) => {
    const { repairFabric } = await import(new URL('../../scripts/repair-fabric.mjs', import.meta.url).href);
    const dir = temporary(t), root = path.join(dir, 'npm/node_modules/pi-fabric');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-fabric', version: REVIEWED_FABRIC_VERSION }));
    fs.writeFileSync(path.join(dir, 'npm/package.json'), JSON.stringify({ dependencies: { 'pi-fabric': REVIEWED_FABRIC_VERSION } }));
    const settingsFile = path.join(dir, 'settings.json'), original = JSON.stringify({ packages: ['npm:pi-fabric@0.94.0'] });
    fs.writeFileSync(settingsFile, original);
    assert.throws(() => repairFabric({ dir, report: () => { }, run: () => { throw new Error('Unrecognized code'); } }), /Unrecognized/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
    const concurrent = JSON.stringify({ packages: ['npm:pi-fabric@0.94.0'], theme: 'changed' });
    assert.throws(() => repairFabric({ dir, report: () => { }, run: () => { fs.writeFileSync(settingsFile, concurrent); } }), /settings changed/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), concurrent);
});
test('Fabric repair skips absent Fabric and does not publish a pin after a failed install', async (t) => {
    const { repairFabric } = await import(new URL('../../scripts/repair-fabric.mjs', import.meta.url).href);
    const dir = temporary(t), settingsFile = path.join(dir, 'settings.json');
    repairFabric({ dir, report: () => { }, run: () => assert.fail('Fabric is optional') });
    assert.deepEqual(fs.readdirSync(dir), []);
    const original = JSON.stringify({ packages: ['npm:pi-fabric@0.94.0'] });
    fs.writeFileSync(settingsFile, original);
    assert.throws(() => repairFabric({ dir, report: () => { }, run: (command, args) => {
            assert.equal(command, 'npm');
            assert.deepEqual(args, ['install', '--save-exact', '--ignore-scripts', `pi-fabric@${REVIEWED_FABRIC_VERSION}`]);
            throw new Error('download failed');
        } }), /download failed/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
});
//# sourceMappingURL=compatibility-patches.test.js.map