import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { agentDir, loadConfig } from '../config.js';
import { BridgeError } from '../errors.js';
import { object } from '../util.js';
const config = loadConfig();
export const FABRIC_POLICY_VERSION = 1;
export const WORKER_LIMITS = { maxConcurrent: 2, maxPerExecution: 4, maxDepth: 1, timeoutMs: 900000 };
const record = (value) => object(value) ? value : {};
const cap = (value, ceiling) => typeof value === 'number' && value > 0 ? Math.min(value, ceiling) : ceiling;
/** Called by the installed Fabric dispatch patch, before resolving credentials or spawning. */
export function assertFabricProvider(provider) {
    if (config.policy.kiroOnly && provider !== 'kiro-acp')
        throw new BridgeError('POLICY', 'Kiro-only profile: Fabric inference requires the kiro-acp provider.');
}
export function rejectFabricJev() {
    if (config.policy.kiroOnly)
        throw new BridgeError('POLICY', 'Kiro-only profile: Jev inference and semantic search are disabled.');
}
export function guardFabricWorker(request, defaults = {}) {
    const next = { ...request };
    if (config.policy.kiroOnly) {
        if ((next.runner ?? defaults.runner ?? 'pi') !== 'pi')
            throw new BridgeError('POLICY', 'Kiro-only profile: Claude and Veda worker runners are disabled.');
        const model = next.model ?? defaults.model ?? `kiro-acp/${config.models.workerId}`;
        if (typeof model !== 'string' || !model.startsWith('kiro-acp/') || model.length <= 'kiro-acp/'.length)
            throw new BridgeError('POLICY', 'Kiro-only profile: workers require an explicit kiro-acp/model selector.');
        if ((next.extensions ?? defaults.extensions) === false)
            throw new BridgeError('POLICY', 'Kiro-only workers require extensions for the ACP provider and credit ledger.');
        next.model = model;
        next.extensions = true;
        // Detached tasks can outlive the foreground budget/limits and leave unobserved work.
        if (config.efficiency.enabled && next.residency === 'durable')
            throw new BridgeError('POLICY', 'Efficiency profile: use session workers; durable workers are disabled.');
    }
    if (config.efficiency.enabled) {
        if ((next.transport ?? defaults.transport ?? 'process') !== 'process')
            throw new BridgeError('POLICY', 'Efficiency profile: process workers preserve task accounting and bounded lifetimes.');
        next.transport = 'process';
        next.timeoutMs = cap(next.timeoutMs ?? defaults.timeoutMs, WORKER_LIMITS.timeoutMs);
    }
    return next;
}
/** Applies after project settings are merged, so they cannot accidentally undo this profile. */
export function applyFabricProfile(raw) {
    const value = structuredClone(raw);
    if (config.policy.kiroOnly) {
        value.jev = { ...record(value.jev), enabled: false };
        const mcp = record(value.mcp);
        value.mcp = { ...mcp, jev: { ...record(mcp.jev), semanticSearch: false } };
        value.approvals = { ...record(value.approvals), model: 'kiro-acp/auto' };
        value.agents = { ...record(value.agents), runner: 'pi', model: `kiro-acp/${config.models.workerId}`, extensions: true };
    }
    if (config.efficiency.enabled) {
        const agents = record(value.agents), executor = record(value.executor);
        value.fullCodeMode = true;
        value.agents = { ...agents, transport: 'process', ...Object.fromEntries(Object.entries(WORKER_LIMITS).map(([key, limit]) => [key, cap(agents[key], limit)])) };
        value.executor = { ...executor, maxOutputChars: cap(executor.maxOutputChars, 12000), maxNestedResultChars: cap(executor.maxNestedResultChars, 64000) };
        value.prewalk = { ...record(value.prewalk), enabled: false, alwaysRearm: false, model: 'kiro-acp/auto', thinking: 'low' };
        value.compaction = { ...record(value.compaction), engine: 'fabric', targetContextRatio: 0.5 };
    }
    return value;
}
/** Detect an update that removed or changed the reviewed patch before allowing Fabric calls. */
export function fabricGuardStatus() {
    const root = path.join(agentDir(), 'npm', 'node_modules', 'pi-fabric');
    if (!fs.existsSync(path.join(root, 'package.json')))
        return { installed: false, ready: true };
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, '.kiro-acp-policy.json'), 'utf8'));
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (!object(manifest) || !object(pkg) || manifest.version !== FABRIC_POLICY_VERSION || pkg.version !== manifest.fabricVersion || !object(manifest.files) || Object.keys(manifest.files).length !== 5)
            throw new Error('version/manifest mismatch');
        for (const [name, expected] of Object.entries(manifest.files)) {
            if (!/^dist\/(?:chunks\/)?[\w.-]+\.js$/.test(name))
                throw new Error('invalid manifest path');
            const actual = createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
            if (actual !== expected)
                throw new Error('installed dispatch code changed');
        }
        return { installed: true, ready: true };
    }
    catch {
        return { installed: true, ready: false, reason: 'Fabric routing guard is missing or changed. In pi-kiro-acp run bun run patch:fabric, then restart Pi. A new Fabric version requires review before patching.' };
    }
}
//# sourceMappingURL=fabric.js.map