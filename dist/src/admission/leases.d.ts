import type { Config } from '../config.js';
import type { Journal } from '../storage/journal.js';
export interface Lease {
    id: string;
    release: () => void;
}
export declare class Admission {
    private journal;
    private config;
    private checkBudget;
    constructor(journal: Journal, config: Config['admission'], checkBudget?: () => void);
    acquire(signal?: AbortSignal): Promise<Lease>;
    private sweep;
    status(): unknown;
}
