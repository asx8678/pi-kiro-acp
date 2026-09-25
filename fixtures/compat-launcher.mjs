// Exercise the launcher with reviewed installed Fabric bytes, in a disposable
// profile. No Pi/model process or package manager is started.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FABRIC_PATCH_FILES, REVIEWED_FABRIC_VERSION } from '../dist/src/policy/fabric.js';

const source = process.argv[2] ?? path.join(os.homedir(), '.pi/agent/npm/node_modules/pi-fabric');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-launcher-compat-'));
const root = path.join(profile, 'npm/node_modules/pi-fabric');
const prepare = fileURLToPath(new URL('../scripts/prepare-pi.mjs', import.meta.url));
const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_KIRO_ACP_CONFIG: path.join(profile, 'kiro-acp.json'), PI_OFFLINE: '1', PI_FABRIC_DEPTH: '' };
const run = () => {
    const result = spawnSync(process.execPath, [prepare, '--offline', '--mode', 'json'], { env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.stdout, '', 'preflight must not pollute protocol stdout');
    return result;
};
try {
    const settings = { theme: 'keep', packages: [{ source: 'npm:pi-fabric', skills: [], extensions: ['dist/index.js'] }, 'npm:unrelated'] };
    fs.mkdirSync(root, { recursive: true });
    fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
    fs.writeFileSync(path.join(profile, 'npm/package.json'), JSON.stringify({ dependencies: { 'pi-fabric': REVIEWED_FABRIC_VERSION } }));
    for (const name of FABRIC_PATCH_FILES) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        const original = path.join(source, `${name}.kiro-acp-original`);
        fs.copyFileSync(fs.existsSync(original) ? original : path.join(source, name), path.join(root, name));
    }
    let result = run(); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Fabric verified; starting Pi/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')), {
        ...settings, packages: [{ ...settings.packages[0], source: `npm:pi-fabric@${REVIEWED_FABRIC_VERSION}` }, 'npm:unrelated'],
    });
    const manifestFile = path.join(root, '.kiro-acp-policy.json');
    const timestamp = fs.statSync(manifestFile).mtimeMs;
    result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(fs.statSync(manifestFile).mtimeMs, timestamp, 'healthy startup must not rewrite the manifest');
    // Rebuilt policy checksum and overwritten files recover independently.
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, policyHash: 'old build' }));
    result = run(); assert.equal(result.status, 0, result.stderr);
    for (const name of FABRIC_PATCH_FILES) fs.copyFileSync(path.join(root, `${name}.kiro-acp-original`), path.join(root, name));
    fs.unlinkSync(manifestFile);
    result = run(); assert.equal(result.status, 0, result.stderr);
    const changed = path.join(root, FABRIC_PATCH_FILES[0]);
    fs.appendFileSync(changed, '\n// unknown edit');
    const bytes = fs.readFileSync(changed);
    result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /Modified pi-fabric installation/);
    assert.deepEqual(fs.readFileSync(changed), bytes);
    console.log(JSON.stringify({ check: 'automatic Fabric repair with real package bytes', result: 'passed', cases: ['missing patch', 'healthy no-op', 'policy rebuild', 'reinstall', 'unknown code refusal', 'settings preservation', 'clean stdout'], productionPackagesChanged: false, paidPrompts: 0 }));
} finally {
    // Only the explicitly generated profile and selected package files above.
    fs.rmSync(profile, { recursive: true, force: true });
}
