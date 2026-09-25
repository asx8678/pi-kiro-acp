import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setImmediate as tick } from 'node:timers/promises';
import { Journal } from '../src/storage/journal.js';
import { CreditLedger } from '../src/storage/credits.js';
import { monthDayRanges, localDay } from '../src/diagnostics/calendar.js';
import { openUsageDashboard } from '../src/ui/usage-dashboard.js';
import { config } from './helpers.js';
function fixture(timeZone = 'UTC') {
    const c = config(), journal = new Journal(c.stateDir), scope = 'usage-review';
    const ledger = new CreditLedger(journal, scope, c.budget, timeZone);
    const task = ledger.beginTask({ sessionId: 'session', summary: 'Synthetic task' });
    ledger.start('prompt', 'auto', Date.now(), task);
    return { c, journal, ledger, scope, task, close() { ledger.close(); journal.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); } };
}
const credit = (total) => ({ promptId: 'prompt', total, delta: total, reports: 1, source: 'turn_completion' });
test('cached accounting observes own and other-connection corrections immediately', () => {
    const f = fixture(), other = new Journal(f.c.stateDir), worker = new CreditLedger(other, f.scope, f.c.budget, 'UTC');
    try {
        f.ledger.record(credit(0.5));
        assert.equal(f.ledger.snapshot().reportedCredits, 0.5);
        worker.record(credit(0.25));
        assert.equal(f.ledger.snapshot().reportedCredits, 0.25);
        f.ledger.record(credit(0));
        assert.equal(f.ledger.snapshot().reportedCredits, 0);
        worker.recordTokens({ promptId: 'prompt', source: 'turn_completion', counts: { inputTokens: 123 } });
        assert.equal(f.ledger.sessionTokens('session').fields.inputTokens?.tokens, 123);
        worker.recordTokens({ promptId: 'prompt', source: 'turn_completion', counts: { inputTokens: 99 } });
        assert.equal(f.ledger.sessionTokens('session').fields.inputTokens?.tokens, 99);
    }
    finally {
        worker.close();
        other.close();
        f.close();
    }
});
test('cached view models cannot be poisoned by mutation or rolled-back writes', () => {
    const f = fixture();
    try {
        f.ledger.record(credit(0.5));
        const view = f.ledger.snapshot();
        view.reportedCredits = 0;
        assert.equal(f.ledger.snapshot().reportedCredits, 0.5);
        assert.throws(() => f.journal.transaction(() => {
            f.journal.db.prepare('UPDATE credit_prompts SET credits=99 WHERE scope=?').run(f.scope);
            assert.equal(f.ledger.snapshot().reportedCredits, 99);
            throw new Error('rollback');
        }), /rollback/);
        assert.equal(f.ledger.snapshot().reportedCredits, 0.5);
    }
    finally {
        f.close();
    }
});
test('aggregate caching stays bounded and warm reads only check the data revision', () => {
    const f = fixture(), prepare = f.journal.db.prepare.bind(f.journal.db), statements = [];
    f.journal.db.prepare = sql => { statements.push(sql); return prepare(sql); };
    try {
        f.ledger.snapshot();
        f.ledger.sessionTokens('session');
        f.ledger.dashboard();
        statements.length = 0;
        f.ledger.snapshot();
        f.ledger.sessionTokens('session');
        f.ledger.dashboard();
        assert.equal(statements.length, 3);
        assert.ok(statements.every(sql => sql.includes('pragma_data_version')));
        for (let i = 0; i < 200; i++)
            f.ledger.sessionTokens('absent-' + i);
        const cache = f.ledger.cache;
        assert.ok(cache.size <= 128);
    }
    finally {
        f.close();
    }
});
test('admission budget checks never aggregate all-time history', () => {
    const f = fixture(), prepare = f.journal.db.prepare.bind(f.journal.db), statements = [];
    f.journal.db.prepare = sql => { statements.push(sql); return prepare(sql); };
    try {
        f.c.budget.dailyCredits = 0.4;
        f.ledger.record(credit(0.5));
        statements.length = 0;
        assert.throws(() => f.ledger.assertAvailable(), /budget reached/);
        assert.equal(statements.length, 1);
        assert.match(statements[0], /started_at>=\?/);
        f.ledger.record(credit(0));
        assert.doesNotThrow(() => f.ledger.assertAvailable());
    }
    finally {
        f.close();
    }
});
test('indexed session token totals retain orphan fallback without double counting', () => {
    const f = fixture(), prepare = f.journal.db.prepare.bind(f.journal.db);
    let tokenQuery = '';
    f.journal.db.prepare = sql => { if (sql.includes('COUNT(u.prompt_id)'))
        tokenQuery = sql; return prepare(sql); };
    try {
        f.ledger.recordTokens({ promptId: 'prompt', source: 'turn_completion', counts: { inputTokens: 10 } });
        f.journal.db.prepare('UPDATE credit_prompts SET owner_instance=? WHERE scope=?').run('session', f.scope);
        assert.equal(f.ledger.sessionTokens('session').prompts, 1);
        const plan = prepare('EXPLAIN QUERY PLAN ' + tokenQuery).all(f.scope, 'session', f.scope, 'session').map(row => String(row.detail)).join('\n');
        assert.match(plan, /credit_tasks_session/);
        assert.match(plan, /credit_prompts_owner/);
        f.journal.db.prepare('UPDATE credit_prompts SET task_id=NULL WHERE scope=?').run(f.scope);
        assert.equal(f.ledger.sessionTokens('session').prompts, 1);
        assert.equal(f.ledger.sessionTokens('session').fields.inputTokens?.tokens, 10);
        f.journal.db.prepare('UPDATE credit_prompts SET task_id=? WHERE scope=?').run('missing-task', f.scope);
        assert.equal(f.ledger.sessionTokens('session').prompts, 1);
    }
    finally {
        f.close();
    }
});
test('indexed monthly aggregation respects DST and skipped civil days', () => {
    for (const [month, zone, skipped] of [['2026-03', 'Europe/Paris', ''], ['2026-10', 'Europe/Paris', ''], ['2011-12', 'Pacific/Apia', '2011-12-30']]) {
        const f = fixture(zone);
        try {
            const bounds = monthDayRanges(month, zone);
            if (skipped) {
                const day = bounds.find(day => day.day === skipped);
                assert.equal(day.start, day.end);
            }
            const target = bounds.find(day => day.end > day.start);
            f.journal.db.prepare('UPDATE credit_prompts SET started_at=?,credits=0.25 WHERE scope=?').run(target.start, f.scope);
            const view = f.ledger.dashboard(month, target.start);
            assert.equal(view.days.find(day => day.day === target.day)?.credits, 0.25);
            assert.equal(view.days.reduce((n, day) => n + day.prompts, 0), 1);
            assert.equal(view.days.filter(day => day.prompts === 0).every(day => day.credits === null && day.unreported === 0), true);
            const dst = bounds.find(day => day.day === (month === '2026-03' ? '2026-03-29' : '2026-10-25'));
            if (dst)
                assert.equal((dst.end - dst.start) / 3600000, month === '2026-03' ? 23 : 25);
        }
        finally {
            f.close();
        }
    }
});
test('dashboard render and resize perform no SQL and reload refreshes selected tokens', async () => {
    const f = fixture(), prepare = f.journal.db.prepare.bind(f.journal.db);
    let queries = 0, panel;
    const ui = {
        Input: class {
            render() { return []; }
            invalidate() { }
            handleInput() { }
        },
        matchesKey: (data, key) => data === key,
        truncateToWidth: (text, width, suffix = '') => text.length <= width ? text : text.slice(0, Math.max(0, width - suffix.length)) + suffix,
        visibleWidth: text => text.length, stripTerminalSequences: text => text,
    };
    const host = { cwd: f.c.stateDir, mode: 'tui', ui: {
            notify() { }, custom: async (factory) => { panel = factory({ terminal: { rows: 40 }, requestRender() { } }, { fg: (_color, text) => text, bold: text => text }, undefined, () => { }); return undefined; },
        } };
    f.journal.db.prepare = sql => { queries++; return prepare(sql); };
    try {
        f.ledger.recordTokens({ promptId: 'prompt', source: 'turn_completion', counts: { inputTokens: 123 } });
        await openUsageDashboard(localDay(Date.now(), 'UTC'), host, f.ledger, async () => ({ checkedAt: Date.now(), status: 'unavailable', planName: 'Offline', bonuses: [], addOns: [] }), ui);
        await tick();
        panel.handleInput('return');
        let before = queries;
        assert.match(panel.render(100).join('\n'), /123/);
        panel.invalidate();
        panel.render(80);
        panel.render(120);
        assert.equal(queries, before, 'render/resize must be pure');
        f.ledger.recordTokens({ promptId: 'prompt', source: 'turn_completion', counts: { inputTokens: 999 } });
        panel.handleInput('r');
        await tick();
        before = queries;
        assert.match(panel.render(100).join('\n'), /999/);
        assert.equal(queries, before);
    }
    finally {
        panel?.dispose?.();
        f.close();
    }
});
//# sourceMappingURL=usage-performance.test.js.map