import type { PiPort, PiStream } from './types.js';
import { ProviderRuntime } from './provider/runtime.js';
import { type UsageUiPort } from './ui/usage-dashboard.js';
export interface PiAiPort {
    createAssistantMessageEventStream: () => PiStream;
    getCurrentSystemPrompt: (messages: unknown[]) => string;
    getCurrentTools: (messages: unknown[]) => unknown[];
}
/** Dependency injection is for contract tests, not an alternate model service. */
export declare function installExtension(pi: PiPort, ai: PiAiPort, tui?: UsageUiPort): Promise<ProviderRuntime>;
export default function extension(pi: PiPort): Promise<void>;
