import { DatabaseSync } from 'node:sqlite';
export type HandoffPhase = 'RECEIVED' | 'EXPOSED_TO_PI' | 'RESULT_RECORDED' | 'RETURNED_TO_KIRO' | 'CANCELLED' | 'UNCERTAIN';
export interface HandoffRow {
    id: string;
    binding: string;
    generation: string;
    request_id: string;
    pi_call_id: string;
    tool_name: string;
    args_hash: string;
    phase: HandoffPhase;
    result_hash: string | null;
    owner_pid: number;
    owner_instance: string;
    updated_at: number;
}
export declare class Journal {
    readonly dir: string;
    readonly db: DatabaseSync;
    readonly instance: string;
    closed: boolean;
    private transactionActive;
    get inTransaction(): boolean;
    constructor(dir: string);
    transaction<T>(fn: () => T): T;
    /** Fence a provider turn across processes before recovery or any asynchronous startup.
     * No expiry: a slow live owner must never lose exclusivity. At a tool boundary the
     * durable handoff protects the conversation after this short-lived claim releases.
     */
    reserveBinding(binding: string): () => void;
    receive(input: {
        binding: string;
        generation: string;
        requestId: string;
        toolName: string;
        argsHash: string;
    }): {
        row: HandoffRow;
        duplicate: boolean;
    };
    get(id: string): HandoffRow | undefined;
    transition(id: string, next: HandoffPhase, resultHash?: string): void;
    unresolved(binding?: string): HandoffRow[];
    /** Old reset epochs were hashed and cannot be mapped back to a conversation.
     * Fail closed for unmarked legacy effects, even when their binding differs.
     * New writers publish the marker atomically with the handoff.
     */
    recoveryCandidates(binding: string): HandoffRow[];
    private retireHandoff;
    reconcileDeadOwners(): void;
    ownerLive(instance: string, pid: number): boolean;
    abandonOwned(): void;
    prune(olderThan?: number): number;
    close(): void;
}
