import fs from 'node:fs';
import path from 'node:path';
import { writePrivateJson } from '../config.js';
import { object, list } from '../util.js';
import { tokenCount } from '../kiro/model-metadata.js';
export function withContextWindow(entry, config) {
    const reported = entry.contextWindowSource === 'configured-fallback' ? undefined : tokenCount(entry.contextWindow);
    return { ...entry, contextWindow: reported ?? config.models.contextWindow,
        contextWindowSource: reported === undefined ? 'configured-fallback' : entry.contextWindowSource ?? 'metadata' };
}
export function toModel(entry, config) {
    const efforts = entry.efforts ?? [];
    return { ...withContextWindow(entry, config), api: 'kiro-acp-v3', provider: 'kiro-acp', baseUrl: 'kiro-cli://local',
        name: `${entry.name} (Kiro)`, input: ['text'], reasoning: efforts.length > 0,
        maxTokens: entry.maxTokens ?? config.models.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(efforts.length ? { thinkingLevelMap: Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(k => [k, efforts.includes(k) ? k : null])) } : {}),
    };
}
export function readCatalog(config) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'catalog.json'), 'utf8'));
        if (!object(raw) || raw.scope !== config.admission.scope)
            return [];
        return list(raw.models).flatMap((m) => {
            if (!object(m) || typeof m.id !== 'string' || typeof m.name !== 'string')
                return [];
            const entry = { id: m.id, name: m.name };
            if (typeof m.description === 'string')
                entry.description = m.description;
            const contextWindow = tokenCount(m.contextWindow);
            if (contextWindow !== undefined && m.contextWindowSource !== 'configured-fallback') {
                entry.contextWindow = contextWindow;
                entry.contextWindowSource = m.contextWindowSource === 'description' ? 'description' : 'metadata';
            }
            const maxTokens = tokenCount(m.maxTokens);
            if (maxTokens !== undefined)
                entry.maxTokens = maxTokens;
            if (Array.isArray(m.efforts) && m.efforts.every(x => typeof x === 'string'))
                entry.efforts = m.efforts;
            return [entry];
        });
    }
    catch {
        return [];
    }
}
export function saveCatalog(config, models, version) {
    writePrivateJson(path.join(config.stateDir, 'catalog.json'), { scope: config.admission.scope, version, checkedAt: Date.now(), entitlement: 'must-be-rechecked-per-session', models });
}
//# sourceMappingURL=models.js.map