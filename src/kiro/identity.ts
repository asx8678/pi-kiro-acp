import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';

// Resolve from the shipped dist/src/kiro module, never the user's working directory.
const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof manifest.version !== 'string' || !manifest.version.trim())
    throw new Error('The pi-kiro-acp package must declare its version.');
export const PACKAGE_VERSION = manifest.version;

// Requested Crew wire identity, pinned to the latest stable release checked on
// 2026-09-24. v0.7.0 still declares ACP CLIENT_VERSION = '0.1.2' in client.py
// and runtime.py; its product version is not its advertised ACP version.
// Local CLI/help output continues to use this adapter's package version.
export const CREW_IDENTITY = {
    release: 'v0.7.0',
    commit: 'ba797801739c0a0a94663837feb3c1b761fc0855',
    client: { name: 'kirocrew', version: '0.1.2' },
    agent: 'kirocrew',
    server: { name: 'kirocrew-core', version: '1.0.0' },
} as const;
export function clientInfo(name: Config['client']['name']) {
    return { name, version: name === CREW_IDENTITY.client.name ? CREW_IDENTITY.client.version : PACKAGE_VERSION };
}
export const BRIDGE_MODE = CREW_IDENTITY.agent;
export const SERVER_NAME = CREW_IDENTITY.server.name;
export const SERVER_INFO = CREW_IDENTITY.server;
