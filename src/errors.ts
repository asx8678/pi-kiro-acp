export type ErrorCode = 'CONFIG' | 'COMPATIBILITY' | 'AUTH' | 'MODEL_UNAVAILABLE' | 'UNSUPPORTED' | 'POLICY' | 'TRANSPORT' | 'PROTOCOL' | 'TIMEOUT' | 'CANCELLED' | 'BUSY' | 'LIMIT' | 'UNCERTAIN' | 'CONTEXT' | 'STORAGE';
export class BridgeError extends Error {
    constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'BridgeError';
    }
}
export function asError(e: unknown): Error { return e instanceof Error ? e : new Error(String(e)); }
export function cancelled(): BridgeError { return new BridgeError('CANCELLED', 'Operation cancelled.'); }
export function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted)
    throw cancelled(); }
export function publicError(e: unknown): string {
    const err = asError(e);
    return `${err instanceof BridgeError ? err.code : 'ERROR'}: ${redact(err.message).slice(0, 1600)}`;
}
/** Defense in depth; raw protocol frames and stderr are never logged by default. */
export function redact(s: string): string {
    return s.replace(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
        .replace(/((?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
        .replace(/(authorization["']?\s*[:=]\s*["']?)[^\r\n]+/gi, '$1[REDACTED]');
}
