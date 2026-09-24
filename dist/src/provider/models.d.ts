import type { Config } from '../config.js';
import type { ModelEntry, Model } from '../types.js';
export declare function withContextWindow(entry: ModelEntry, config: Config): ModelEntry & {
    contextWindow: number;
};
export declare function toModel(entry: ModelEntry, config: Config): Model;
export declare function readCatalog(config: Config): ModelEntry[];
export declare function saveCatalog(config: Config, models: ModelEntry[], version: string): void;
