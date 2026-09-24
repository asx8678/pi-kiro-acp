import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaults, writePrivateJson } from '../src/config.js';
import { ensureInstallationId, installationIdPath, installationStatus } from '../src/installation.js';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const moduleUrl = new URL('../src/installation.js', import.meta.url).href;
const installer = fileURLToPath(new URL('../../scripts/install-pi.mjs', import.meta.url));
test('installation ID has Crew UUID4 hex format, is private and survives repeated setup', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = { stateDir: path.join(root, 'first') };
    assert.equal(installationStatus(config).initialized, false);
    assert.equal(fs.existsSync(config.stateDir), false, 'status must not create state');
    const id = ensureInstallationId(config);
    assert.match(id, /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    assert.equal(fs.readFileSync(installationIdPath(config), 'utf8'), id);
    assert.equal(ensureInstallationId(config), id);
    assert.notEqual(ensureInstallationId({ stateDir: path.join(root, 'second') }), id);
    assert.equal(installationStatus(config).initialized, true);
    assert.equal(JSON.stringify(installationStatus(config)).includes(id), false);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(config.stateDir).mode & 0o777, 0o700);
        assert.equal(fs.statSync(installationIdPath(config)).mode & 0o777, 0o600);
        fs.chmodSync(installationIdPath(config), 0o644);
        ensureInstallationId(config);
        assert.equal(fs.statSync(installationIdPath(config)).mode & 0o777, 0o600);
    }
});
test('simultaneous first installs converge on one complete persisted ID', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-race-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = { stateDir: path.join(root, 'state') };
    const code = `import { ensureInstallationId } from ${JSON.stringify(moduleUrl)};
        process.stdout.write(ensureInstallationId({ stateDir: process.argv[1] }));`;
    const results = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, ['--input-type=module', '-e', code, config.stateDir], { timeout: 10000 })));
    const ids = results.map(r => r.stdout);
    assert.equal(new Set(ids).size, 1);
    assert.equal(ids[0], fs.readFileSync(installationIdPath(config), 'utf8'));
    assert.deepEqual(fs.readdirSync(config.stateDir), [path.basename(installationIdPath(config))]);
});
test('invalid or oversized local IDs are refused without silently rotating them', t => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-invalid-'));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const config = { stateDir }, file = installationIdPath(config);
    for (const value of ['', 'not-an-id', 'A'.repeat(32), 'a'.repeat(5000)]) {
        fs.writeFileSync(file, value);
        assert.throws(() => ensureInstallationId(config), /Installation ID/);
        assert.equal(fs.readFileSync(file, 'utf8'), value);
    }
});
test('installation setup refuses symlinks and non-regular identity files', { skip: process.platform === 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-symlink-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = { stateDir: path.join(root, 'state') }, file = installationIdPath(config);
    fs.mkdirSync(config.stateDir);
    const outside = path.join(root, 'outside');
    const id = randomUUID().replaceAll('-', '');
    fs.writeFileSync(outside, id, { mode: 0o644 });
    fs.symlinkSync(outside, file);
    assert.throws(() => ensureInstallationId(config), /regular file/);
    assert.equal(fs.readFileSync(outside, 'utf8'), id);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.throws(() => ensureInstallationId(config), /regular file/);
});
test('setup lifecycle uses the selected state directory and never prints the ID', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = defaults();
    config.stateDir = path.join(root, 'custom-state');
    config.cli.binary = 'must-not-start-kiro-during-installation';
    const configFile = path.join(root, 'profile', 'kiro-acp.json');
    writePrivateJson(configFile, config);
    const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(root, 'unused-profile'), PI_KIRO_ACP_CONFIG: configFile };
    const run = (command) => {
        const result = spawnSync(process.execPath, [cli, command], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    assert.equal(JSON.parse(run('status')).installation.initialized, false);
    assert.equal(fs.existsSync(config.stateDir), false);
    const first = run('setup');
    const id = fs.readFileSync(installationIdPath(config), 'utf8');
    const second = run('setup');
    assert.equal(fs.readFileSync(installationIdPath(config), 'utf8'), id);
    assert.equal((first + second + run('status')).includes(id), false);
    assert.equal(JSON.parse(first).installation.initialized, true);
    assert.equal(fs.existsSync(env.PI_CODING_AGENT_DIR), false);
    assert.equal(fs.readFileSync(configFile, 'utf8').includes(id), false);
});
test('init generates a private identity alongside a new profile configuration', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-init-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const profile = path.join(root, 'profile');
    const file = path.join(profile, 'kiro-acp.json');
    const result = spawnSync(process.execPath, [cli, 'init', '--experimental'], {
        cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_KIRO_ACP_CONFIG: file },
        encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = fs.readFileSync(installationIdPath(config), 'utf8');
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal((result.stdout + fs.readFileSync(file, 'utf8')).includes(id), false);
});
test('Pi install wrapper initializes only after registration succeeds and preserves the ID on reinstall', { skip: process.platform === 'win32' }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-wrapper-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = defaults();
    config.stateDir = path.join(root, 'state');
    const configFile = path.join(root, 'profile', 'kiro-acp.json');
    writePrivateJson(configFile, config);
    const fakePi = path.join(root, 'pi'), capture = path.join(root, 'pi-args.json');
    fs.writeFileSync(fakePi, '#!/usr/bin/env node\nprocess.exit(7);\n', { mode: 0o700 });
    const env = { ...process.env, PI_BIN: fakePi, PI_KIRO_ACP_CONFIG: configFile };
    const run = () => spawnSync(process.execPath, [installer], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(run().status, 7);
    assert.equal(fs.existsSync(config.stateDir), false);
    fs.writeFileSync(fakePi, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`);
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const id = fs.readFileSync(installationIdPath(config), 'utf8');
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), ['install', fileURLToPath(new URL('../../', import.meta.url))]);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(installationIdPath(config), 'utf8'), id);
    assert.equal((first.stdout + second.stdout).includes(id), false);
});
test('npm archives exclude local installation state even inside included source directories', { skip: process.platform === 'win32' }, t => {
    const available = spawnSync('npm', ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (available.error && 'code' in available.error && available.error.code === 'ENOENT') {
        t.skip('npm is optional; package verification requires it');
        return;
    }
    assert.equal(available.status, 0, available.stderr);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-installation-pack-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['package.json', '.gitignore'])
        fs.copyFileSync(new URL(`../../${name}`, import.meta.url), path.join(root, name));
    for (const directory of ['', 'src', 'dist/src', 'scripts', 'examples']) {
        const folder = path.join(root, directory);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'kiro-acp-installation-id'), 'private-state-placeholder');
        fs.writeFileSync(path.join(folder, '.kiro-acp-installation-id.probe.tmp'), 'private-state-placeholder');
    }
    fs.writeFileSync(path.join(root, 'src/public.ts'), 'export {};\n');
    const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: root, env: { ...process.env, npm_config_cache: path.join(root, 'npm-cache') },
        encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr);
    const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
    assert.ok(files.includes('src/public.ts'), 'the package must still include its public source');
    assert.deepEqual(files.filter(file => file.includes('kiro-acp-installation-id')), []);
});
//# sourceMappingURL=installation.test.js.map