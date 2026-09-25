import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateDir } from '../config.js';
import { BridgeError } from '../errors.js';
import { alive, uid } from '../util.js';
const allowed = {
    RECEIVED: ['EXPOSED_TO_PI', 'CANCELLED'], EXPOSED_TO_PI: ['RESULT_RECORDED', 'UNCERTAIN'],
    RESULT_RECORDED: ['RETURNED_TO_KIRO', 'CANCELLED'], RETURNED_TO_KIRO: [], CANCELLED: [], UNCERTAIN: ['RESULT_RECORDED', 'CANCELLED'],
};
export class Journal {
    dir;
    db;
    instance = uid();
    closed = false;
    transactionActive = false;
    get inTransaction() { return this.transactionActive; }
    constructor(dir) {
        this.dir = dir;
        privateDir(dir);
        const file = path.join(dir, 'state.sqlite');
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
            throw new BridgeError('STORAGE', 'Refusing a symlinked database.');
        this.db = new DatabaseSync(file);
        fs.chmodSync(file, 0o600);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS owners (instance TEXT PRIMARY KEY,pid INTEGER NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,binding TEXT NOT NULL,generation TEXT NOT NULL,request_id TEXT NOT NULL,
        pi_call_id TEXT UNIQUE NOT NULL,tool_name TEXT NOT NULL,args_hash TEXT NOT NULL,phase TEXT NOT NULL,
        result_hash TEXT,owner_pid INTEGER NOT NULL,owner_instance TEXT NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(binding,generation,request_id));
      CREATE INDEX IF NOT EXISTS handoffs_binding ON handoffs(binding,phase);
      -- A side table leaves old writers' positional handoff inserts compatible.
      -- Missing markers are opaque legacy identities, never assumed unrelated.
      CREATE TABLE IF NOT EXISTS stable_handoffs (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,scope TEXT NOT NULL,owner_pid INTEGER NOT NULL,owner_instance TEXT NOT NULL,
        state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS leases_scope ON leases(scope,state);
      CREATE TABLE IF NOT EXISTS binding_reservations (
        binding TEXT PRIMARY KEY,token TEXT NOT NULL,owner_pid INTEGER NOT NULL,owner_instance TEXT NOT NULL);

    `);
        this.db.prepare('INSERT INTO owners VALUES (?,?,?,?)').run(this.instance, process.pid, 'open', Date.now());
        const version = this.db.prepare('SELECT version FROM schema_version').get();
        if (version.version !== 1) {
            this.db.close();
            throw new BridgeError('STORAGE', 'Unsupported journal schema.');
        }
    }
    transaction(fn) {
        if (this.closed)
            throw new BridgeError('STORAGE', 'Journal is closed.');
        this.db.exec('BEGIN IMMEDIATE');
        this.transactionActive = true;
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        finally {
            this.transactionActive = false;
        }
    }
    /** Fence a provider turn across processes before recovery or any asynchronous startup.
     * No expiry: a slow live owner must never lose exclusivity. At a tool boundary the
     * durable handoff protects the conversation after this short-lived claim releases.
     */
    reserveBinding(binding) {
        const token = uid();
        this.transaction(() => {
            const owner = this.db.prepare('SELECT owner_pid,owner_instance FROM binding_reservations WHERE binding=?').get(binding);
            if (owner && this.ownerLive(owner.owner_instance, owner.owner_pid))
                throw new BridgeError('BUSY', 'Another live provider request owns this Pi conversation.');
            this.db.prepare('INSERT OR REPLACE INTO binding_reservations VALUES (?,?,?,?)')
                .run(binding, token, process.pid, this.instance);
        });
        return () => {
            if (!this.closed)
                this.db.prepare('DELETE FROM binding_reservations WHERE binding=? AND token=? AND owner_instance=?')
                    .run(binding, token, this.instance);
        };
    }
    receive(input) {
        return this.transaction(() => {
            const existing = this.db.prepare('SELECT * FROM handoffs WHERE binding=? AND generation=? AND request_id=?').get(input.binding, input.generation, input.requestId);
            if (existing) {
                if (existing.args_hash !== input.argsHash || existing.tool_name !== input.toolName)
                    throw new BridgeError('PROTOCOL', 'Reused MCP request ID with different arguments.');
                return { row: existing, duplicate: true };
            }
            const id = uid('handoff_'), call = uid('kiro_');
            this.db.prepare('INSERT INTO handoffs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.binding, input.generation, input.requestId, call, input.toolName, input.argsHash, 'RECEIVED', null, process.pid, this.instance, Date.now());
            this.db.prepare('INSERT INTO stable_handoffs(id) VALUES (?)').run(id);
            return { row: this.get(id), duplicate: false };
        });
    }
    get(id) { return this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id); }
    transition(id, next, resultHash) {
        this.transaction(() => {
            const row = this.get(id);
            if (!row)
                throw new BridgeError('STORAGE', 'Unknown handoff.');
            if (row.phase === next)
                return;
            if (!allowed[row.phase].includes(next))
                throw new BridgeError('STORAGE', `Illegal handoff transition ${row.phase} -> ${next}.`);
            this.db.prepare('UPDATE handoffs SET phase=?,result_hash=COALESCE(?,result_hash),updated_at=? WHERE id=?').run(next, resultHash ?? null, Date.now(), id);
        });
    }
    unresolved(binding) {
        const sql = "SELECT * FROM handoffs WHERE phase IN ('RECEIVED','EXPOSED_TO_PI','UNCERTAIN')";
        return (binding ? this.db.prepare(sql + ' AND binding=?').all(binding) : this.db.prepare(sql).all());
    }
    /** Old reset epochs were hashed and cannot be mapped back to a conversation.
     * Fail closed for unmarked legacy effects, even when their binding differs.
     * New writers publish the marker atomically with the handoff.
     */
    recoveryCandidates(binding) {
        return this.db.prepare(`SELECT h.* FROM handoffs h
            WHERE h.phase IN ('RECEIVED','EXPOSED_TO_PI','UNCERTAIN')
            AND (h.binding=? OR NOT EXISTS (SELECT 1 FROM stable_handoffs s WHERE s.id=h.id))`)
            .all(binding);
    }
    retireHandoff(id, owned) {
        this.transaction(() => {
            // The candidate list is only a hint: another connection may have
            // recorded a real result since it was read. Never move that row back.
            const row = this.get(id);
            if (!row || (row.phase !== 'RECEIVED' && row.phase !== 'EXPOSED_TO_PI'))
                return;
            if (owned ? row.owner_instance !== this.instance :
                row.owner_instance === this.instance || this.ownerLive(row.owner_instance, row.owner_pid))
                return;
            this.db.prepare('UPDATE handoffs SET phase=?,updated_at=? WHERE id=?')
                .run(row.phase === 'RECEIVED' ? 'CANCELLED' : 'UNCERTAIN', Date.now(), id);
        });
    }
    reconcileDeadOwners() {
        for (const row of this.unresolved())
            if (row.phase !== 'UNCERTAIN' && row.owner_instance !== this.instance)
                this.retireHandoff(row.id, false);
    }
    ownerLive(instance, pid) {
        const owner = this.db.prepare('SELECT state FROM owners WHERE instance=?').get(instance);
        return owner?.state === 'open' && alive(pid);
    }
    abandonOwned() {
        for (const row of this.unresolved())
            if (row.owner_instance === this.instance && row.phase !== 'UNCERTAIN')
                this.retireHandoff(row.id, true);
    }
    prune(olderThan = Date.now() - 7 * 86400000) {
        return this.transaction(() => {
            const changes = this.db.prepare("DELETE FROM handoffs WHERE phase IN ('RETURNED_TO_KIRO','CANCELLED') AND updated_at<?").run(olderThan).changes;
            this.db.exec('DELETE FROM stable_handoffs WHERE id NOT IN (SELECT id FROM handoffs)');
            return Number(changes);
        });
    }
    close() {
        if (this.closed)
            return;
        try {
            this.transaction(() => {
                this.db.prepare('DELETE FROM leases WHERE owner_instance=?').run(this.instance);
                this.db.prepare('DELETE FROM binding_reservations WHERE owner_instance=?').run(this.instance);
                this.db.prepare("UPDATE owners SET state='closed',updated_at=? WHERE instance=?").run(Date.now(), this.instance);
            });
        }
        finally {
            // A failed durable write must still release the connection. The error
            // propagates; persisted ownership remains conservative until recovery.
            try {
                this.db.close();
            }
            finally {
                this.closed = true;
            }
        }
    }
}
//# sourceMappingURL=journal.js.map