import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { V3Session } from '../src/kiro/v3.js';
import { Ndjson } from '../src/kiro/jsonrpc.js';
import { Catalog } from '../src/tools/catalog.js';
import { Journal } from '../src/storage/journal.js';
import { deferred, object } from '../src/util.js';
import { config, model, context, collect, addResult, cleanup } from './helpers.js';
const timeout = { timeout: 15000 };
async function until(ready) {
    const deadline = Date.now() + 6000;
    while (!ready()) {
        assert.ok(Date.now() < deadline, 'Fixture state deadline exceeded');
        await delay(10);
    }
}
function owner(c) {
    const child = fork(new URL('../../fixtures/runtime-owner.mjs', import.meta.url), [], {
        env: { ...process.env, OWNER_CONFIG: JSON.stringify(c) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = deferred(), answer = deferred(), closed = deferred(), claimed = deferred();
    child.on('message', message => {
        if (!object(message))
            return;
        if (message.type === 'ready')
            ready.resolve();
        if (message.type === 'claimed')
            claimed.resolve();
        if (message.type === 'answer')
            answer.resolve(message.answer);
        if (message.type === 'failure') {
            ready.reject(new Error(String(message.message)));
            answer.reject(new Error(String(message.message)));
        }
    });
    child.on('error', error => { ready.reject(error); answer.reject(error); });
    child.on('exit', () => { closed.resolve(); ready.reject(new Error('Owner exited')); answer.reject(new Error('Owner exited')); claimed.reject(new Error('Owner exited')); });
    void ready.promise.catch(() => { });
    void answer.promise.catch(() => { });
    return { child, ready: ready.promise, answer: answer.promise, closed: closed.promise, claimed: claimed.promise };
}
test('binding reservation is atomic, fenced, and distinct from account admission', () => {
    const c = config(), first = new Journal(c.stateDir), second = new Journal(c.stateDir);
    try {
        const release = first.reserveBinding('conversation');
        assert.throws(() => second.reserveBinding('conversation'), { code: 'BUSY' });
        const unrelated = second.reserveBinding('other-conversation');
        unrelated();
        release();
        const next = second.reserveBinding('conversation');
        release(); // A stale/duplicate release must not delete the successor's claim.
        assert.throws(() => first.reserveBinding('conversation'), { code: 'BUSY' });
        next();
        first.reserveBinding('conversation');
        first.close();
        const afterReload = second.reserveBinding('conversation');
        afterReload();
        assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM binding_reservations').get()?.n, 0);
    }
    finally {
        first.close();
        second.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('dead process reservations can be reclaimed without expiring a live claim', () => {
    const c = config(), j = new Journal(c.stateDir);
    try {
        j.db.prepare('INSERT INTO owners VALUES (?,?,?,?)').run('dead-owner', 2147483647, 'open', 0);
        j.db.prepare('INSERT INTO binding_reservations VALUES (?,?,?,?)').run('conversation', 'dead-token', 2147483647, 'dead-owner');
        const release = j.reserveBinding('conversation');
        assert.throws(() => j.reserveBinding('conversation'), { code: 'BUSY' });
        release();
    }
    finally {
        j.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('a reservation survives a live worker but is reclaimable after an actual OS-process crash', timeout, async () => {
    const c = config(), worker = owner(c), j = new Journal(c.stateDir);
    try {
        await worker.ready;
        worker.child.send('claim');
        await worker.claimed;
        assert.throws(() => j.reserveBinding('orphaned'), { code: 'BUSY' });
        worker.child.kill('SIGKILL');
        await worker.closed;
        const release = j.reserveBinding('orphaned');
        release();
    }
    finally {
        if (worker.child.connected)
            worker.child.send('close');
        await worker.closed;
        j.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('shared conversation excludes a competing OS process before startup and tool dispatch', timeout, async () => {
    const c = config(), gate = c.stateDir + '/catalog-gate';
    c.cli.prefixArgs.push('--catalog-gate', gate);
    c.cli.rpcTimeoutMs = 10000;
    const a = owner(c);
    let b;
    try {
        await a.ready;
        a.child.send('run');
        await until(() => fs.existsSync(gate + '.ready'));
        b = owner(c);
        await b.ready;
        b.child.send('run');
        const losing = await b.answer;
        assert.match(losing.errorMessage, /BUSY/);
        assert.equal(losing.content.filter(block => block.type === 'toolCall').length, 0);
        fs.writeFileSync(gate, 'release');
        const winning = await a.answer;
        assert.equal(winning.stopReason, 'toolUse');
        assert.equal(winning.content.filter(block => block.type === 'toolCall').length, 1);
    }
    finally {
        fs.writeFileSync(gate, 'release');
        await Promise.all([a, b].filter(x => x !== undefined).map(async (x) => {
            if (x.child.connected)
                x.child.send('close');
            await x.closed;
        }));
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
for (const action of ['abort', 'idle-sweep', 'invalidate'])
    test(`startup is active during ${action}`, timeout, async () => {
        const c = config(), gate = c.stateDir + '/catalog-gate';
        c.cli.prefixArgs.push('--catalog-gate', gate);
        c.cli.rpcTimeoutMs = 10000;
        if (action === 'idle-sweep')
            c.sessions.idleTtlMs = 25;
        const r = new ProviderRuntime(c);
        try {
            const answer = collect(r.generate(model(c), context('Offline startup test')));
            await until(() => fs.existsSync(gate + '.ready'));
            if (action === 'abort') {
                await r.abortActive();
                fs.writeFileSync(gate, 'release');
                const result = await answer;
                assert.equal(result.stopReason, 'aborted', result.errorMessage);
                assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n, 0);
            }
            else {
                if (action === 'invalidate')
                    await r.invalidate();
                else
                    await delay(100);
                assert.equal(r.status().sessions[0]?.phase, 'STARTING');
                fs.writeFileSync(gate, 'release');
                assert.equal((await answer).stopReason, 'stop');
            }
        }
        finally {
            await cleanup(r, c);
        }
    });
test('shutdown closes the journal and allows safe recovery even when usage logging fails', timeout, async () => {
    const c = config(), r = new ProviderRuntime(c), ctx = context(), log = r.credits.logFile;
    let next;
    try {
        const first = await collect(r.generate(model(c), ctx, { sessionId: 'log-failure' }));
        assert.equal(first.stopReason, 'toolUse');
        fs.renameSync(log, log + '.saved');
        fs.mkdirSync(log);
        await assert.rejects(r.close(), /EISDIR|illegal operation/);
        assert.equal(r.journal.closed, true);
        fs.rmdirSync(log);
        fs.renameSync(log + '.saved', log);
        next = new ProviderRuntime(c);
        assert.equal(next.journal.ownerLive(r.journal.instance, process.pid), false);
        const refused = await collect(next.generate(model(c), ctx, { sessionId: 'log-failure' }));
        assert.match(refused.errorMessage, /UNCERTAIN/);
        addResult(ctx, first);
        assert.equal((await collect(next.generate(model(c), ctx, { sessionId: 'log-failure' }))).stopReason, 'stop');
        assert.equal(next.metrics.toolCalls, 0);
    }
    finally {
        if (fs.existsSync(log) && fs.statSync(log).isDirectory())
            fs.rmdirSync(log);
        if (fs.existsSync(log + '.saved'))
            fs.renameSync(log + '.saved', log);
        await next?.close();
        await r.close().catch(() => { });
        if (!r.journal.closed) {
            r.credits.close();
            r.journal.close();
        }
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
for (const timing of ['idle', 'pre-send', 'in-flight'])
    test(`requested effort cannot drift at ${timing}`, timeout, async () => {
        const c = config(), s = new V3Session(c, c.stateDir, new Catalog([]));
        let prompts = 0;
        const request = s.rpc.request.bind(s.rpc);
        s.rpc.request = (method, params, options) => { if (method === 'session/prompt')
            prompts++; return request(method, params, options); };
        const drift = async () => {
            const changed = await s.rpc.request('session/set_config_option', { sessionId: s.sessionId, configId: 'effortLevel', value: 'low' });
            assert.ok(object(changed));
            s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: { sessionUpdate: 'config_option_update', ...changed } });
        };
        try {
            await s.start('Offline effort pin test', undefined);
            await s.select('test-opus', 'high');
            if (timing === 'idle')
                await drift();
            if (timing === 'pre-send')
                s.onEvent = async (event) => { if (event.kind === 'prompt_start')
                    await drift(); };
            await assert.rejects(s.prompt(timing === 'in-flight' ? 'EFFORT_FALLBACK' : 'No inference with the wrong effort'), { code: 'POLICY' });
            assert.equal(prompts, timing === 'in-flight' ? 1 : 0);
            if (timing === 'idle') {
                await s.select('test-opus', 'low');
                assert.equal(s.selected().effort, 'low');
                assert.equal(await s.prompt('Explicit reselection is allowed'), 'end_turn');
            }
        }
        finally {
            await s.close();
            fs.rmSync(c.stateDir, { recursive: true, force: true });
        }
    });
for (const variant of ['renamed', 'removed'])
    test(`effort pin follows the advertised option ID when ${variant}`, timeout, async () => {
        const c = config();
        c.cli.prefixArgs.push('--renamed-effort');
        const s = new V3Session(c, c.stateDir, new Catalog([]));
        try {
            await s.start('Offline effort schema test', undefined);
            await s.select('test-opus', 'high');
            assert.equal(s.selected().effort, 'high');
            const changed = await s.rpc.request('session/set_config_option', { sessionId: s.sessionId, configId: 'reasoningDepth', value: 'low' });
            assert.ok(object(changed) && Array.isArray(changed.configOptions));
            if (variant === 'removed')
                changed.configOptions = changed.configOptions.filter(o => object(o) && o.category !== 'thought_level');
            s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: { sessionUpdate: 'config_option_update', ...changed } });
            await assert.rejects(s.prompt('Never silently lose a requested effort'), { code: 'POLICY' });
        }
        finally {
            await s.close();
            fs.rmSync(c.stateDir, { recursive: true, force: true });
        }
    });
test('unspecified effort stays automatic rather than retaining an old explicit pin', timeout, async () => {
    const c = config(), s = new V3Session(c, c.stateDir, new Catalog([]));
    try {
        await s.start('Offline automatic effort test', undefined);
        await s.select('test-opus', 'high');
        await s.select('test-opus');
        assert.equal(await s.prompt('EFFORT_FALLBACK'), 'end_turn');
        assert.equal(s.selected().effort, 'low');
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('fragmented NDJSON only measures/scans new input, not the accumulated frame', () => {
    const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: 'x'.repeat(256 * 1024) }) + '\n');
    let countedBytes = 0, scannedCharacters = 0, frames = 0;
    const byteLength = Buffer.byteLength, indexOf = String.prototype.indexOf;
    String.prototype.indexOf = function (value, position) {
        if (value === '\n')
            scannedCharacters += this.length;
        return indexOf.call(this, value, position);
    };
    Buffer.byteLength = (value, encoding) => { const bytes = byteLength(value, encoding); countedBytes += bytes; return bytes; };
    try {
        const parser = new Ndjson(frame.length, () => frames++);
        for (let offset = 0; offset < frame.length; offset += 256)
            parser.push(frame.subarray(offset, offset + 256));
        parser.end();
        assert.equal(frames, 1);
        assert.ok(countedBytes + scannedCharacters <= frame.length * 3, `Rescanned ${countedBytes} bytes and ${scannedCharacters} characters for a ${frame.length}-byte frame`);
    }
    finally {
        Buffer.byteLength = byteLength;
        String.prototype.indexOf = indexOf;
    }
});
test('NDJSON permits only the initial BOM and bounds retained buffer capacity', () => {
    const message = { jsonrpc: '2.0', method: 'event', params: 'x'.repeat(256 * 1024) };
    const frame = Buffer.from('\ufeff' + JSON.stringify(message) + '\n'), frames = [];
    const parser = new Ndjson(frame.length, value => frames.push(value));
    for (let i = 0; i < frame.length; i += 127)
        parser.push(frame.subarray(i, i + 127));
    assert.deepEqual(frames, [message]);
    assert.ok(parser.buffer.length <= 65536);
    assert.throws(() => parser.push(Buffer.from('\ufeff{"jsonrpc":"2.0","method":"bad"}\n')), /Malformed/);
});
test('NDJSON frame limits and CRLF remain correct across every byte boundary', () => {
    const line = JSON.stringify({ jsonrpc: '2.0', id: 0, result: '🦊é' }), size = Buffer.byteLength(line);
    const frames = [], lengths = [];
    const parser = new Ndjson(size, (frame, bytes) => { frames.push(frame); lengths.push(bytes); });
    const input = Buffer.from(line + '\r\n' + line + '\n');
    for (const byte of input)
        parser.push(Uint8Array.of(byte));
    parser.end();
    assert.equal(frames.length, 2);
    assert.deepEqual(lengths, [size, size]);
    assert.throws(() => new Ndjson(size - 1, () => { }).push(Buffer.from(line + '\n')), /limit/);
    assert.throws(() => new Ndjson(10, () => { }).push(Buffer.from(' '.repeat(11) + '\n')), /limit/);
    const invalid = new Ndjson(100, () => { });
    invalid.push(Uint8Array.of(0xe2));
    assert.throws(() => invalid.end(), /encoded data|encoding/i);
    assert.throws(() => new Ndjson(100, () => { }).push(Uint8Array.of(0xff)), /encoded data|encoding/i);
});
//# sourceMappingURL=deep-fixes.test.js.map