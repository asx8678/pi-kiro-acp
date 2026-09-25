#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDir } from '../dist/src/config.js';
import { fabricGuardStatus, REVIEWED_FABRIC_VERSION } from '../dist/src/policy/fabric.js';
import { fabricInstallState, repairFabric } from './repair-fabric.mjs';

// This process exits before the shell execs Pi. No extension or model is loaded.
export function preparePi({ args = [], dir = agentDir(), report = console.error,
    repair = repairFabric, env = process.env } = {}) {
    const maintenance = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'login', 'logout', '--help', '-h', '--version', '-v']);
    if (maintenance.has(args[0])) return;
    const state = fabricInstallState(dir);
    if (!state.present) return;
    if (fabricGuardStatus(dir).ready && !state.needsInstall && !state.needsPin) return;
    if (Number(env.PI_FABRIC_DEPTH) > 0)
        throw new Error('Fabric needs repair. Restart the foreground Pi through the managed launcher before starting workers.');
    report(`[pi-kiro-acp] Repairing Fabric ${REVIEWED_FABRIC_VERSION} before starting Pi…`);
    repair({ dir, report, offline: args.includes('--offline') || /^(1|true|yes)$/i.test(env.PI_OFFLINE ?? '') });
    const after = fabricInstallState(dir), guard = fabricGuardStatus(dir);
    if (!guard.ready || after.needsInstall || after.needsPin)
        throw new Error(guard.reason ?? 'Fabric repair did not synchronize the reviewed version and pins. Pi was not started.');
    report('[pi-kiro-acp] Fabric verified; starting Pi.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { preparePi({ args: process.argv.slice(2) }); }
    catch (error) { console.error(`[pi-kiro-acp] ${error.message}`); process.exitCode = 1; }
}
