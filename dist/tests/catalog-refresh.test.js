import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installExtension } from '../src/index.js';
import { LocalStream } from '../src/provider/stream.js';
import { fallbackExtractors } from '../src/context/snapshot.js';
import { writePrivateJson } from '../src/config.js';
import { config, cleanup } from './helpers.js';
function refreshContext(changes = {}) {
    return {
        signal: new AbortController().signal,
        allowNetwork: true,
        publish: async ({ update }) => { update(); return true; },
        ...changes,
    };
}
async function fixture(t) {
    const c = config(), file = c.stateDir + '/config.json', old = process.env.PI_KIRO_ACP_CONFIG;
    writePrivateJson(file, c);
    let provider;
    let command;
    const pi = {
        registerProvider: value => { provider = value; },
        registerCommand: (name, value) => { if (name === 'kiro')
            command = value; },
        on: () => { },
    };
    process.env.PI_KIRO_ACP_CONFIG = file;
    try {
        const runtime = await installExtension(pi, {
            createAssistantMessageEventStream: () => new LocalStream(),
            getCurrentSystemPrompt: fallbackExtractors.system,
            getCurrentTools: fallbackExtractors.tools,
        });
        t.after(() => cleanup(runtime, c));
        const errors = [];
        const host = { cwd: c.stateDir, ui: { notify: (message, type) => { if (type === 'error')
                    errors.push(message); } } };
        return { runtime, provider, command, host, errors };
    }
    finally {
        if (old === undefined)
            delete process.env.PI_KIRO_ACP_CONFIG;
        else
            process.env.PI_KIRO_ACP_CONFIG = old;
    }
}
test('picker requests share one catalog load across cancellation and rejected publication', async (t) => {
    const { runtime, provider } = await fixture(t);
    const discover = t.mock.method(runtime, 'discover');
    await provider.refreshModels(refreshContext({ allowNetwork: false }));
    await provider.refreshModels(refreshContext({ signal: AbortSignal.abort() }));
    assert.equal(discover.mock.callCount(), 0);
    const controller = new AbortController();
    const first = provider.refreshModels(refreshContext({ signal: controller.signal }));
    const second = provider.refreshModels(refreshContext({ publish: async () => false }));
    controller.abort();
    await assert.rejects(first, { code: 'CANCELLED' });
    await second;
    assert.equal(discover.mock.callCount(), 1);
    assert.deepEqual(provider.getModels(), []);
    await provider.refreshModels(refreshContext());
    assert.ok(provider.getModels().some(model => model.id === 'test-opus' && model.reasoning));
    await Promise.all([provider.refreshModels(refreshContext()), provider.refreshModels(refreshContext())]);
    assert.equal(discover.mock.callCount(), 1);
});
test('manual catalog commands share startup work and explicitly refresh completed loads', async (t) => {
    const { runtime, provider, command, host, errors } = await fixture(t);
    const discover = t.mock.method(runtime, 'discover');
    await Promise.all([provider.refreshModels(refreshContext()), command.handler('models', host)]);
    assert.equal(discover.mock.callCount(), 1);
    await command.handler('doctor', host);
    await provider.refreshModels(refreshContext());
    assert.equal(discover.mock.callCount(), 2);
    await command.handler('models', host);
    await provider.refreshModels(refreshContext());
    assert.equal(discover.mock.callCount(), 3);
    assert.deepEqual(errors, []);
});
test('a failed startup catalog load waits for an explicit retry', async (t) => {
    const { runtime, provider, command, host, errors } = await fixture(t);
    const original = runtime.discover.bind(runtime);
    let attempts = 0;
    t.mock.method(runtime, 'discover', async () => {
        if (++attempts === 1)
            throw new Error('Kiro temporarily unavailable');
        return original();
    });
    await assert.rejects(provider.refreshModels(refreshContext()), /Kiro temporarily unavailable/);
    await assert.rejects(provider.refreshModels(refreshContext()), /Kiro temporarily unavailable/);
    assert.equal(attempts, 1);
    await command.handler('models', host);
    await provider.refreshModels(refreshContext());
    assert.equal(attempts, 2);
    assert.ok(provider.getModels().length > 0);
    assert.deepEqual(errors, []);
});
//# sourceMappingURL=catalog-refresh.test.js.map