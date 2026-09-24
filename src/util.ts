import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, cancelled, throwIfAborted } from './errors.js';
export type Obj = Record<string, unknown>;
export function object(v: unknown): v is Obj { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function requireObject(v: unknown, label: string): Obj {
    if (!object(v))
        throw new BridgeError('PROTOCOL', `${label} must be an object.`);
    return v;
}
export function str(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback; }
export function list(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
export function uid(prefix = ''): string { return prefix + randomUUID(); }
export function canonical(v: unknown): string {
    const seen = new Set<object>();
    function visit(x: unknown, depth = 0): unknown {
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
        let result: unknown;
        if (Array.isArray(x))
            result = x.map(a => visit(a, depth + 1));
        else {
            const out: Obj = Object.create(null) as Obj;
            for (const key of Object.keys(x).sort()) {
                const value = (x as Obj)[key];
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
export function hash(v: unknown): string { return createHash('sha256').update(canonical(v)).digest('hex'); }
export function deferred<T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    // A deferred may be rejected before the consumer resumes. It must not crash the host.
    void promise.catch(() => { });
    return { promise, resolve, reject };
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
        signal?.addEventListener('abort', abort, { once: true });
    });
}
export function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!signal)
        return p;
    return new Promise<T>((resolve, reject) => {
        const abort = () => { cleanup(); reject(cancelled()); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        p.then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
    });
}
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return object(e) && e.code === 'EPERM';
    }
}
export function boundedString(v: unknown, label: string, max = 8192): string {
    if (typeof v !== 'string' || !v || v.length > max)
        throw new BridgeError('CONFIG', `Invalid ${label}.`);
    return v;
}
