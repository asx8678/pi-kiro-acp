export class BridgeError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'BridgeError';
    }
}
export function asError(e) { return e instanceof Error ? e : new Error(String(e)); }
export function cancelled() { return new BridgeError('CANCELLED', 'Operation cancelled.'); }
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw cancelled();
}
export function publicError(e) {
    const err = asError(e);
    return `${err instanceof BridgeError ? err.code : 'ERROR'}: ${redact(err.message).slice(0, 1600)}`;
}
/** Defense in depth; raw protocol frames and stderr are never logged by default. */
export function redact(s) {
    return s.replace(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
        .replace(/((?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
        .replace(/(authorization["']?\s*[:=]\s*["']?)[^\r\n]+/gi, '$1[REDACTED]');
}
//# sourceMappingURL=errors.js.map