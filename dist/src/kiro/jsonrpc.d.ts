import { BridgeError } from '../errors.js';
import type { Config } from '../config.js';
export interface RpcFrame {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export declare class RpcRemoteError extends BridgeError {
    readonly rpcCode: number;
    constructor(rpcCode: number, message: string);
}
/** Incremental, strict UTF-8 and NDJSON parser. It never treats non-JSON stdout as model text. */
export declare class Ndjson {
    private maxBytes;
    private onFrame;
    private decoder;
    private buffer;
    constructor(maxBytes: number, onFrame: (frame: RpcFrame) => void);
    push(chunk: Uint8Array): void;
    end(): void;
}
export declare class RpcProcess {
    private config;
    readonly cwd: string;
    private environment;
    private child?;
    private pending;
    private sequence;
    private closed;
    private closeResult;
    private writeTail;
    onNotification: (method: string, params: unknown) => void;
    onRequest: (method: string, params: unknown) => Promise<unknown>;
    onFailure: (e: Error) => void;
    constructor(config: Config, cwd: string, environment?: NodeJS.ProcessEnv);
    start(): void;
    request(method: string, params: unknown, options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<unknown>;
    notify(method: string, params: unknown): Promise<void>;
    private receive;
    private send;
    private fail;
    private terminate;
    private closeTask?;
    close(): Promise<void>;
    private doClose;
    get pid(): number | undefined;
}
export declare function inspectCli(config: Config, signal?: AbortSignal): Promise<{
    version: string;
    help: string;
}>;
