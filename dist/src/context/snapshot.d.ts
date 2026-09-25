import type { EffectiveContext, Extractors, Tool } from '../types.js';
import { type Obj } from '../util.js';
export interface Snapshot {
    system: string;
    systemHash: string;
    tools: Tool[];
    toolsHash: string;
    messages: Obj[];
    hashes: string[];
    bytes: number;
    hash: string;
}
/** Public SystemMessage semantics, also used in isolated tests. Live Pi uses its own helpers. */
export declare const fallbackExtractors: Extractors;
export declare function text(value: unknown): string;
export declare function projectMessage(raw: unknown): Obj;
export declare function snapshot(context: EffectiveContext, extractors?: Extractors, noTools?: boolean, maxBytes?: number): Snapshot;
export declare function hashPrefixLength(old: readonly string[], next: readonly string[]): number;
/** Compatibility helper for callers without an immutable snapshot. */
export declare function prefixLength(old: Obj[], next: Obj[]): number;
export declare function replay(messages: Obj[]): string;
export declare function appendInput(messages: Obj[]): string;
