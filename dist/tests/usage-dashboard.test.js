import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate as tick } from 'node:timers/promises';
import { Journal } from '../src/storage/journal.js';
import { CreditLedger } from '../src/storage/credits.js';
import { openUsageDashboard } from '../src/ui/usage-dashboard.js';
import { config } from './helpers.js';
const day = '2026-09-24', earlier = '2026-09-23';
function fixture(retain = false) {
    const c = config(), journal = new Journal(c.stateDir), scope = 'dashboard';
    const ledger = new CreditLedger(journal, scope, c.budget, 'UTC', retain);
    const terminal = { rows: 32 }, panels = [];
    let panel, input, widthCalls = 0, closed = 0;
    const truncate = (text, width, suffix = '') => text.length <= width ? text : text.slice(0, Math.max(0, width - suffix.length)) + suffix.slice(0, width);
    class Input {
        options;
        focused = false;
        value = '';
        onSubmit;
        onEscape;
        constructor(options = {}) {
            this.options = options;
            input = this;
        }
        setValue(value) { this.value = value; }
        handleInput(value) { if (value === 'return')
            this.onSubmit?.(this.value);
        else if (value === 'escape')
            this.onEscape?.();
        else
            this.value += value; }
        render(width) { return [truncate((this.options.prompt ?? '') + this.value, width)]; }
        invalidate() { }
    }
    const ui = { Input, matchesKey: (data, key) => data === key, truncateToWidth: truncate,
        visibleWidth: text => { widthCalls++; return text.length; }, stripTerminalSequences: text => text };
    const host = { cwd: c.stateDir, mode: 'tui', ui: { notify() { }, custom: async (factory) => {
                panel = factory({ terminal, requestRender() { } }, { fg: (_color, text) => text, bold: text => text }, undefined, () => { closed++; panel.dispose?.(); });
                panels.push(panel);
                return undefined;
            } } };
    const offline = () => ledger.accountUsage() ?? { checkedAt: Date.now(), status: 'unavailable', planName: 'Offline', bonuses: [], addOns: [] };
    return {
        c, journal, ledger, scope, terminal,
        get panel() { return panel; }, get closed() { return closed; }, get widthCalls() { return widthCalls; },
        resetWidthCalls() { widthCalls = 0; },
        async open(selected = day, cacheMs = 300000, refresh = async () => offline()) {
            await openUsageDashboard(selected, host, ledger, refresh, ui, cacheMs);
            await tick();
        },
        add(id, session, date = day, options = {}) {
            const task = options.task ?? ledger.ensureTask({ sessionId: session, sessionName: options.name ?? 'Private session', summary: options.summary ?? 'Private task' });
            ledger.start(id, 'auto', Date.parse(date + 'T10:00:00Z'), task);
            if (options.credits !== null)
                ledger.record({ promptId: id, total: options.credits ?? 0.25, delta: 0, reports: 1, source: 'turn_completion' });
            ledger.recordTokens({ promptId: id, source: 'turn_completion', counts: { inputTokens: options.tokens ?? 123 } });
            ledger.finish(id);
            return task;
        },
        legacy(id, session, tokens = 987) {
            journal.db.prepare('INSERT INTO credit_prompts(scope,id,model,started_at,updated_at,owner_instance,finished,credits) VALUES (?,?,?,?,?,?,1,0.25)')
                .run(scope, id, 'auto', Date.parse(day + 'T10:00:00Z'), Date.now(), session);
            ledger.recordTokens({ promptId: id, source: 'turn_completion', counts: { inputTokens: tokens } });
        },
        key(key) { panel.handleInput(key); },
        search(query) { panel.handleInput('/'); input.setValue(query); panel.handleInput('return'); },
        text(width = 100) { return panel.render(width).join('\n'); },
        selected(width = 100) { return panel.render(width).find(line => line.startsWith('│ › ')); },
        rows(width = 100) { return panel.render(width).filter(line => /^│ [› ] \d\d:\d\d/.test(line)); },
        async reload() { panel.handleInput('r'); await tick(); },
        close() { for (const view of panels)
            view.dispose?.(); ledger.close(); journal.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); },
    };
}
test('dashboard derives settled task status while preserving explicit outcomes', async () => {
    const f = fixture();
    try {
        const task = f.add('p', 'session');
        f.ledger.endTask(task);
        assert.equal(f.ledger.sessionTasks(day, 'session')[0].outcome, 'settled');
        await f.open();
        f.key('return');
        assert.match(f.text(), /Settled · 1 request/);
        assert.doesNotMatch(f.text(), /Unfinished/);
        f.journal.db.prepare('UPDATE credit_tasks SET outcome=? WHERE id=?').run('failed', task);
        await f.reload();
        assert.match(f.text(), /Failed · 1 request/);
    }
    finally {
        f.close();
    }
});
test('legacy prompt drill-down retains its token report and settled status', async () => {
    const f = fixture();
    try {
        f.legacy('legacy', 'old-session');
        assert.equal(f.ledger.dashboard(day).sessions[0].tasks, 1);
        assert.equal(f.ledger.sessionTasks(day, 'old-session')[0].kind, 'prompt');
        await f.open();
        assert.match(f.text(), /987 in/);
        f.key('return');
        assert.match(f.text(), /Request tokens \(2026-09-24\):.*987 in/);
        assert.match(f.text(), /Settled · 1 request/);
        assert.doesNotMatch(f.text(), /no recorded requests/);
    }
    finally {
        f.close();
    }
});
test('task and orphan-prompt identities cannot collapse when their raw IDs collide', () => {
    const f = fixture();
    try {
        const task = f.add('normal', 'same-session', day, { tokens: 111 });
        f.legacy(task, 'same-session', 987);
        const rows = f.ledger.sessionTasks(day, 'same-session');
        assert.equal(rows.length, 2);
        assert.deepEqual(new Set(rows.map(row => row.kind)), new Set(['task', 'prompt']));
        assert.equal(f.ledger.dashboard(day).sessions[0].tasks, 2);
        assert.equal(f.ledger.taskTokens(task, day).fields.inputTokens?.tokens, 111);
        assert.equal(f.ledger.promptTokens(task, day).fields.inputTokens?.tokens, 987);
    }
    finally {
        f.close();
    }
});
test('dashboard tokens match selected-day credits without changing all-days accounting APIs', async () => {
    const f = fixture();
    try {
        const task = f.add('old', 'session', earlier, { tokens: 111 });
        f.add('new', 'session', day, { task, tokens: 222 });
        assert.equal(f.ledger.taskTokens(task).fields.inputTokens?.tokens, 333);
        assert.equal(f.ledger.sessionTokens('session').fields.inputTokens?.tokens, 333);
        assert.equal(f.ledger.sessionTokens('session', day).fields.inputTokens?.tokens, 222);
        assert.equal(f.ledger.taskTokens(task, earlier).fields.inputTokens?.tokens, 111);
        await f.open();
        assert.match(f.text(), /Session tokens \(2026-09-24\):.*222 in/);
        f.key('return');
        assert.match(f.text(), /Task tokens \(2026-09-24\):.*222 in/);
        assert.doesNotMatch(f.text(), /333 in/);
        f.key('t');
        assert.match(f.text(), /Scope: 2026-09-24 · UTC/);
    }
    finally {
        f.close();
    }
});
test('default session and task labels have distinct stable IDs without private excerpts', async () => {
    const f = fixture();
    try {
        const a = f.add('a', 'session-alpha');
        f.add('b', 'session-beta');
        await f.open();
        const rows = f.rows();
        assert.equal(rows.length, 2);
        const ids = rows.map(row => row.match(/([a-f0-9]{8}) · Session/)[1]);
        assert.notEqual(ids[0], ids[1]);
        assert.doesNotMatch(f.text(), /Private session|Private task|session-alpha|session-beta/);
        const selected = f.selected();
        await f.reload();
        assert.equal(f.selected(), selected);
        f.key('return');
        assert.match(f.text(), /[a-f0-9]{8} · Task/);
        assert.ok(!f.text().includes(a));
    }
    finally {
        f.close();
    }
});
test('compact balance freshness respects the configured cache age and failed refreshes', async () => {
    const f = fixture();
    f.terminal.rows = 20;
    try {
        const account = { status: 'available', planName: 'Synthetic', checkedAt: Date.now() - 86400000,
            allowance: { name: 'Credits', total: 100, used: 10, remaining: 90 }, bonuses: [], addOns: [] };
        f.ledger.saveAccountUsage(account);
        await f.open('2026-09', 2 * 86400000);
        assert.match(f.text(80), /90 \/ 100 credits left/);
        assert.match(f.text(80), /Updated 1d ago/);
        assert.doesNotMatch(f.text(80), /STALE/);
        f.ledger.saveAccountUsage({ ...account, checkedAt: Date.now() - 3 * 86400000 });
        await f.reload();
        assert.match(f.text(80), /STALE · Updated 3d ago/);
        f.ledger.saveAccountUsage({ ...account, checkedAt: Date.now(), lastError: 'Offline failure' });
        await f.reload();
        assert.match(f.text(80), /STALE · Updated just now/);
        f.ledger.saveAccountUsage({ ...account, checkedAt: Date.now() });
        await f.reload();
        assert.doesNotMatch(f.text(80), /STALE|refresh failed/);
    }
    finally {
        f.close();
    }
});
test('refresh preserves selected date and session identities when earlier rows arrive', async () => {
    const f = fixture();
    try {
        f.add('current', 'current');
        await f.open('2026-09');
        const before = f.selected();
        f.add('earlier', 'earlier', earlier);
        await f.reload();
        assert.equal(f.selected(), before);
        f.key('return');
        const session = f.selected();
        f.add('late-session', 'new');
        f.journal.db.prepare('UPDATE credit_prompts SET started_at=started_at-1000 WHERE id=?').run('late-session');
        await f.reload();
        assert.equal(f.selected(), session);
        f.key('return');
        f.key('escape');
        assert.equal(f.selected(), session);
        f.key('escape');
        assert.match(f.selected(), /Thu 24 Sept/);
        assert.match(f.selected(), /2\s+0\.5/);
    }
    finally {
        f.close();
    }
});
test('search, clear, sort and drill-down use the displayed row rather than its old index', async () => {
    const f = fixture(true);
    try {
        f.add('low', 'low', day, { credits: 0.1, name: 'Low', summary: 'Low task' });
        f.add('high', 'high', day, { credits: 4, name: 'Needle', summary: 'Target task' });
        f.add('unknown', 'unknown', day, { credits: null, name: 'Unknown' });
        await f.open();
        f.search('needle');
        assert.equal(f.rows().length, 1);
        assert.match(f.selected(), /Needle/);
        f.key('return');
        assert.match(f.rows()[0], /Target task/);
        f.key('escape');
        assert.match(f.text(), /Find: needle/);
        assert.match(f.selected(), /Needle/);
        f.key('c');
        assert.equal(f.rows().length, 3);
        f.key('s');
        f.key('s');
        assert.match(f.rows()[0], /Needle/);
        assert.match(f.rows().at(-1), /Unknown/);
        f.key('s');
        assert.match(f.rows()[0], /Low/);
        assert.match(f.rows().at(-1), /Unknown/);
        f.search('not-present');
        assert.match(f.text(), /No matches/);
        f.key('down');
        f.key('return');
        f.key('c');
        assert.ok(f.selected());
        f.key('s');
        assert.match(f.text(), /s date ↑/);
    }
    finally {
        f.close();
    }
});
test('sorting dates changes order, keeps selected identity, and searches ISO dates', async () => {
    const f = fixture();
    try {
        f.add('a', 'a', earlier);
        f.add('b', 'b');
        await f.open('2026-09');
        const selected = f.selected();
        f.key('s');
        assert.equal(f.selected(), selected);
        const rows = f.panel.render(100).filter(line => /^│ [› ] (Wed|Thu)/.test(line));
        assert.match(rows[0], /24 Sept/);
        f.search(earlier);
        assert.match(f.selected(), /23 Sept/);
        f.key('return');
        assert.match(f.text(), /23 Sept/);
        f.search(earlier);
        assert.equal(f.rows().length, 1, 'date search also matches the current day in drill-down views');
        f.key('escape');
        assert.match(f.text(), /Find: 2026-09-23/);
    }
    finally {
        f.close();
    }
});
test('expanded token details expose every field and coverage through a scrollable viewport', async () => {
    const f = fixture();
    f.terminal.rows = 20;
    try {
        const task = f.add('one', 'session');
        f.add('two', 'session', day, { task });
        f.ledger.recordTokens({ promptId: 'one', source: 'turn_completion', counts: {
                totalTokens: 1234567, inputTokens: 1234567, outputTokens: 1234567, uncachedInputTokens: 1234567,
                cacheReadInputTokens: 1234567, cacheWriteInputTokens: 1234567, thoughtTokens: 1234567,
            } });
        await f.open();
        f.key('return');
        const row = f.selected(40);
        f.key('t');
        const seen = [];
        for (let i = 0; i < 40; i++) {
            const lines = f.panel.render(40);
            assert.ok(lines.length <= 18);
            seen.push(...lines.slice(5, -4));
            f.key('down');
        }
        const text = seen.join('\n');
        for (const field of ['total', 'out', 'uncached in', 'cache read', 'cache write', 'thinking', 'partial 1/2'])
            assert.ok(text.includes(field), field);
        assert.ok(text.includes('do not add'));
        assert.ok(!text.includes('…'));
        f.panel.invalidate();
        f.panel.render(80);
        f.key('escape');
        assert.equal(f.selected(40), row);
        f.key('return');
        assert.match(f.text(), /TOKEN DETAILS/);
        f.key('q');
        assert.equal(f.closed, 1);
    }
    finally {
        f.close();
    }
});
test('dashboard rendering stays bounded across small widths, heights, search, refresh and errors', async () => {
    const f = fixture();
    try {
        f.add('a', 'session');
        f.ledger.saveAccountUsage({ checkedAt: 1, status: 'available', planName: 'Synthetic', allowance: { name: 'Credits', total: 100, remaining: 10, used: 90 },
            bonuses: [{ name: 'Bonus', total: 2, used: 1, remaining: 1 }], addOns: [], lastError: 'Unavailable' });
        await f.open('2026-09');
        f.search('2026');
        f.key('r');
        for (const height of [12, 16, 18, 20, 24, 40])
            for (const width of [0, 1, 3, 35, 36, 40, 60, 80, 120]) {
                f.terminal.rows = height;
                const lines = f.panel.render(width);
                assert.ok(lines.every(line => line.length <= width), `${width}x${height}: width overflow`);
                assert.ok(lines.length <= Math.max(1, height - 2), `${width}x${height}: height overflow (${lines.length})`);
            }
        f.terminal.rows = 20;
        f.key('d');
        assert.match(f.text(80), /Date:/);
        f.key('escape');
    }
    finally {
        f.close();
    }
});
test('token detail refresh keeps identity, updates corrections, and closes if that row disappears', async () => {
    const f = fixture();
    try {
        f.add('a', 'a');
        f.add('b', 'b');
        await f.open();
        f.key('t');
        f.ledger.recordTokens({ promptId: 'a', source: 'turn_completion', counts: { inputTokens: 999 } });
        await f.reload();
        assert.match(f.text(), /TOKEN DETAILS/);
        assert.match(f.text(), /999 in/);
        f.journal.db.prepare('DELETE FROM credit_prompts WHERE id=?').run('a');
        await f.reload();
        assert.doesNotMatch(f.text(), /TOKEN DETAILS|999 in/);
        assert.equal(f.rows().length, 1);
        assert.ok(f.selected());
    }
    finally {
        f.close();
    }
});
test('failed token reads never leave another selection\'s counts on screen', async () => {
    const f = fixture(true);
    const original = f.ledger.sessionTokens.bind(f.ledger);
    try {
        f.add('a', 'a', day, { name: 'Alpha', tokens: 111 });
        f.add('b', 'b', day, { name: 'Beta', tokens: 222 });
        await f.open();
        assert.match(f.text(), /111 in/);
        f.ledger.sessionTokens = () => { throw new Error('Synthetic read failure'); };
        assert.doesNotThrow(() => f.search('Beta'));
        assert.match(f.text(), /Token data unavailable/);
        assert.doesNotMatch(f.text(), /111 in|222 in/);
        f.ledger.sessionTokens = original;
        await f.reload();
        assert.match(f.text(), /222 in/);
    }
    finally {
        f.ledger.sessionTokens = original;
        f.close();
    }
});
test('dashboard refresh errors recover and late refresh settlement does not touch disposed storage', async () => {
    const f = fixture();
    let mode = 'ok', release;
    const gate = new Promise(resolve => { release = resolve; });
    const account = { checkedAt: Date.now(), status: 'unavailable', planName: 'Offline', bonuses: [], addOns: [] };
    try {
        await f.open('2026-09', 300000, async () => { if (mode === 'pending')
            await gate; if (mode === 'fail')
            throw new Error('Synthetic refresh failure'); return account; });
        mode = 'fail';
        await f.reload();
        assert.match(f.text(), /Synthetic refresh failure/);
        mode = 'ok';
        await f.reload();
        assert.doesNotMatch(f.text(), /Synthetic refresh failure/);
        mode = 'pending';
        f.key('r');
        assert.match(f.text(), /Refreshing account/);
        f.panel.dispose?.();
        let reads = 0;
        const prepare = f.journal.db.prepare.bind(f.journal.db);
        f.journal.db.prepare = sql => { reads++; return prepare(sql); };
        release();
        await tick();
        assert.equal(reads, 0);
    }
    finally {
        release();
        f.close();
    }
});
test('large-list rendering measures only visible cells and performs no SQL, including resize', async () => {
    const f = fixture();
    try {
        f.journal.transaction(() => {
            const tasks = f.journal.db.prepare('INSERT INTO credit_tasks(scope,id,session_id,session_name,summary,started_at) VALUES (?,?,?,?,?,?)');
            const prompts = f.journal.db.prepare('INSERT INTO credit_prompts(scope,id,model,started_at,updated_at,owner_instance,finished,credits,task_id) VALUES (?,?,?,?,?,?,1,0.1,?)');
            for (let i = 0; i < 1000; i++) {
                tasks.run(f.scope, 't' + i, 's' + i, 'Session ' + i, 'Provider request', Date.parse(day + 'T10:00Z'));
                prompts.run(f.scope, 'p' + i, 'auto', Date.parse(day + 'T10:00Z'), Date.now(), f.journal.instance, 't' + i);
            }
        });
        await f.open();
        f.resetWidthCalls();
        let queries = 0;
        const prepare = f.journal.db.prepare.bind(f.journal.db);
        f.journal.db.prepare = sql => { queries++; return prepare(sql); };
        f.panel.render(100);
        assert.ok(f.widthCalls < 200, `Measured ${f.widthCalls} cells for one viewport`);
        f.panel.invalidate();
        f.panel.render(80);
        f.panel.render(120);
        assert.equal(queries, 0);
    }
    finally {
        f.close();
    }
});
//# sourceMappingURL=usage-dashboard.test.js.map