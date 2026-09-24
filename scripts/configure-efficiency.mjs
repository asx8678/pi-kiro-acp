import fs from 'node:fs';
import path from 'node:path';
import { agentDir, configPath, loadConfig, parseConfig, writePrivateJson } from '../dist/src/config.js';
import { readCatalog, withContextWindow } from '../dist/src/provider/models.js';
import { WORKER_LIMITS, fabricGuardStatus } from '../dist/src/policy/fabric.js';

const guard = fabricGuardStatus();
if (guard.installed && !guard.ready) throw new Error(guard.reason);
const dir = agentDir();
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const config = loadConfig();
config.models.workerId = 'auto';
config.policy.kiroOnly = true;
config.budget = { dailyCredits: 0, warningCredits: 50, warningFraction: 0.8 };
config.efficiency = { ...config.efficiency, enabled: true };
config.limits.maxPromptBytes = 4 * 1024 * 1024;
config.limits.maxFrameBytes = 16 * 1024 * 1024;
config.limits.maxToolResultBytes = 256 * 1024;
config.admission.maxActive = 3;
config.admission.maxQueued = 8;
parseConfig(config);

const settingsFile = path.join(dir, 'settings.json');
const settings = read(settingsFile);
settings.npmCommand = ['bun'];
settings.packages = (settings.packages ?? []).map(entry => {
    if (typeof entry === 'string' && /^npm:pi-fabric(?:@[^/]+)?$/.test(entry)) return 'npm:pi-fabric@0.94.0';
    if (entry && typeof entry === 'object' && typeof entry.source === 'string' && /^npm:pi-fabric(?:@[^/]+)?$/.test(entry.source)) return { ...entry, source: 'npm:pi-fabric@0.94.0' };
    return entry;
});
settings.defaultProvider = 'kiro-acp';
settings.defaultModel = 'auto';
settings.defaultThinkingLevel = 'low';
settings.enabledModels = ['kiro-acp/*'];
settings.retry = { ...settings.retry, enabled: false, provider: { ...settings.retry?.provider, maxRetries: 0 } };
settings.compaction = { ...settings.compaction, enabled: true, reserveTokens: 16384, keepRecentTokens: 8192 };
settings.compaction.modelOverrides = { ...settings.compaction.modelOverrides };
const models = readCatalog(config).map(entry => withContextWindow(entry, config));
for (const model of models) {
    settings.compaction.modelOverrides[`kiro-acp/${model.id}`] = {
        reserveTokens: Math.max(config.models.maxTokens + 4096, model.contextWindow - config.efficiency.contextTokens),
        keepRecentTokens: 8192,
    };
}

const fabricFile = path.join(dir, 'fabric.json');
const fabric = read(fabricFile);
Object.assign(fabric, { configVersion: 4, fullCodeMode: true });
fabric.executor = { ...fabric.executor, kernel: 'typescript', runtime: 'quickjs', maxOutputChars: 12000, maxNestedResultChars: 64000 };
fabric.agents = { ...fabric.agents, enabled: true, runner: 'pi', transport: 'process', model: 'kiro-acp/auto', thinking: 'low', extensions: true, ...WORKER_LIMITS, budgetUsd: 0, maxTokensPerChild: 0 };
fabric.jev = { ...fabric.jev, enabled: false };
fabric.mcp = { ...fabric.mcp, jev: { ...fabric.mcp?.jev, semanticSearch: false } };
fabric.approvals = { ...fabric.approvals, model: 'kiro-acp/auto' };
fabric.prewalk = { ...fabric.prewalk, enabled: false, alwaysRearm: false, model: 'kiro-acp/auto', thinking: 'low' };
fabric.compaction = { ...fabric.compaction, engine: 'fabric', targetContextRatio: 0.5, tokenThresholds: { ...fabric.compaction?.tokenThresholds } };
for (const model of models) fabric.compaction.tokenThresholds[`kiro-acp/${model.id}`] = Math.min(config.efficiency.contextTokens, model.contextWindow - config.models.maxTokens - 4096);

const foveaFile = path.join(dir, 'fovea.json');
const fovea = read(foveaFile);
fovea.sync = { ...fovea.sync, mode: 'disabled', pushFocus: false, budget: 256 };
fovea.tools = { ...fovea.tools, defaultBudget: 512, grepMode: 'replace', grepAugmentBudget: 256 };

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const [file, value] of [[configPath(), config], [settingsFile, settings], [fabricFile, fabric], [foveaFile, fovea]]) {
    const encoded = JSON.stringify(value, null, 2) + '\n';
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === encoded) continue;
    if (fs.existsSync(file)) {
        fs.copyFileSync(file, `${file}.before-efficiency-${stamp}`, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(`${file}.before-efficiency-${stamp}`, 0o600);
    }
    writePrivateJson(file, value);
    console.log(`Updated ${file}`);
}
console.log(`Warning at 50 credits/day (${config.reporting.timeZone}); no spending cutoff. Compaction configured for ${models.length} cached models. Restart Pi.`);
