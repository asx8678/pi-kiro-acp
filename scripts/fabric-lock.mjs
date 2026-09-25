import fs from 'node:fs';
import path from 'node:path';

// Serialize launcher and explicit repairs. Never remove someone else's lock or
// guess that a long-running package install is dead.
export function withFabricLock(dir, work, timeoutMs = 30000) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = path.join(dir, '.kiro-acp-fabric-repair.lock');
    const deadline = Date.now() + timeoutMs;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let fd;
    while (fd === undefined) {
        try { fd = fs.openSync(lock, 'wx', 0o600); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // A crashed repair leaves evidence. Recover only a complete lock
            // owned by this user whose recorded process no longer exists.
            const before = fs.lstatSync(lock, { throwIfNoEntry: false });
            if (!before) continue;
            if (!before.isFile() || (process.getuid && before.uid !== process.getuid()))
                throw new Error(`Unsafe Fabric repair lock: ${lock}`);
            let pid;
            try { pid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid; } catch { /* Writer may still be initializing it. */ }
            if (Number.isSafeInteger(pid) && pid > 0) {
                let dead = false;
                try { process.kill(pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
                if (dead) {
                    // Serialize stale-lock reclaimers too: two check/unlink
                    // sequences must never remove a newly acquired live lock.
                    const reaper = `${lock}.reclaim`;
                    let claim;
                    try { claim = fs.openSync(reaper, 'wx', 0o600); }
                    catch (error) { if (error.code !== 'EEXIST') throw error; }
                    if (claim !== undefined) {
                        try {
                            const after = fs.lstatSync(lock, { throwIfNoEntry: false });
                            if (after?.ino === before.ino && after.dev === before.dev && after.birthtimeMs === before.birthtimeMs
                                && JSON.parse(fs.readFileSync(lock, 'utf8')).pid === pid) fs.unlinkSync(lock);
                        } finally { fs.closeSync(claim); fs.unlinkSync(reaper); }
                        continue;
                    }
                }
            }
            if (Date.now() >= deadline)
                throw new Error(`Another Fabric repair is active or its lock is incomplete: ${lock}. Pi was not started.`);
            Atomics.wait(pause, 0, 0, 100);
        }
    }
    const owned = fs.fstatSync(fd);
    try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }) + '\n');
        return work();
    } finally {
        fs.closeSync(fd);
        const current = fs.lstatSync(lock, { throwIfNoEntry: false });
        if (current?.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(lock);
    }
}
