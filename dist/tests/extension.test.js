import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installExtension } from '../src/index.js';
import { LocalStream, StreamWriter } from '../src/provider/stream.js';
import { fallbackExtractors } from '../src/context/snapshot.js';
import { writePrivateJson } from '../src/config.js';
import { BridgeError } from '../src/errors.js';
import { config, model, context, collect, cleanup } from './helpers.js';
import { installationStatus } from '../src/installation.js';
test('extension registers a native Pi provider and current lifecycle hooks', async () => {
    const c = config(), file = c.stateDir + '/config.json', old = process.env.PI_KIRO_ACP_CONFIG;
    writePrivateJson(file, c);
    process.env.PI_KIRO_ACP_CONFIG = file;
    const handlers = new Map();
    let provider;
    let command;
    const pi = { registerProvider: p => { provider = p; }, registerCommand: (name, c) => { if (name === 'kiro')
            command = c; }, on: (event, handler) => { handlers.set(event, handler); } };
    const r = await installExtension(pi, { createAssistantMessageEventStream: () => new LocalStream(), getCurrentSystemPrompt: fallbackExtractors.system, getCurrentTools: fallbackExtractors.tools });
    try {
        assert.equal(installationStatus(c).initialized, true, 'loading an extension must initialize installs that skipped scripts');
        assert.equal(provider.id, 'kiro-acp');
        assert.ok(handlers.has('session_shutdown'));
        assert.ok(handlers.has('agent_settled'));
        assert.ok(handlers.has('before_provider_request'));
        const host = { cwd: process.cwd(), model: { provider: 'kiro-acp', id: 'test-opus' }, sessionManager: { getSessionId: () => 'pi-host' }, ui: { notify: () => { } } };
        await handlers.get('session_start')({}, host);
        await command.handler('models', host);
        const m = provider.getModels().find(x => x.id === 'test-opus');
        assert.ok(m);
        assert.equal(m.reasoning, true);
        const a = await collect(provider.streamSimple(m, context('plain text'), {}));
        assert.equal(a.stopReason, 'stop');
        const output = await provider.completeStructured(m, context(), { sessionId: 'pi-host' });
        assert.equal(output.stopReason, 'toolUse');
        assert.deepEqual(r.journal.unresolved(), [], 'registered structured completion must not create a host effect');
        let aborted = false;
        assert.throws(() => handlers.get('before_provider_request')({}, { ...host, model: { provider: 'other', id: 'x' }, abort: () => { aborted = true; } }), /Kiro-only/);
        assert.equal(aborted, true);
    }
    finally {
        await handlers.get('session_shutdown')({}, { cwd: process.cwd() });
        await cleanup(r, c);
        if (old === undefined)
            delete process.env.PI_KIRO_ACP_CONFIG;
        else
            process.env.PI_KIRO_ACP_CONFIG = old;
    }
});
test('widget updates coalesce and pending refreshes are cancelled on shutdown', async () => {
    const c = config(), file = c.stateDir + '/config.json', old = process.env.PI_KIRO_ACP_CONFIG;
    writePrivateJson(file, c);
    process.env.PI_KIRO_ACP_CONFIG = file;
    const handlers = new Map();
    const pi = { registerProvider() { }, registerCommand() { }, on: (event, handler) => { handlers.set(event, handler); } };
    const r = await installExtension(pi, { createAssistantMessageEventStream: () => new LocalStream(), getCurrentSystemPrompt: fallbackExtractors.system, getCurrentTools: fallbackExtractors.tools });
    let reads = 0, updates = 0;
    const snapshot = r.credits.snapshot.bind(r.credits);
    r.credits.snapshot = now => { reads++; return snapshot(now); };
    const host = { cwd: c.stateDir, model: { provider: 'kiro-acp', id: 'auto' }, ui: { notify() { }, setStatus: (_key, text) => { if (text)
                updates++; } } };
    try {
        for (let i = 0; i < 20; i++) {
            handlers.get('before_provider_request')({}, host);
            r.metrics.onCredits?.();
        }
        assert.equal(reads, 0);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(reads, 1);
        assert.equal(updates, 1);
        r.metrics.onCredits?.();
        await handlers.get('session_shutdown')({}, host);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(reads, 1);
        assert.equal(updates, 1);
    }
    finally {
        await handlers.get('session_shutdown')({}, host);
        await cleanup(r, c);
        if (old === undefined)
            delete process.env.PI_KIRO_ACP_CONFIG;
        else
            process.env.PI_KIRO_ACP_CONFIG = old;
    }
});
test('stream events are balanced and contain exactly one terminal event', async () => {
    const c = config(), s = new LocalStream(), w = new StreamWriter(s, model(c), 10000);
    w.chunk('thinking', 'Consider ');
    w.chunk('thinking', 'the input.');
    w.chunk('text', 'Answer');
    w.finish();
    w.finish();
    const events = [];
    for await (const e of s)
        events.push(e);
    assert.deepEqual(events.map(e => e.type), ['start', 'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_end', 'done']);
    fs.rmSync(c.stateDir, { recursive: true, force: true });
});
test('a bounded local event queue can still deliver its terminal error', async () => {
    const c = config(), s = new LocalStream(2), w = new StreamWriter(s, model(c), 10000);
    try {
        w.chunk('text', 'too many queued events');
    }
    catch (e) {
        w.fail(e);
    }
    const final = await s.result();
    assert.equal(final.stopReason, 'error');
    assert.match(final.errorMessage, /queue/);
    fs.rmSync(c.stateDir, { recursive: true, force: true });
});
test('setup failure can terminate before start without fabricated HTTP metadata', async () => {
    const c = config(), s = new LocalStream(), w = new StreamWriter(s, model(c), 10000);
    w.fail(new BridgeError('AUTH', 'Not signed in'));
    const events = [];
    for await (const e of s)
        events.push(e);
    assert.deepEqual(events.map(e => e.type), ['error']);
    assert.equal((await s.result()).stopReason, 'error');
    fs.rmSync(c.stateDir, { recursive: true, force: true });
});
//# sourceMappingURL=extension.test.js.map