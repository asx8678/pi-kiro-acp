import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fabricGuardStatus } from '../dist/src/policy/fabric.js';
const [root] = process.argv.slice(2);
const load = file => import(pathToFileURL(path.join(root, 'dist', file)).href);
const { DEFAULT_FABRIC_CONFIG, loadFabricConfig } = await load('chunks/chunk-F72MAIQY.js');
const { AgentManager } = await load('chunks/chunk-ZRI433JP.js');
const { JevClient } = await load('jev/client.js');
const { FabricAutoApprovalClassifier } = await load('chunks/chunk-D4B4CCTA.js');
assert.equal(fabricGuardStatus().ready, true);
let credentials = 0, network = 0, preparations = 0;
const manager = new AgentManager(process.cwd(), DEFAULT_FABRIC_CONFIG.agents, {
    runRoot: path.join(process.cwd(), 'runs'),
    preparePiModel: async () => { preparations++; return 'foreign/rewritten'; },
});
try {
    for (const request of [{ runner: 'claude' }, { runner: 'veda' }, { model: 'openai/a' }, { extensions: false }, { residency: 'durable' }, { transport: 'tmux' }])
        await assert.rejects(manager.spawn({ task: 'Never execute inference.', ...request }), /Kiro-only|Efficiency/);
    assert.equal(preparations, 0);
    await assert.rejects(manager.spawn({ task: 'Never execute inference.', model: 'kiro-acp/auto' }), /Kiro-only/);
    assert.equal(preparations, 1, 'resolved worker model is checked again before launch');
} finally { await manager.close(); }
const jev = new JevClient(DEFAULT_FABRIC_CONFIG.jev, async () => { network++; throw new Error('network forbidden'); }, { resolve: async () => { credentials++; return 'not-a-secret'; }, clear() {} });
try { await assert.rejects(jev.evaluate({}, new AbortController().signal), /Jev inference/); } finally { jev.close(); }
const classifier = new FabricAutoApprovalClassifier();
await assert.rejects(classifier.classify({}, {}, { model: { provider: 'foreign' }, modelRegistry: { getApiKeyAndHeaders: async () => { credentials++; return { ok: true }; } } }), /Kiro-only/);
assert.equal(credentials, 0); assert.equal(network, 0);
let nativeCalls = 0;
const nativeProvider = { completeStructured: async (_model, transcript, options) => {
    nativeCalls++;
    assert.equal(transcript.messages[0].role, 'system', 'native provider must receive classifier instructions');
    assert.ok(transcript.messages[0].toolsAdded.some(tool => tool.name === 'classify_result'));
    assert.equal(options.reasoning, undefined, 'Kiro keeps its advertised automatic effort');
    return { stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'classify_result', arguments: { decision: 'allow', reason: 'offline fixture' } }], usage: {} };
} };
const classifierContext = {
    cwd: process.cwd(), model: { provider: 'kiro-acp', id: 'auto', reasoning: true },
    sessionManager: { getSessionId: () => 'fixture', getBranch: () => [] },
    modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true }),
        getProvider: () => nativeProvider,
    },
};
const action = { ref: 'pi.read', risk: 'read', description: 'fixture' };
const decision = await classifier.classify(action, {}, classifierContext);
assert.equal(decision.decision, 'allow'); assert.equal(nativeCalls, 1);
// Pi's model-settings composer forwards standard methods only. Recover the
// bridge capability from its native registry without falling back to an effect.
const composedProvider = { streamSimple: () => { throw new Error('approval must never use a host-effect stream'); } };
classifierContext.modelRegistry.getProvider = () => composedProvider;
await assert.rejects(classifier.classify(action, {}, classifierContext), /updated ACP provider/);
classifierContext.modelRegistry.getRegisteredNativeProvider = () => nativeProvider;
assert.equal((await classifier.classify(action, {}, classifierContext)).decision, 'allow');
assert.equal(nativeCalls, 2);
const config = loadFabricConfig({ agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(), projectTrusted: false });
assert.equal(config.agents.model, 'kiro-acp/auto'); assert.equal(config.jev.enabled, false);
assert.equal(config.agents.maxConcurrent, 2); assert.equal(config.agents.maxDepth, 1);
const disabledProfile = path.join(process.cwd(), 'disabled-workers');
fs.mkdirSync(disabledProfile, { recursive: true });
fs.writeFileSync(path.join(disabledProfile, 'fabric.json'), JSON.stringify({ configVersion: 4, agents: { maxDepth: 0 } }));
const disabledConfig = loadFabricConfig({ agentDir: disabledProfile, cwd: process.cwd(), projectTrusted: false });
assert.equal(disabledConfig.agents.maxDepth, 0);
const disabledManager = new AgentManager(process.cwd(), disabledConfig.agents, {
    runRoot: path.join(process.cwd(), 'disabled-runs'),
    preparePiModel: async () => { throw new Error('zero-depth workers must not prepare a model'); },
});
try { await assert.rejects(disabledManager.spawn({ task: 'Never execute inference.' }), /depth limit reached \(0\)/); }
finally { await disabledManager.close(); }
console.log(JSON.stringify({ check: 'real Fabric dispatch guards and merged profile', result: 'passed', credentials, network, preparations }));
