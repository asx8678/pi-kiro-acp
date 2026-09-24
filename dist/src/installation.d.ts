import { type Config } from './config.js';
type InstallationConfig = Pick<Config, 'stateDir'>;
export declare function installationIdPath(config: InstallationConfig): string;
/** Inspect without creating an identity, modifying permissions or returning its value. */
export declare function installationStatus(config: InstallationConfig): {
    file: string;
    initialized: boolean;
};
/** Crew-compatible uuid4().hex format, persisted only in this adapter's private state. */
export declare function ensureInstallationId(config: InstallationConfig): string;
export {};
