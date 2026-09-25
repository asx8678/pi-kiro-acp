export type Obj = Record<string, unknown>;
export declare function object(v: unknown): v is Obj;
export declare function requireObject(v: unknown, label: string): Obj;
export declare function str(v: unknown, fallback?: string): string;
export declare function list(v: unknown): unknown[];
export declare function uid(prefix?: string): string;
export declare function canonical(v: unknown): string;
export declare function hashEncoded(encoded: string): string;
export declare function hash(v: unknown): string;
export declare function deferred<T>(): {
    promise: Promise<T>;
    resolve: (v: T | PromiseLike<T>) => void;
    reject: (e: unknown) => void;
};
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
export declare function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T>;
export declare function alive(pid: number): boolean;
export declare function boundedString(v: unknown, label: string, max?: number): string;
