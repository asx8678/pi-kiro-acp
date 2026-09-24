import type { Config } from '../config.js';
import { type Obj } from '../util.js';
import { Catalog } from './catalog.js';
export interface McpResult {
    content: {
        type: 'text';
        text: string;
    }[];
    isError?: boolean;
}
export interface CallContext {
    id: string;
    signal: AbortSignal;
    progressToken?: string | number;
}
export declare class ToolServer {
    readonly catalog: Catalog;
    private limits;
    private call;
    private server?;
    private sockets;
    private token;
    private endpoint;
    private controllers;
    readonly listed: {
        promise: Promise<void>;
        resolve: (v: void | PromiseLike<void>) => void;
        reject: (e: unknown) => void;
    };
    private listSeen;
    onDisconnect: (id: string) => void;
    constructor(catalog: Catalog, limits: Config['limits'], call: (name: string, args: Obj, ctx: CallContext) => Promise<McpResult>);
    private starting?;
    private closing?;
    private stopped;
    start(): Promise<void>;
    private doStart;
    descriptor(): Obj;
    get url(): string;
    private json;
    private handle;
    close(): Promise<void>;
    private doClose;
}
