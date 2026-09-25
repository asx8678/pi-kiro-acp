import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcProcess } from '../src/kiro/jsonrpc.js';
import { V3Session } from '../src/kiro/v3.js';
import { Catalog } from '../src/tools/catalog.js';
import { ProviderRuntime } from '../src/provider/runtime.js';
import { CreditLedger } from '../src/storage/credits.js';
import { Journal } from '../src/storage/journal.js';
import { defaults, parseConfig } from '../src/config.js';
import { object } from '../src/util.js';
import { config, context, model, collect, cleanup } from './helpers.js';
const timeout = { timeout: 15000 };
async function until(ready) {
    const deadline = Date.now() + 4000;
    while (!ready()) {
        assert.ok(Date.now() < deadline, 'Fixture did not reach the expected state');
        await delay(10);
    }
}
test('cancellation escalates the process group after its leader exits', { ...timeout, skip: process.platform === 'win32' }, async () => {
    const c = config(), heartbeat = c.stateDir + '/heartbeat';
    c.cli.cancelGraceMs = 120;
    c.cli.prefixArgs = [fileURLToPath(new URL('../../fixtures/process-tree.mjs', import.meta.url)), heartbeat];
    const rpc = new RpcProcess(c, c.stateDir);
    let descendant;
    rpc.onNotification = (method, params) => {
        if (method === 'fixture/child_ready' && object(params) && typeof params.pid === 'number')
            descendant = params.pid;
    };
    try {
        rpc.start();
        await until(() => descendant !== undefined && Number(fs.readFileSync(heartbeat, 'utf8')) > 1);
        const closing = rpc.close();
        assert.equal(rpc.close(), closing, 'close must be idempotent');
        await closing;
        // Heartbeats prove actual execution, unlike signal 0 which can see orphan zombies.
        await delay(40);
        const stoppedAt = fs.readFileSync(heartbeat, 'utf8');
        await delay(100);
        assert.equal(fs.readFileSync(heartbeat, 'utf8'), stoppedAt, 'descendant continued executing after cancellation');
    }
    finally {
        if (descendant) {
            try {
                process.kill(descendant, 'SIGKILL');
            }
            catch { /* already gone */ }
        }
        await rpc.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
for (const timing of ['idle', 'pre-send'])
    test(`model drift at ${timing} is rejected before sending a prompt`, timeout, async () => {
        const c = config(), s = new V3Session(c, c.stateDir, new Catalog([]));
        let promptRequests = 0;
        const request = s.rpc.request.bind(s.rpc);
        s.rpc.request = (method, params, options) => { if (method === 'session/prompt')
            promptRequests++; return request(method, params, options); };
        const drift = async () => {
            const changed = await s.rpc.request('session/set_config_option', { sessionId: s.sessionId, configId: 'model', value: 'auto' });
            assert.ok(object(changed));
            s.rpc.onNotification('session/update', { sessionId: s.sessionId, update: { sessionUpdate: 'config_option_update', ...changed } });
        };
        try {
            await s.start('Offline model pin check', undefined);
            await s.select('test-opus');
            if (timing === 'idle')
                await drift();
            else
                s.onEvent = async (event) => { if (event.kind === 'prompt_start')
                    await drift(); };
            await assert.rejects(s.prompt('Must not infer using a different model'), { code: 'POLICY' });
            assert.equal(promptRequests, 0);
            if (timing === 'idle') {
                // An explicit operator selection remains allowed and establishes a new pin.
                await s.select('auto');
                assert.equal(await s.prompt('Explicitly selected Auto'), 'end_turn');
                assert.equal(promptRequests, 1);
            }
        }
        finally {
            await s.close();
            fs.rmSync(c.stateDir, { recursive: true, force: true });
        }
    });
test('select cannot change the model while a prompt owns the session', timeout, async () => {
    const c = config(), s = new V3Session(c, c.stateDir, new Catalog([]));
    try {
        await s.start('Offline selection ownership check', undefined);
        await s.select('test-opus');
        s.onEvent = async (event) => { if (event.kind === 'prompt_start')
            await assert.rejects(s.select('auto'), { code: 'BUSY' }); };
        assert.equal(await s.prompt('Keep the selected model'), 'end_turn');
        assert.equal(s.selected().model, 'test-opus');
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('reused runtime refuses an unsolicited idle model change instead of mislabelling Auto', timeout, async () => {
    const c = config();
    c.cli.prefixArgs.push('--idle-model-change');
    const r = new ProviderRuntime(c), ctx = context('First turn');
    try {
        const first = await collect(r.generate(model(c), ctx));
        assert.equal(first.stopReason, 'stop');
        await until(() => r.status().sessions.some(s => s.selected.model === 'auto'));
        ctx.messages.push(first, { role: 'user', content: 'Second turn' });
        const second = await collect(r.generate(model(c), ctx));
        assert.equal(second.stopReason, 'error');
        assert.match(second.errorMessage, /POLICY:.*selected model/);
        assert.deepEqual(second.content, []);
        assert.equal(r.journal.db.prepare('SELECT COUNT(*) AS n FROM credit_prompts').get()?.n, 1);
    }
    finally {
        await cleanup(r, c);
    }
});
test('excerpt retention requires an explicit boolean opt-in', () => {
    assert.equal(defaults().reporting.retainTaskExcerpts, false);
    assert.equal(parseConfig({ reporting: { accountCacheMs: 1000 } }).reporting.retainTaskExcerpts, false);
    assert.equal(parseConfig({ reporting: { retainTaskExcerpts: true } }).reporting.retainTaskExcerpts, true);
    for (const value of ['true', 1, null, {}, []])
        assert.throws(() => parseConfig({ reporting: { retainTaskExcerpts: value } }), /reporting.retainTaskExcerpts must be boolean/);
});
for (const retain of [false, true])
    test(`runtime accounting ${retain ? 'retains opted-in' : 'does not persist default'} task text`, timeout, async () => {
        const c = config();
        c.reporting.retainTaskExcerpts = retain;
        const r = new ProviderRuntime(c);
        const sentinels = ['OPENAI_API_KEY=sk-fake-prompt-secret', 'password=fake-response-secret', 'private-session-title'];
        try {
            const id = r.credits.beginTask({ sessionId: 'privacy-session', sessionName: sentinels[2], summary: sentinels[0] });
            r.credits.start('privacy-prompt', 'auto', Date.now(), id);
            r.credits.record({ promptId: 'privacy-prompt', delta: 0.25, total: 0.25, reports: 1, source: 'turn_completion' });
            r.credits.noteResult(sentinels[1], 'completed');
            r.credits.finish('privacy-prompt');
            r.credits.endTask(id);
            const stored = JSON.stringify(r.journal.db.prepare('SELECT * FROM credit_tasks WHERE id=?').get(id));
            const log = fs.readFileSync(r.credits.logFile, 'utf8');
            for (const sentinel of sentinels) {
                assert.equal(stored.includes(sentinel), retain);
                assert.equal(log.includes(sentinel), retain);
            }
            assert.equal(r.credits.snapshot().reportedCredits, 0.25, 'privacy settings must not discard accounting');
            assert.equal(r.credits.taskTokens(id).prompts, 1);
            await r.close();
            const database = fs.readFileSync(c.stateDir + '/state.sqlite');
            for (const sentinel of sentinels)
                assert.equal(database.includes(Buffer.from(sentinel)), retain);
        }
        finally {
            await cleanup(r, c);
        }
    });
test('a default writer does not copy legacy excerpts into a late accounting report', () => {
    const c = config(), journal = new Journal(c.stateDir);
    const writer = new CreditLedger(journal, c.admission.scope, c.budget, 'UTC', true);
    const safe = new CreditLedger(journal, c.admission.scope, c.budget, 'UTC');
    const marker = 'legacy-private-excerpt';
    try {
        const id = writer.beginTask({ sessionId: 'legacy-session', sessionName: marker, summary: marker });
        writer.start('late-report', 'auto', Date.now(), id);
        writer.noteResult(marker);
        writer.endTask(id);
        const offset = fs.statSync(writer.logFile).size;
        safe.record({ promptId: 'late-report', delta: 0.5, total: 0.5, reports: 1, source: 'turn_completion' });
        const appended = fs.readFileSync(writer.logFile).subarray(offset).toString('utf8');
        assert.ok(appended.length > 0);
        assert.ok(!appended.includes(marker));
        assert.equal(journal.db.prepare('SELECT summary FROM credit_tasks WHERE id=?').get(id)?.summary, marker, 'historical data is not silently deleted');
    }
    finally {
        safe.close();
        writer.close();
        journal.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=review-fixes.test.js.map