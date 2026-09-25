#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaults, loadConfig, configPath, writePrivateJson } from './config.js';
import { ProviderRuntime } from './provider/runtime.js';
import { toModel, readCatalog, withContextWindow } from './provider/models.js';
import { Journal } from './storage/journal.js';
import { CreditLedger } from './storage/credits.js';
import { dashboardText } from './ui/usage-dashboard.js';
import { BridgeError, publicError } from './errors.js';
import { clientInfo, PACKAGE_VERSION } from './kiro/identity.js';
import { ensureInstallationId, installationStatus } from './installation.js';
const help = `pi-kiro-acp ${PACKAGE_VERSION} (experimental)

Commands:
  init --experimental [--allow-unverified-surface]  Write a private user config
  setup                                           Create/reuse the private installation ID
  doctor                                          Inspect CLI and catalog; no prompt
  models                                          Refresh the live Kiro model catalog
  planner EXACT_ID                                Validate and save planner selection
  status                                          Show cache/config status
  usage [YYYY-MM|YYYY-MM-DD] [--refresh] [--json]    Show usage; optionally refresh the account through Kiro CLI
  journal                                         List unresolved effects
  reconcile HANDOFF_ID --acknowledge-reviewed      Close an uncertain record AFTER reviewing effects
  live-smoke EXACT_ID --allow-billed                Explicitly billed text + host-handoff probe
  demo                                            Fully local fake-ACP demonstration

Use --config /absolute/path.json on any command. Authenticate with kiro-cli login.
The native tool inventory is required by default. Read docs/compatibility.md before
opting out: MCP readiness is not proof that native Kiro tools are absent.
`;
async function consume(stream) {
    for await (const event of stream)
        if (event.type === 'text_delta')
            process.stdout.write(event.delta);
    const result = await stream.result();
    process.stdout.write('\n');
    if (result.stopReason === 'error' || result.stopReason === 'aborted')
        throw new Error(result.errorMessage);
    return result;
}
async function probe(runtime, id, demo = false) {
    const { models } = await runtime.discover();
    const entry = models.find(m => m.id === id);
    if (!entry)
        throw new BridgeError('MODEL_UNAVAILABLE', 'Selected model is not in the live Kiro catalog.');
    const model = toModel(entry, runtime.config);
    const ctx = { messages: [
            { role: 'system', content: 'Use the bridge_probe tool exactly once, then report its actual response. Do not perform any other action.', toolsAdded: [{ name: 'bridge_probe', description: 'An inert host round-trip test. Returns a short marker. No filesystem or shell effects.', parameters: { type: 'object', properties: { value: { type: 'string' }, iteration: { type: 'number' } }, additionalProperties: false } }], timestamp: Date.now() },
            { role: 'user', content: demo ? 'CALL_TOOL' : 'Call bridge_probe with value "hello" exactly once, then report the response.', timestamp: Date.now() },
        ] };
    let calls = 0;
    for (let step = 0; step < 4; step++) {
        const result = await consume(runtime.generate(model, ctx, { sessionId: 'explicit-smoke' }));
        ctx.messages.push(result);
        if (result.stopReason !== 'toolUse') {
            if (calls !== 1)
                throw new BridgeError('PROTOCOL', `Probe did not execute exactly one tool (${calls}).`);
            console.log(JSON.stringify({ probe: 'passed', mode: demo ? 'offline-fixture' : 'live-billed', calls, credits: runtime.metrics.credits, limitations: 'This is not full Fovea/Fabric or long-wait qualification.' }, null, 2));
            return;
        }
        for (const call of result.content.filter((c) => c.type === 'toolCall')) {
            if (call.name !== 'bridge_probe' || calls !== 0)
                throw new BridgeError('POLICY', 'Probe refused an unexpected or repeated tool call.');
            calls++;
            ctx.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'PI_HOST_PROBE_OK' }], isError: false, timestamp: Date.now() });
        }
    }
    throw new BridgeError('LIMIT', 'Probe exceeded its bounded generation count.');
}
export async function main(args = process.argv.slice(2)) {
    args = [...args];
    const configIndex = args.indexOf('--config');
    if (configIndex >= 0) {
        const file = args[configIndex + 1];
        if (!file || file.startsWith('--') || args.lastIndexOf('--config') !== configIndex)
            throw new BridgeError('CONFIG', 'Supply exactly one path after --config.');
        process.env.PI_KIRO_ACP_CONFIG = path.resolve(file);
        args.splice(configIndex, 2);
    }
    const cmd = args[0] ?? 'help';
    if (['help', '--help', '-h'].includes(cmd)) {
        console.log(help);
        return;
    }
    if (cmd === 'init') {
        if (fs.existsSync(configPath()))
            throw new BridgeError('CONFIG', `Configuration already exists at ${configPath()}; it was not overwritten.`);
        const c = defaults();
        c.compatibility.allowUnverified = args.includes('--experimental');
        if (args.includes('--allow-unverified-surface')) {
            if (!c.compatibility.allowUnverified)
                throw new BridgeError('CONFIG', 'Unverified tool-surface opt-out requires --experimental.');
            c.compatibility.requireToolSnapshot = false;
        }
        writePrivateJson(configPath(), c);
        ensureInstallationId(c);
        console.log(`Created ${configPath()}\nExperimental live use: ${c.compatibility.allowUnverified}. No model calls were made.`);
        return;
    }
    if (cmd === 'demo') {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kiro-demo-'));
        const c = defaults();
        c.stateDir = temp;
        c.cli.binary = process.execPath;
        c.cli.prefixArgs = [fileURLToPath(new URL('../../fixtures/fake-kiro.mjs', import.meta.url))];
        c.compatibility.allowUnverified = true;
        c.cli.rpcTimeoutMs = 5000;
        const runtime = new ProviderRuntime(c);
        try {
            await probe(runtime, 'test-opus', true);
        }
        finally {
            await runtime.close();
            fs.rmSync(temp, { recursive: true, force: true });
        }
        return;
    }
    const config = loadConfig();
    if (cmd === 'setup') {
        ensureInstallationId(config);
        console.log(JSON.stringify({ installation: installationStatus(config) }, null, 2));
        return;
    }
    if (cmd === 'usage') {
        const selected = args.slice(1).find(arg => !arg.startsWith('--'));
        if (args.includes('--refresh')) {
            const runtime = new ProviderRuntime(config);
            try {
                await runtime.refreshAccountUsage(true);
                const data = runtime.credits.dashboard(selected);
                console.log(args.includes('--json') ? JSON.stringify(data, null, 2) : dashboardText(data));
            }
            finally {
                await runtime.close();
            }
            return;
        }
        const journal = new Journal(config.stateDir);
        try {
            const data = new CreditLedger(journal, config.admission.scope, config.budget, config.reporting.timeZone, config.reporting.retainTaskExcerpts).dashboard(selected);
            console.log(args.includes('--json') ? JSON.stringify(data, null, 2) : dashboardText(data));
        }
        finally {
            journal.close();
        }
        return;
    }
    if (cmd === 'status') {
        console.log(JSON.stringify({ configuration: configPath(), installation: installationStatus(config), clientInfo: clientInfo(config.client.name), experimental: config.compatibility.allowUnverified, cachedModels: readCatalog(config).map(entry => withContextWindow(entry, config)), plannerId: config.models.plannerId, workerId: config.models.workerId, usage: 'unknown; zero numeric Pi cost is not evidence of free inference' }, null, 2));
        return;
    }
    if (cmd === 'journal' || cmd === 'reconcile') {
        const journal = new Journal(config.stateDir);
        try {
            journal.reconcileDeadOwners();
            if (cmd === 'journal') {
                console.log(JSON.stringify(journal.unresolved(), null, 2));
                return;
            }
            if (!args.includes('--acknowledge-reviewed'))
                throw new BridgeError('CONFIG', 'Review actual Pi tool results/files first, then explicitly pass --acknowledge-reviewed.');
            const row = journal.get(args[1] ?? '');
            if (!row)
                throw new BridgeError('CONFIG', 'Unknown handoff ID.');
            if (journal.ownerLive(row.owner_instance, row.owner_pid))
                throw new BridgeError('BUSY', 'The owner process is still alive. Close the owning Pi session before reconciliation.');
            if (!['UNCERTAIN', 'RECEIVED', 'RESULT_RECORDED'].includes(row.phase))
                throw new BridgeError('CONFIG', 'This record is not eligible for manual reconciliation.');
            journal.transition(row.id, 'CANCELLED');
            console.log('Record reconciled by operator. No action was executed or rolled back.');
        }
        finally {
            journal.close();
        }
        return;
    }
    const runtime = new ProviderRuntime(config);
    let interrupted = false;
    const interrupt = () => {
        if (!interrupted) {
            interrupted = true;
            void runtime.close();
        }
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try {
        switch (cmd) {
            case 'doctor': {
                const result = await runtime.discover();
                console.log(JSON.stringify({ node: process.version, clientInfo: clientInfo(config.client.name), ...result, authentication: 'CLI-owned; inference entitlement is not proven by discovery alone', paidPromptSent: false, experimental: config.compatibility.allowUnverified, toolInventoryRequirement: config.compatibility.requireToolSnapshot, limitsAre: 'context windows are reported by Kiro when available, with a configured fallback; other limits are adapter ceilings' }, null, 2));
                break;
            }
            case 'models':
                console.log(JSON.stringify((await runtime.discover()).models, null, 2));
                break;
            case 'planner': {
                const id = args[1];
                const { models } = await runtime.discover();
                if (!id || !models.some(m => m.id === id))
                    throw new BridgeError('MODEL_UNAVAILABLE', 'Use an exact ID from the live models command.');
                config.models.plannerId = id;
                writePrivateJson(configPath(), config);
                console.log(`Saved planner preference ${id}. Select kiro-acp/${id} in Pi; no model prompt was sent.`);
                break;
            }
            case 'live-smoke':
                if (!args.includes('--allow-billed') || !args[1] || args[1].startsWith('--'))
                    throw new BridgeError('CONFIG', 'Usage: live-smoke EXACT_ID --allow-billed');
                await probe(runtime, args[1]);
                break;
            default: throw new BridgeError('CONFIG', 'Unknown command. Run --help.');
        }
    }
    finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
        await runtime.close();
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void main().catch(e => { console.error(publicError(e)); process.exitCode = 1; });
//# sourceMappingURL=cli.js.map