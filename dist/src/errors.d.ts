export type ErrorCode = 'CONFIG' | 'COMPATIBILITY' | 'AUTH' | 'MODEL_UNAVAILABLE' | 'UNSUPPORTED' | 'POLICY' | 'TRANSPORT' | 'PROTOCOL' | 'TIMEOUT' | 'CANCELLED' | 'BUSY' | 'LIMIT' | 'UNCERTAIN' | 'CONTEXT' | 'STORAGE';
export declare class BridgeError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, message: string, options?: ErrorOptions);
}
export declare function asError(e: unknown): Error;
export declare function cancelled(): BridgeError;
export declare function throwIfAborted(signal?: AbortSignal): void;
export declare function publicError(e: unknown): string;
/** Defense in depth; raw protocol frames and stderr are never logged by default. */
export declare function redact(s: string): string;
