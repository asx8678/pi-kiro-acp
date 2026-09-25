export interface Config {
    version: 1;
    providerId: 'kiro-acp';
    client: {
        name: 'kirocrew' | 'pi-fabric' | 'pi';
    };
    cli: {
        binary: string;
        prefixArgs: string[];
        rpcTimeoutMs: number;
        promptTimeoutMs: number;
        cancelGraceMs: number;
    };
    compatibility: {
        allowUnverified: boolean;
        approvedVersions: string[];
        orderedSteeringVersions: string[];
        requireToolSnapshot: boolean;
    };
    models: {
        plannerId: string | null;
        workerId: string;
        contextWindow: number;
        maxTokens: number;
    };
    sessions: {
        idleTtlMs: number;
        maxResident: number;
        forceRebuild: boolean;
    };
    limits: {
        maxFrameBytes: number;
        maxPromptBytes: number;
        maxOutputBytes: number;
        maxToolResultBytes: number;
        maxQueuedEvents: number;
        maxHandoffMs: number;
    };
    admission: {
        scope: string;
        maxActive: number;
        maxQueued: number;
        waitMs: number;
    };
    policy: {
        kiroOnly: boolean;
    };
    budget: {
        dailyCredits: number;
        warningCredits: number;
        warningFraction: number;
    };
    efficiency: {
        enabled: boolean;
        contextTokens: number;
    };
    reporting: {
        timeZone: string;
        accountCacheMs: number;
        retainTaskExcerpts: boolean;
    };
    stateDir: string;
}
export declare function agentDir(): string;
export declare function configPath(): string;
export declare function defaults(): Config;
export declare function parseConfig(raw: unknown): Config;
export declare function loadConfig(file?: string): Config;
export declare function privateDir(dir: string): void;
export declare function writePrivateJson(file: string, value: unknown): void;
