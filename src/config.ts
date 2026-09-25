import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './errors.js';
import { object, boundedString, type Obj } from './util.js';
export interface Config {
    version: 1;
    providerId: 'kiro-acp';
    client: {
        name: 'kirocrew' | 'pi-fabric' | 'pi';
    };
    cli: {
        binary: string;
        prefixArgs: string[];
        rpcTimeoutMs: number;
        promptTimeoutMs: number;
        cancelGraceMs: number;
    };
    compatibility: {
        allowUnverified: boolean;
        approvedVersions: string[];
        orderedSteeringVersions: string[];
        requireToolSnapshot: boolean;
    };
    models: {
        plannerId: string | null;
        workerId: string;
        contextWindow: number;
        maxTokens: number;
    };
    sessions: {
        idleTtlMs: number;
        maxResident: number;
        forceRebuild: boolean;
    };
    limits: {
        maxFrameBytes: number;
        maxPromptBytes: number;
        maxOutputBytes: number;
        maxToolResultBytes: number;
        maxQueuedEvents: number;
        maxHandoffMs: number;
    };
    admission: {
        scope: string;
        maxActive: number;
        maxQueued: number;
        waitMs: number;
    };
    policy: {
        kiroOnly: boolean;
    };
    budget: {
        dailyCredits: number;
        warningCredits: number;
        warningFraction: number;
    };
    efficiency: {
        enabled: boolean;
        contextTokens: number;
    };
    reporting: {
        timeZone: string;
        accountCacheMs: number;
        retainTaskExcerpts: boolean;
    };
    stateDir: string;
}
export function agentDir(): string { return path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')); }
export function configPath(): string { return path.resolve(process.env.PI_KIRO_ACP_CONFIG || path.join(agentDir(), 'kiro-acp.json')); }
export function defaults(): Config {
    return {
        version: 1, providerId: 'kiro-acp',
        client: { name: 'kirocrew' },
        cli: { binary: 'kiro-cli', prefixArgs: [], rpcTimeoutMs: 30000, promptTimeoutMs: 3600000, cancelGraceMs: 2000 },
        compatibility: { allowUnverified: false, approvedVersions: [], orderedSteeringVersions: [], requireToolSnapshot: true },
        models: { plannerId: null, workerId: 'auto', contextWindow: 64000, maxTokens: 8192 },
        sessions: { idleTtlMs: 900000, maxResident: 6, forceRebuild: false },
        limits: { maxFrameBytes: 16 * 1024 * 1024, maxPromptBytes: 4 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxToolResultBytes: 2 * 1024 * 1024, maxQueuedEvents: 8192, maxHandoffMs: 3600000 },
        admission: { scope: 'default-kiro-account', maxActive: 3, maxQueued: 32, waitMs: 120000 },
        policy: { kiroOnly: true },
        budget: { dailyCredits: 0, warningCredits: 50, warningFraction: 0.8 },
        efficiency: { enabled: true, contextTokens: 48000 },
        reporting: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', accountCacheMs: 300000, retainTaskExcerpts: false },
        stateDir: path.join(agentDir(), 'kiro-acp'),
    };
}
function keys(input: Obj, allowed: string[], label: string): void {
    for (const k of Object.keys(input))
        if (!allowed.includes(k))
            throw new BridgeError('CONFIG', `Unknown ${label}.${k}.`);
}
export function parseConfig(raw: unknown): Config {
    if (!object(raw))
        throw new BridgeError('CONFIG', 'Configuration must be a JSON object.');
    const d = defaults();
    keys(raw, Object.keys(d), 'config');
    const result: Obj = { ...d };
    for (const key of Object.keys(d)) {
        if (!(key in raw))
            continue;
        const value = raw[key];
        const def = (d as unknown as Obj)[key];
        if (object(def)) {
            if (!object(value))
                throw new BridgeError('CONFIG', `${key} must be an object.`);
            keys(value, Object.keys(def), key);
            result[key] = { ...def, ...value };
        }
        else
            result[key] = value;
    }
    const c = result as unknown as Config;
    if (c.version !== 1 || c.providerId !== 'kiro-acp')
        throw new BridgeError('CONFIG', 'Only schema version 1 and provider kiro-acp are supported.');
    if (c.client.name !== 'kirocrew' && c.client.name !== 'pi-fabric' && c.client.name !== 'pi')
        throw new BridgeError('CONFIG', 'client.name must be kirocrew, pi-fabric or pi.');
    c.cli.binary = boundedString(c.cli.binary, 'cli.binary');
    c.stateDir = path.resolve(boundedString(c.stateDir, 'stateDir'));
    c.admission.scope = boundedString(c.admission.scope, 'admission.scope');
    c.models.workerId = boundedString(c.models.workerId, 'models.workerId');
    if (c.models.plannerId !== null)
        boundedString(c.models.plannerId, 'models.plannerId');
    for (const [label, values] of [['cli.prefixArgs', c.cli.prefixArgs], ['compatibility.approvedVersions', c.compatibility.approvedVersions], ['compatibility.orderedSteeringVersions', c.compatibility.orderedSteeringVersions]] as const) {
        if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || v.length > 8192) || values.length > 32)
            throw new BridgeError('CONFIG', `Invalid ${label}.`);
    }
    for (const section of ['cli', 'models', 'sessions', 'limits', 'admission', 'efficiency', 'reporting'] as const) {
        const value = c[section] as unknown as Obj;
        const template = d[section] as unknown as Obj;
        for (const [k, v] of Object.entries(value))
            if (typeof template[k] === 'number' && (!Number.isSafeInteger(v) || Number(v) <= 0 || Number(v) > 2147483647))
                throw new BridgeError('CONFIG', `${section}.${k} must be a positive bounded integer.`);
    }
    for (const section of ['compatibility', 'sessions', 'policy', 'efficiency', 'reporting'] as const) {
        const v = c[section] as unknown as Obj, base = d[section] as unknown as Obj;
        for (const [k, x] of Object.entries(v))
            if (typeof base[k] === 'boolean' && typeof x !== 'boolean')
                throw new BridgeError('CONFIG', `${section}.${k} must be boolean.`);
    }
    if (c.models.maxTokens >= c.models.contextWindow)
        throw new BridgeError('CONFIG', 'models.maxTokens must be below contextWindow.');
    if (c.cli.promptTimeoutMs < c.limits.maxHandoffMs)
        throw new BridgeError('CONFIG', 'promptTimeoutMs must be at least maxHandoffMs.');
    if (!Number.isFinite(c.budget.dailyCredits) || c.budget.dailyCredits < 0 || c.budget.dailyCredits > 1000000)
        throw new BridgeError('CONFIG', 'budget.dailyCredits must be between 0 (disabled) and 1000000.');
    if (!Number.isFinite(c.budget.warningCredits) || c.budget.warningCredits < 0 || c.budget.warningCredits > 1000000)
        throw new BridgeError('CONFIG', 'budget.warningCredits must be between 0 (disabled) and 1000000.');
    if (!Number.isFinite(c.budget.warningFraction) || c.budget.warningFraction <= 0 || c.budget.warningFraction > 1)
        throw new BridgeError('CONFIG', 'budget.warningFraction must be greater than 0 and at most 1.');
    c.reporting.timeZone = boundedString(c.reporting.timeZone, 'reporting.timeZone');
    try { new Intl.DateTimeFormat('en', { timeZone: c.reporting.timeZone }).format(); }
    catch { throw new BridgeError('CONFIG', 'reporting.timeZone must be a valid IANA time zone.'); }
    // A serialized transcript is escaped again inside ACP JSON. Leave envelope headroom.
    if (c.limits.maxFrameBytes < 2 * c.limits.maxPromptBytes + 65536)
        throw new BridgeError('CONFIG', 'maxFrameBytes must be at least 2 * maxPromptBytes + 65536 for ACP escaping.');
    return c;
}
export function loadConfig(file = configPath()): Config {
    try {
        return parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    catch (e) {
        if (object(e) && e.code === 'ENOENT')
            return defaults();
        throw e;
    }
}
export function privateDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory())
        throw new BridgeError('CONFIG', 'State/config directory must be a real directory, not a symlink.');
    if (process.getuid && st.uid !== process.getuid())
        throw new BridgeError('CONFIG', 'State/config directory is not owned by the current user.');
    fs.chmodSync(dir, 0o700);
}
export function writePrivateJson(file: string, value: unknown): void {
    privateDir(path.dirname(file));
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
        throw new BridgeError('CONFIG', 'Refusing to overwrite a symlink.');
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
}
