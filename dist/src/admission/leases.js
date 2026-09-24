import { BridgeError, throwIfAborted } from '../errors.js';
import { uid, sleep } from '../util.js';
export class Admission {
    journal;
    config;
    checkBudget;
    constructor(journal, config, checkBudget = () => { }) {
        this.journal = journal;
        this.config = config;
        this.checkBudget = checkBudget;
    }
    async acquire(signal) {
        throwIfAborted(signal);
        const id = uid('lease_'), db = this.journal.db, c = this.config;
        this.journal.transaction(() => {
            this.checkBudget();
            this.sweep();
            const count = db.prepare("SELECT COUNT(*) AS n FROM leases WHERE scope=? AND state='queued'").get(c.scope);
            if (count.n >= c.maxQueued)
                throw new BridgeError('LIMIT', 'Account admission queue is full.');
            db.prepare('INSERT INTO leases VALUES (?,?,?,?,?,?,?)').run(id, c.scope, process.pid, this.journal.instance, 'queued', Date.now(), Date.now());
        });
        const release = () => {
            if (!this.journal.closed)
                db.prepare('DELETE FROM leases WHERE id=? AND owner_instance=?').run(id, this.journal.instance);
        };
        try {
            const deadline = Date.now() + c.waitMs;
            while (true) {
                throwIfAborted(signal);
                const won = this.journal.transaction(() => {
                    this.checkBudget();
                    this.sweep();
                    const active = db.prepare("SELECT COUNT(*) AS n FROM leases WHERE scope=? AND state='active'").get(c.scope);
                    const first = db.prepare("SELECT id FROM leases WHERE scope=? AND state='queued' ORDER BY created_at,id LIMIT 1").get(c.scope);
                    if (active.n < c.maxActive && first?.id === id) {
                        db.prepare("UPDATE leases SET state='active',updated_at=? WHERE id=?").run(Date.now(), id);
                        return true;
                    }
                    return false;
                });
                if (won)
                    return { id, release };
                if (Date.now() > deadline)
                    throw new BridgeError('TIMEOUT', 'Timed out waiting for a Kiro continuation slot.');
                await sleep(30, signal);
            }
        }
        catch (e) {
            release();
            throw e;
        }
    }
    sweep() {
        const rows = this.journal.db.prepare('SELECT * FROM leases WHERE scope=?').all(this.config.scope);
        // Never assume an expired timestamp proves a living owner stopped generating.
        for (const row of rows)
            if (!this.journal.ownerLive(row.owner_instance, row.owner_pid))
                this.journal.db.prepare('DELETE FROM leases WHERE id=?').run(row.id);
    }
    status() { return this.journal.db.prepare('SELECT state,COUNT(*) AS count FROM leases WHERE scope=? GROUP BY state').all(this.config.scope); }
}
//# sourceMappingURL=leases.js.map