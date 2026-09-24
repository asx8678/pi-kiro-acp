import type { PiStream, PiEvent, Assistant, Model, ToolCall } from '../types.js';
/** Used by tests/CLI. Inside Pi, its own exported stream factory is used instead. */
export declare class LocalStream implements PiStream {
    private limit;
    private events;
    private waiters;
    private ended;
    private final;
    constructor(limit?: number);
    push(event: PiEvent): void;
    end(result?: Assistant): void;
    private finishWaiters;
    [Symbol.asyncIterator](): AsyncIterator<PiEvent>;
    result(): Promise<Assistant>;
}
export declare class StreamWriter {
    readonly stream: PiStream;
    private maxBytes;
    readonly message: Assistant;
    done: boolean;
    private started;
    private current?;
    private bytes;
    constructor(stream: PiStream, model: Model, maxBytes: number);
    start(): void;
    chunk(type: 'text' | 'thinking', delta: string): void;
    private endBlock;
    tool(call: ToolCall): void;
    finish(reason?: 'stop' | 'length' | 'toolUse', raw?: string): void;
    fail(error: unknown): void;
}
