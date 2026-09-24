import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Journal } from '../src/storage/journal.js';
import { Admission } from '../src/admission/leases.js';
import { StateMachine } from '../src/sessions/state-machine.js';
import { config } from './helpers.js';
test('journal deduplicates by request identity, not arguments', () => {
    const c = config(), j = new Journal(c.stateDir);
    try {
        const input = { binding: 'b', generation: 'g', requestId: 'r', toolName: 'write', argsHash: 'h' };
        const first = j.receive(input), second = j.receive(input), third = j.receive({ ...input, requestId: 'r2' });
        assert.equal(first.duplicate, false);
        assert.equal(second.duplicate, true);
        assert.equal(first.row.id, second.row.id);
        assert.notEqual(first.row.id, third.row.id);
        assert.throws(() => j.receive({ ...input, argsHash: 'changed' }), /different arguments/);
    }
    finally {
        j.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('exposed effects cannot be silently cancelled and replayed', () => {
    const c = config(), j = new Journal(c.stateDir);
    try {
        const { row } = j.receive({ binding: 'b', generation: 'g', requestId: 'r', toolName: 'write', argsHash: 'h' });
        j.transition(row.id, 'EXPOSED_TO_PI');
        assert.throws(() => j.transition(row.id, 'CANCELLED'), /Illegal/);
        j.transition(row.id, 'UNCERTAIN');
        assert.equal(j.unresolved().length, 1);
        j.transition(row.id, 'RESULT_RECORDED', 'result-hash');
        j.transition(row.id, 'RETURNED_TO_KIRO');
        assert.equal(j.unresolved().length, 0);
    }
    finally {
        j.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('dead owner after exposure becomes uncertain, not retried', () => {
    const c = config(), j = new Journal(c.stateDir);
    try {
        const { row } = j.receive({ binding: 'b', generation: 'g', requestId: 'r', toolName: 'write', argsHash: 'h' });
        j.transition(row.id, 'EXPOSED_TO_PI');
        j.db.prepare('UPDATE handoffs SET owner_pid=?,owner_instance=? WHERE id=?').run(2147483647, 'dead-instance', row.id);
        j.reconcileDeadOwners();
        assert.equal(j.get(row.id).phase, 'UNCERTAIN');
    }
    finally {
        j.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('journal is private and survives reopening', () => {
    const c = config();
    let j = new Journal(c.stateDir);
    const row = j.receive({ binding: 'b', generation: 'g', requestId: 'r', toolName: 'x', argsHash: 'h' }).row;
    j.close();
    j = new Journal(c.stateDir);
    assert.equal(j.get(row.id).pi_call_id, row.pi_call_id);
    j.close();
    if (process.platform !== 'win32')
        assert.equal(fs.statSync(c.stateDir + '/state.sqlite').mode & 0o777, 0o600);
    fs.rmSync(c.stateDir, { recursive: true, force: true });
});
test('account admission capacity is shared between runtime instances', async () => {
    const c = config();
    c.admission.maxActive = 1;
    const j1 = new Journal(c.stateDir), j2 = new Journal(c.stateDir), a1 = new Admission(j1, c.admission), a2 = new Admission(j2, c.admission);
    try {
        const first = await a1.acquire();
        let got = false;
        const secondPromise = a2.acquire().then(l => { got = true; return l; });
        await new Promise(r => setTimeout(r, 70));
        assert.equal(got, false);
        first.release();
        const second = await secondPromise;
        assert.equal(got, true);
        second.release();
    }
    finally {
        j1.close();
        j2.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('cancelled admission removes the queued lease', async () => {
    const c = config();
    c.admission.maxActive = 1;
    const j = new Journal(c.stateDir), a = new Admission(j, c.admission);
    try {
        const first = await a.acquire();
        const ctl = new AbortController(), second = a.acquire(ctl.signal);
        ctl.abort();
        await assert.rejects(second, /cancelled/);
        first.release();
        assert.deepEqual(a.status(), []);
    }
    finally {
        j.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('state machine refuses invalid tool boundary transitions', () => {
    const s = new StateMachine();
    assert.throws(() => s.move('GENERATING'), /Illegal/);
    s.move('STARTING');
    s.move('READY');
    s.move('GENERATING');
    s.move('WAITING_FOR_PI_TOOL');
    s.move('SYNCHRONIZING');
    s.move('GENERATING');
    s.move('READY');
    assert.equal(s.phase, 'READY');
});
//# sourceMappingURL=storage.test.js.map