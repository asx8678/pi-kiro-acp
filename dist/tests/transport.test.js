import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ndjson, RpcProcess, inspectCli } from '../src/kiro/jsonrpc.js';
import { V3Session, parseOptions, catalogFrom } from '../src/kiro/v3.js';
import { Catalog } from '../src/tools/catalog.js';
import { config } from './helpers.js';
test('NDJSON handles UTF-8 split across every byte', () => {
    const frames = [];
    const p = new Ndjson(10000, x => frames.push(x));
    const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'hello', params: 'Zażółć 🐐' }) + '\n');
    for (const byte of b)
        p.push(Buffer.from([byte]));
    p.end();
    assert.equal(frames[0].params, 'Zażółć 🐐');
});
test('malformed, unterminated and oversized frames fail closed', () => {
    assert.throws(() => new Ndjson(1000, () => { }).push(Buffer.from('plain text\n')), /Malformed/);
    const p = new Ndjson(1000, () => { });
    p.push(Buffer.from('{'));
    assert.throws(() => p.end(), /Truncated/);
    assert.throws(() => new Ndjson(10, () => { }).push(Buffer.from('x'.repeat(11))), /limit/);
});
test('invalid UTF-8 is rejected', () => assert.throws(() => new Ndjson(100, () => { }).push(Buffer.from([0xff, 10]))));
test('numeric zero RPC ID remains valid', () => {
    let seen = false;
    new Ndjson(100, x => { seen = x.id === 0; }).push(Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'));
    assert.ok(seen);
});
test('unqualified CLI versions require explicit opt-in', async () => {
    const c = config();
    c.compatibility.allowUnverified = false;
    try {
        await assert.rejects(inspectCli(c), /Unqualified CLI/);
    }
    finally {
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('RPC request IDs correlate and errors do not become assistant prose', async () => {
    const c = config(), rpc = new RpcProcess(c, c.stateDir);
    rpc.start();
    try {
        const responses = await Promise.all([rpc.request('initialize', {}), rpc.request('initialize', {})]);
        assert.equal(responses.length, 2);
        await assert.rejects(rpc.request('not-a-method', {}), /Unsupported fixture method/);
    }
    finally {
        await rpc.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('v3 model selection is exact and Opus to Auto is not a no-op', async () => {
    const c = config(), s = new V3Session(c, c.stateDir, new Catalog([]));
    try {
        await s.start('Test', undefined);
        await s.verifyTools();
        await s.select('test-opus', 'high');
        assert.equal(s.selected().model, 'test-opus');
        assert.equal(s.selected().effort, 'high');
        await s.select('auto');
        assert.equal(s.selected().model, 'auto');
        await assert.rejects(s.select('invented-opus-5.5'), /did not advertise/);
        await assert.rejects(s.select('auto', 'max'), /does not advertise/);
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('v3 sends the configured client identity and supported capabilities over ACP', async () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    for (const name of ['kirocrew', 'pi-fabric', 'pi']) {
        const c = config(), capture = path.join(c.stateDir, 'initialize.json');
        if (name !== 'kirocrew')
            c.client.name = name;
        c.cli.prefixArgs.push('--capture-initialize', capture);
        const s = new V3Session(c, c.stateDir, new Catalog([]));
        try {
            await s.start('Identity probe; no inference.', undefined);
            await s.verifyTools();
            assert.equal(s.selected().mode, 'kirocrew');
            const frame = JSON.parse(fs.readFileSync(capture, 'utf8'));
            assert.deepEqual(frame.params, {
                protocolVersion: 1,
                clientInfo: { name, version: name === 'kirocrew' ? '0.1.2' : manifest.version },
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            });
            assert.deepEqual(frame.args.slice(-5), ['acp', '--agent-engine', 'v3', '--auth-method', 'cli']);
        }
        finally {
            await s.close();
            fs.rmSync(c.stateDir, { recursive: true, force: true });
        }
    }
});
test('Crew wire versions stay pinned while Pi overrides use the local package version', async () => {
    const c = config(), root = path.join(c.stateDir, 'package');
    const module = path.join(root, 'dist', 'src', 'kiro', 'identity.js');
    try {
        fs.mkdirSync(path.dirname(module), { recursive: true });
        fs.copyFileSync(new URL('../src/kiro/identity.js', import.meta.url), module);
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-kiro-acp', type: 'module', version: '9.8.7-test' }));
        const identity = await import(pathToFileURL(module).href);
        assert.equal(identity.PACKAGE_VERSION, '9.8.7-test');
        assert.deepEqual(identity.clientInfo('kirocrew'), { name: 'kirocrew', version: '0.1.2' });
        assert.deepEqual(identity.clientInfo('pi-fabric'), { name: 'pi-fabric', version: '9.8.7-test' });
        assert.deepEqual(identity.clientInfo('pi'), { name: 'pi', version: '9.8.7-test' });
        assert.equal(identity.BRIDGE_MODE, 'kirocrew');
        assert.deepEqual(identity.SERVER_INFO, { name: 'kirocrew-core', version: '1.0.0' });
    }
    finally {
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('grouped model options are flattened without inventing IDs', () => {
    const raw = { configOptions: [{ id: 'm', category: 'model', currentValue: 'a', options: [{ name: 'group', options: [{ value: 'a', name: 'A' }] }] }] };
    assert.equal(parseOptions(raw)[0].values[0].value, 'a');
    assert.deepEqual(catalogFrom(raw), [{ id: 'a', name: 'A' }]);
});
test('inventory reports for other sessions and unscoped reports are ignored', async () => {
    const c = config();
    c.cli.prefixArgs.push('--tags-inventory');
    const s = new V3Session(c, c.stateDir, new Catalog([]));
    try {
        await s.start('Tool-less test', undefined);
        s.rpc.onNotification('_kiro/tools/didChange', { sessionId: 'other-session', tags: [{ tag: 'shell', source: 'builtin' }] });
        s.rpc.onNotification('_kiro/tools/didChange', { tags: [{ tag: 'shell', source: 'builtin' }] });
        await s.verifyTools();
        assert.equal(s.toolAudit, 'reported-tags-and-catalog');
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('a closed ACP transport cannot start a new subprocess', async () => {
    const c = config(), p = new RpcProcess(c, c.stateDir);
    try {
        await p.close();
        assert.throws(() => p.start(), /already closed/);
    }
    finally {
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=transport.test.js.map