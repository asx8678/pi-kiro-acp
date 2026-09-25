// The real Fabric classifier and registered ACP provider, using only fake Kiro.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, context, collect, addResult, cleanup } from '../dist/tests/helpers.js';
import { writePrivateJson } from '../dist/src/config.js';
import { toModel } from '../dist/src/provider/models.js';
import { LocalStream } from '../dist/src/provider/stream.js';
import { fallbackExtractors } from '../dist/src/context/snapshot.js';

const [fabric] = process.argv.slice(2);
const c = config(); c.admission.maxActive = 1; c.sessions.maxResident = 2;
writePrivateJson(process.env.PI_KIRO_ACP_CONFIG, c);
const { installExtension } = await import('../dist/src/index.js');
const { FabricAutoApprovalClassifier } = await import(pathToFileURL(path.join(fabric, 'dist/chunks/chunk-D4B4CCTA.js')).href);
const handlers = new Map(); let provider;
const r = await installExtension({
    registerProvider: value => { provider = value; }, registerCommand() {},
    on: (event, handler) => { handlers.set(event, handler); },
}, { createAssistantMessageEventStream: () => new LocalStream(), getCurrentSystemPrompt: fallbackExtractors.system, getCurrentTools: fallbackExtractors.tools });
const model = toModel({ id: 'test-opus', name: 'Offline classifier fixture', efforts: ['low', 'medium', 'high'] }, c);
const sessionId = 'approval-with-held-main';
const host = { cwd: process.cwd(), model, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] } };
const classifierContext = { ...host, modelRegistry: { getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true }) } };
const classifier = new FabricAutoApprovalClassifier();
const action = { ref: 'pi.read', risk: 'read', description: 'CALL_TOOL: an inert fixture' };
const argsFile = path.join(c.stateDir, 'decision.json');
const count = table => r.journal.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const assertDrained = () => {
    assert.deepEqual(r.admission.status(), []);
    assert.equal(count('binding_reservations'), 0);
    assert.equal(r.status().sessions.length, 1, 'only the main session may remain resident');
};
try {
    await handlers.get('session_start')({}, host);
    const transcript = context();
    const first = await collect(provider.streamSimple(model, transcript, { sessionId }));
    assert.equal(first.stopReason, 'toolUse', first.errorMessage);
    const pending = r.journal.unresolved()[0];
    // The already-running parent keeps its original args. Only newly created
    // approval sessions receive the classifier's data-shaped result.
    r.config.cli.prefixArgs.push('--tool-arguments-file', argsFile);
    writePrivateJson(argsFile, { decision: 'allow', reason: 'offline fixture' });
    const decision = await classifier.classify(action, {}, classifierContext);
    assert.equal(decision.decision, 'allow');
    assert.deepEqual(r.journal.unresolved(), [pending], 'classification must preserve the pending host effect');
    assert.equal(count('handoffs'), 1);
    assertDrained();
    addResult(transcript, first);
    const continuation = await collect(provider.streamSimple(model, transcript, { sessionId }));
    assert.equal(continuation.stopReason, 'stop', continuation.errorMessage);
    assert.equal(r.metrics.rebuilds, 0);
    assert.equal(count('credit_prompts'), 2, 'the main ACP prompt resumes instead of being replaced');
    assert.deepEqual(r.journal.unresolved(), []);
    for (let i = 0; i < 5; i++) {
        assert.equal((await classifier.classify(action, {}, classifierContext)).decision, 'allow');
        assertDrained();
    }
    writePrivateJson(argsFile, { decision: 'invalid', reason: 'not a valid classifier decision' });
    await assert.rejects(classifier.classify(action, {}, classifierContext), /invalid decision/);
    assertDrained();
    assert.equal(count('handoffs'), 1, 'approval output must never enter the effect journal');
    assert.equal(r.journal.db.prepare('SELECT COUNT(DISTINCT task_id) AS n FROM credit_prompts').get().n, 1);
    assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts WHERE finished=0').get().n, 0);
    transcript.messages.push(continuation, { role: 'user', content: 'An ordinary follow-up', timestamp: Date.now() });
    const followup = await collect(provider.streamSimple(model, transcript, { sessionId }));
    assert.equal(followup.stopReason, 'stop', followup.errorMessage);
    console.log(JSON.stringify({ check: 'real Fabric classifier + registered provider + fake Kiro', result: 'passed', approvals: 7, hostEffects: r.metrics.toolCalls, paidPrompts: 0 }));
} finally {
    await handlers.get('session_shutdown')({}, host);
    await cleanup(r, c);
    fs.unlinkSync(process.env.PI_KIRO_ACP_CONFIG);
}
