import type { ModelEntry } from '../types.js';
import { type Obj } from '../util.js';
export type ModelMetadata = Pick<ModelEntry, 'description' | 'contextWindow' | 'contextWindowSource'>;
export declare function tokenCount(value: unknown): number | undefined;
export declare function modelMetadata(raw: Obj): ModelMetadata;
