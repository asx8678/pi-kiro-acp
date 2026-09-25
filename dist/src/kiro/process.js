import { deferred, object } from '../util.js';
/** Call only for children spawned with detached:true on POSIX. Never signal Pi's group. */
export function signalOwnedProcess(child, signal) {
    if (!child.pid)
        return;
    try {
        if (process.platform === 'win32')
            child.kill(signal);
        else
            process.kill(-child.pid, signal);
    }
    catch { /* already gone */ }
}
function groupExists(child) {
    if (!child.pid || process.platform === 'win32')
        return false;
    try {
        process.kill(-child.pid, 0);
        return true;
    }
    catch (error) {
        return !object(error) || error.code !== 'ESRCH';
    }
}
/** A leader closing its pipes does not prove its descendants exited. */
export async function closeOwnedProcess(child, closed, graceMs) {
    signalOwnedProcess(child, 'SIGTERM');
    const escalated = deferred();
    const timer = setTimeout(() => { signalOwnedProcess(child, 'SIGKILL'); escalated.resolve(); }, Math.max(0, graceMs));
    try {
        await closed;
        if (groupExists(child))
            await escalated.promise;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=process.js.map