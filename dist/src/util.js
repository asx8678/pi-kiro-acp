import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, cancelled, throwIfAborted } from './errors.js';
export function object(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function requireObject(v, label) {
    if (!object(v))
        throw new BridgeError('PROTOCOL', `${label} must be an object.`);
    return v;
}
export function str(v, fallback = '') { return typeof v === 'string' ? v : fallback; }
export function list(v) { return Array.isArray(v) ? v : []; }
export function uid(prefix = '') { return prefix + randomUUID(); }
export function canonical(v) {
    const seen = new Set();
    function visit(x, depth = 0) {
        if (depth > 100)
            throw new BridgeError('LIMIT', 'JSON nesting exceeds 100 levels.');
        if (x === null || typeof x === 'string' || typeof x === 'boolean')
            return x;
        if (typeof x === 'number' && Number.isFinite(x))
            return x;
        if (x === undefined)
            return null;
        if (typeof x !== 'object')
            throw new BridgeError('PROTOCOL', 'Non-JSON value in request.');
        if (seen.has(x))
            throw new BridgeError('PROTOCOL', 'Cyclic request.');
        seen.add(x);
        let result;
        if (Array.isArray(x))
            result = x.map(a => visit(a, depth + 1));
        else {
            const out = Object.create(null);
            for (const key of Object.keys(x).sort()) {
                const value = x[key];
                if (value !== undefined)
                    out[key] = visit(value, depth + 1);
            }
            result = out;
        }
        seen.delete(x);
        return result;
    }
    return JSON.stringify(visit(v));
}
export function hash(v) { return createHash('sha256').update(canonical(v)).digest('hex'); }
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // A deferred may be rejected before the consumer resumes. It must not crash the host.
    void promise.catch(() => { });
    return { promise, resolve, reject };
}
export function sleep(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
        signal?.addEventListener('abort', abort, { once: true });
    });
}
export function withAbort(p, signal) {
    throwIfAborted(signal);
    if (!signal)
        return p;
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(cancelled()); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        p.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
    });
}
export function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return object(e) && e.code === 'EPERM';
    }
}
export function boundedString(v, label, max = 8192) {
    if (typeof v !== 'string' || !v || v.length > max)
        throw new BridgeError('CONFIG', `Invalid ${label}.`);
    return v;
}
//# sourceMappingURL=util.js.map