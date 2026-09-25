#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentDir, writePrivateJson } from '../dist/src/config.js';
import { REVIEWED_FABRIC_VERSION } from '../dist/src/policy/fabric.js';
import { withFabricLock } from './fabric-lock.mjs';

const patch = fileURLToPath(new URL('./patch-fabric.mjs', import.meta.url));
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const fabricSource = source => typeof source === 'string' && /^npm:pi-fabric(?:@[^/]+)?$/.test(source);
const runCommand = (command, args, options) => {
    // Keep machine-readable Pi stdout clean when called by the launcher.
    const result = spawnSync(command, args, { ...options, stdio: ['ignore', 2, 2], shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal}). Fabric repair is incomplete; rerun before starting Pi.`);
};

// Runs before Pi loads extensions, or during explicit maintenance. Never call
// from a running extension: already imported modules cannot be repaired in place.
export function repairFabric(options = {}) {
    const dir = options.dir ?? agentDir();
    // Preserve the optional-Fabric no-op without creating profile directories.
    if (!fs.existsSync(dir)) return;
    return withFabricLock(dir, () => repairUnlocked({ ...options, dir }));
}

export function fabricInstallState(dir = agentDir()) {
    const settings = read(path.join(dir, 'settings.json'));
    const pkg = read(path.join(dir, 'npm/package.json'));
    const installed = read(path.join(dir, 'npm/node_modules/pi-fabric/package.json'));
    const sources = (settings.packages ?? []).map(entry => typeof entry === 'string' ? entry : entry?.source).filter(fabricSource);
    return {
        present: sources.length > 0 || Boolean(installed.name),
        needsInstall: installed.name !== 'pi-fabric' || installed.version !== REVIEWED_FABRIC_VERSION || pkg.dependencies?.['pi-fabric'] !== REVIEWED_FABRIC_VERSION,
        needsPin: sources.some(source => source !== `npm:pi-fabric@${REVIEWED_FABRIC_VERSION}`),
    };
}

function repairUnlocked({ dir, run = runCommand, report = console.log, offline = false }) {
    const settingsFile = path.join(dir, 'settings.json');
    const npmDir = path.join(dir, 'npm'), packageFile = path.join(npmDir, 'package.json');
    const root = path.join(npmDir, 'node_modules/pi-fabric');
    const settings = read(settingsFile), pkg = read(packageFile);
    const installed = read(path.join(root, 'package.json'));
    const selected = (settings.packages ?? []).some(entry => fabricSource(typeof entry === 'string' ? entry : entry?.source));
    if (!selected && !installed.name) {
        report('Fabric is not installed or selected; no repair needed.');
        return;
    }
    const version = REVIEWED_FABRIC_VERSION;
    const needsInstall = installed.name !== 'pi-fabric' || installed.version !== version || pkg.dependencies?.['pi-fabric'] !== version;
    if (needsInstall && offline)
        throw new Error(`Fabric ${version} must be installed and pinned before offline startup. Start Pi once without --offline or PI_OFFLINE to repair it.`);
    const command = settings.npmCommand ?? ['npm'];
    if (needsInstall && (!Array.isArray(command) || !command.length || !command.every(arg => typeof arg === 'string') || !/^(bun|npm)(\.cmd|\.exe)?$/.test(path.basename(command[0]))))
        throw new Error('Fabric repair requires npmCommand to select npm or bun. No files changed.');
    const packages = (settings.packages ?? []).map(entry => {
        if (fabricSource(entry)) return `npm:pi-fabric@${version}`;
        if (fabricSource(entry?.source)) return { ...entry, source: `npm:pi-fabric@${version}` };
        return entry;
    });
    const settingsChanged = JSON.stringify(packages) !== JSON.stringify(settings.packages ?? []);
    // Back up only configuration/lockfiles, never credentials. Dispatch originals
    // are retained by checkedPatch after all source hashes have been validated.
    if (needsInstall || settingsChanged) {
        const backup = fs.mkdtempSync(path.join(dir, 'fabric-repair-backup-'));
        fs.chmodSync(backup, 0o700);
        for (const [name, file] of [['settings.json', settingsFile], ['package.json', packageFile], ...['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json'].map(name => [name, path.join(npmDir, name)])]) {
            if (!fs.existsSync(file)) continue;
            const target = path.join(backup, name);
            fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(target, 0o600);
        }
        report(`Fabric configuration backup: ${backup}`);
    }
    if (needsInstall) {
        fs.mkdirSync(npmDir, { recursive: true });
        const bun = /^bun(\.exe)?$/.test(path.basename(command[0]));
        run(command[0], [...command.slice(1), ...(bun ? ['add', '--exact'] : ['install', '--save-exact']), '--ignore-scripts', `pi-fabric@${version}`], { cwd: npmDir });
        const actual = read(path.join(root, 'package.json'));
        if (actual.name !== 'pi-fabric' || actual.version !== version || read(packageFile).dependencies?.['pi-fabric'] !== version)
            throw new Error(`Package manager did not install and pin Fabric ${version}. Repair incomplete.`);
    }
    run(process.execPath, [patch, root]);
    run(process.execPath, [patch, root, '--check']);
    // Publish Pi's selection only after the exact installation passes validation.
    // Refuse to overwrite settings changed by another process during installation.
    if (JSON.stringify(read(settingsFile)) !== JSON.stringify(settings))
        throw new Error('Pi settings changed during Fabric repair. Rerun repair to synchronize the package selection.');
    if (settingsChanged) writePrivateJson(settingsFile, { ...settings, packages });
    report(`Fabric ${version} installed, pinned and verified. Restart Pi and existing workers.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length > 2) throw new Error('Usage: bun run repair:fabric. Select a profile with PI_CODING_AGENT_DIR.');
    repairFabric();
}
