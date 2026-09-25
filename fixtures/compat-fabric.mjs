import assert from 'node:assert/strict';
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
const decision = await classifier.classify({ ref: 'pi.read', risk: 'read', description: 'fixture' }, {}, {
    cwd: process.cwd(), model: { provider: 'kiro-acp', id: 'auto' },
    sessionManager: { getSessionId: () => 'fixture', getBranch: () => [] },
    modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true }),
        getProvider: () => ({ streamSimple: (_model, transcript) => {
            nativeCalls++;
            assert.equal(transcript.messages[0].role, 'system', 'native provider must receive classifier instructions');
            assert.ok(transcript.messages[0].toolsAdded.some(tool => tool.name === 'classify_result'));
            return { result: async () => ({ stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'classify_result', arguments: { decision: 'allow', reason: 'offline fixture' } }], usage: {} }) };
        } }),
    },
});
assert.equal(decision.decision, 'allow'); assert.equal(nativeCalls, 1);
const config = loadFabricConfig({ agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd(), projectTrusted: false });
assert.equal(config.agents.model, 'kiro-acp/auto'); assert.equal(config.jev.enabled, false);
assert.equal(config.agents.maxConcurrent, 2); assert.equal(config.agents.maxDepth, 1);
console.log(JSON.stringify({ check: 'real Fabric dispatch guards and merged profile', result: 'passed', credentials, network, preparations }));
