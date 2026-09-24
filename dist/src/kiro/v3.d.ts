import type { Config } from '../config.js';
import type { Catalog } from '../tools/catalog.js';
import type { ModelEntry } from '../types.js';
import { type Obj } from '../util.js';
import { RpcProcess } from './jsonrpc.js';
import { type CreditReport } from './credits.js';
import { type TokenReport } from './tokens.js';
import { type ModelMetadata } from './model-metadata.js';
import { type AccountUsage } from './account-usage.js';
export interface SessionOption {
    id: string;
    category: string;
    currentValue: string;
    values: (ModelMetadata & {
        value: string;
        name: string;
    })[];
}
export declare function parseOptions(raw: unknown): SessionOption[];
export declare function catalogFrom(raw: unknown): ModelEntry[];
export type KiroEvent = {
    kind: 'text' | 'thinking';
    text: string;
} | {
    kind: 'usage';
    data: Obj;
} | {
    kind: 'compaction';
} | {
    kind: 'credits';
    report: CreditReport;
} | {
    kind: 'tokens';
    report: TokenReport;
} | {
    kind: 'context_usage';
    percent: number;
} | {
    kind: 'prompt_start';
    promptId: string;
    startedAt: number;
} | {
    kind: 'prompt_end';
    promptId: string;
};
export declare class V3Session {
    readonly config: Config;
    readonly cwd: string;
    private observer?;
    readonly rpc: RpcProcess;
    sessionId: string;
    version: string;
    private options;
    private modelEntries;
    private currentModel;
    private currentMode;
    private pinnedModel?;
    private toolSurface;
    private epochTools;
    private failure?;
    private promptActive;
    private promptCredits;
    private creditPromptId?;
    private promptDrained?;
    private disposed;
    private eventsTail;
    private early;
    readonly failed: {
        promise: Promise<Error>;
        resolve: (v: Error | PromiseLike<Error>) => void;
        reject: (e: unknown) => void;
    };
    onEvent: (event: KiroEvent) => Promise<void>;
    onFailure: (e: Error) => void;
    constructor(config: Config, cwd: string, catalog: Catalog, observer?: ((e: unknown) => Promise<void>) | undefined);
    private fail;
    private check;
    start(system: string, descriptor: Obj | undefined, signal?: AbortSignal): Promise<void>;
    private applyConfig;
    private metadata;
    private normalizedEvents;
    verifyTools(signal?: AbortSignal): Promise<void>;
    select(modelId: string, effort?: string, signal?: AbortSignal): Promise<void>;
    catalogEntries(): ModelEntry[];
    effortValues(): string[];
    selected(): {
        model: string;
        effort: string | undefined;
        mode: string;
    };
    prompt(input: string): Promise<string>;
    steer(message: string): Promise<void>;
    flushEvents(): Promise<void>;
    accountUsage(signal?: AbortSignal): Promise<AccountUsage>;
    private closeTask?;
    close(): Promise<void>;
    private doClose;
    get toolAudit(): string;
}
