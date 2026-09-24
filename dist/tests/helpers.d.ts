import { type Config } from '../src/config.js';
import { ProviderRuntime } from '../src/provider/runtime.js';
import type { Assistant, EffectiveContext, PiStream } from '../src/types.js';
export declare function config(): Config;
export declare function model(c: Config, id?: string): import("../src/types.js").Model;
export declare function context(prompt?: string): EffectiveContext;
export declare function collect(stream: PiStream): Promise<Assistant>;
export declare function addResult(ctx: EffectiveContext, answer: Assistant, isError?: boolean): void;
export declare function cleanup(runtime: ProviderRuntime, c: Config): Promise<void>;
