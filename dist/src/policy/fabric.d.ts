import { type Obj } from '../util.js';
export declare const FABRIC_POLICY_VERSION = 1;
export declare const WORKER_LIMITS: {
    maxConcurrent: number;
    maxPerExecution: number;
    maxDepth: number;
    timeoutMs: number;
};
/** Called by the installed Fabric dispatch patch, before resolving credentials or spawning. */
export declare function assertFabricProvider(provider: unknown): void;
export declare function rejectFabricJev(): void;
export declare function guardFabricWorker(request: Obj, defaults?: Obj): Obj;
/** Applies after project settings are merged, so they cannot accidentally undo this profile. */
export declare function applyFabricProfile(raw: Obj): Obj;
/** Detect an update that removed or changed the reviewed patch before allowing Fabric calls. */
export declare function fabricGuardStatus(): {
    installed: boolean;
    ready: boolean;
    reason?: string;
};
