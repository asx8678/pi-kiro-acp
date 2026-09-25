import { type Obj } from '../util.js';
export declare const FABRIC_POLICY_VERSION = 2;
export declare const REVIEWED_FABRIC_VERSION = "0.96.3";
export declare const FABRIC_PATCH_FILES: readonly ["dist/chunks/chunk-ZRI433JP.js", "dist/chunks/chunk-TGAVMUOS.js", "dist/chunks/chunk-D4B4CCTA.js", "dist/chunks/chunk-F72MAIQY.js", "dist/worker.js"];
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
    fabricVersion?: string;
    reason?: string;
};
