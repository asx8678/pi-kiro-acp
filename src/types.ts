/** Structural boundary types. The runtime loads Pi's own stream factory; no Pi copy is bundled. */
import type { Obj } from './util.js';
import type { UsagePanel, UsageTerminal, UsageTheme } from './ui/usage-dashboard.js';
export interface TextBlock {
    type: 'text';
    text: string;
}
export interface ThinkingBlock {
    type: 'thinking';
    thinking: string;
}
export interface ToolCall {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Obj;
}
export type Content = TextBlock | ThinkingBlock | ToolCall;
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
export interface Assistant {
    role: 'assistant';
    content: Content[];
    api: string;
    provider: string;
    model: string;
    timestamp: number;
    usage: Usage;
    stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
    errorMessage?: string;
    providerThinkingLevel?: string;
    rawStopReason?: string;
}
export type PiEvent = {
    type: 'start';
    partial: Assistant;
} | {
    type: 'text_start' | 'thinking_start' | 'toolcall_start';
    contentIndex: number;
    partial: Assistant;
} | {
    type: 'text_delta' | 'thinking_delta' | 'toolcall_delta';
    contentIndex: number;
    delta: string;
    partial: Assistant;
} | {
    type: 'text_end' | 'thinking_end';
    contentIndex: number;
    content: string;
    partial: Assistant;
} | {
    type: 'toolcall_end';
    contentIndex: number;
    toolCall: ToolCall;
    partial: Assistant;
} | {
    type: 'done';
    reason: 'stop' | 'length' | 'toolUse';
    message: Assistant;
} | {
    type: 'error';
    reason: 'error' | 'aborted';
    error: Assistant;
};
export interface PiStream extends AsyncIterable<PiEvent> {
    push(event: PiEvent): void;
    end(result?: Assistant): void;
    result(): Promise<Assistant>;
}
export interface Tool {
    name: string;
    description: string;
    parameters: Obj;
}
export interface ModelEntry {
    id: string;
    name: string;
    description?: string;
    contextWindow?: number;
    contextWindowSource?: 'metadata' | 'description' | 'configured-fallback';
    maxTokens?: number;
    efforts?: string[];
}
export interface Model extends ModelEntry {
    api: string;
    provider: string;
    baseUrl: string;
    reasoning: boolean;
    input: ('text' | 'image')[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap?: Record<string, string | null>;
}
export interface GenerationOptions {
    signal?: AbortSignal;
    sessionId?: string;
    reasoning?: string;
    toolChoice?: 'auto' | 'none';
    temperature?: number;
    maxTokens?: number;
    env?: Record<string, string>;
    metadata?: Obj;
    onPayload?: (payload: unknown, model: Model) => unknown | Promise<unknown>;
    onProviderStreamEvent?: (event: unknown, model: Model) => unknown | Promise<unknown>;
    onResponse?: unknown;
    [key: string]: unknown;
}
export interface EffectiveContext {
    messages: unknown[];
    systemPrompt?: string;
    tools?: unknown[];
}
export interface Extractors {
    system: (messages: unknown[]) => string;
    tools: (messages: unknown[]) => unknown[];
}
export interface HostContext {
    cwd: string;
    mode?: string;
    sessionManager?: {
        getSessionId?: () => string;
        getSessionFile?: () => string | undefined;
        getSessionName?: () => string | undefined;
    };
    model?: {
        provider: string;
        id: string;
    };
    abort?: () => void | Promise<void>;
    ui?: {
        notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
        setStatus?: (key: string, text: string | undefined) => void;
        setWidget?: (key: string, content: string[] | undefined, options?: { placement?: 'aboveEditor' | 'belowEditor' }) => void;
        custom?: <T>(factory: (tui: UsageTerminal, theme: UsageTheme, keybindings: unknown, done: (result: T) => void) => UsagePanel, options?: { overlay?: boolean; overlayOptions?: { width?: string } }) => Promise<T>;
    };
}
export interface PiPort {
    registerProvider: (provider: unknown) => void;
    unregisterProvider?: (id: string) => void;
    registerCommand: (name: string, definition: {
        description: string;
        handler: (args: string, ctx: HostContext) => Promise<void>;
    }) => void;
    on: (event: string, handler: (event: Obj, ctx: HostContext) => unknown) => unknown;
}
