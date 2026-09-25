import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaults, writePrivateJson } from '../dist/src/config.js';
const root = fileURLToPath(new URL('../', import.meta.url)), [profile] = process.argv.slice(2);
const project = path.join(profile, 'host-project'); fs.mkdirSync(project, { recursive: true });
const fixture = path.join(project, 'fixture.ts');
fs.writeFileSync(fixture, "export const liveMarker = 'BEFORE_HOST_EDIT';\n");
const probe = path.join(project, 'probe.mjs');
fs.writeFileSync(probe, `import fs from 'node:fs';
export default pi => pi.registerTool({ name: 'opaque_mutate', label: 'Inert mutation', description: 'Offline fixture', parameters: { type: 'object', properties: {} },
execute: async () => { fs.writeFileSync(${JSON.stringify(fixture)}, "export const liveMarker = 'AFTER_HOST_EDIT';\\n"); return { content: [{ type: 'text', text: 'mutated' }], details: {} }; } });\n`);
const argumentFile = path.join(project, 'arguments.json');
writePrivateJson(argumentFile, { code: `
const root = ${JSON.stringify(project)};
const before = await extensions.fovea_focus({ root, query: 'liveMarker', fresh: true });
if (!before.text.includes('BEFORE_HOST_EDIT')) throw new Error('missing baseline');
await tools.call({ ref: 'extensions.opaque_mutate', args: {} });
const custom = await extensions.fovea_focus({ root, query: 'liveMarker', fresh: true });
if (!custom.text.includes('AFTER_HOST_EDIT')) throw new Error('stale custom mutation');
await pi.edit({ path: ${JSON.stringify(fixture)}, oldText: 'AFTER_HOST_EDIT', newText: 'NATIVE_HOST_EDIT' });
const native = await extensions.fovea_focus({ root, query: 'liveMarker', fresh: true });
if (!native.text.includes('NATIVE_HOST_EDIT')) throw new Error('stale native mutation');
return 'CAPTURED_FRESHNESS_OK';
` });
const config = defaults();
config.stateDir = path.join(profile, 'offline-state');
config.cli.binary = process.execPath;
config.cli.prefixArgs = [path.join(root, 'fixtures/fake-kiro.mjs'), '--tags-inventory', '--tool-arguments-file', argumentFile];
config.cli.promptTimeoutMs = 60000; config.limits.maxHandoffMs = 45000;
config.compatibility.allowUnverified = true; config.compatibility.requireToolSnapshot = true;
const configFile = path.join(profile, 'offline-kiro.json'); writePrivateJson(configFile, config);
const { ProviderRuntime } = await import('../dist/src/provider/runtime.js');
const runtime = new ProviderRuntime(config);
try { await runtime.discover(); } finally { await runtime.close(); }
writePrivateJson(path.join(profile, 'settings.json'), { packages: [root, path.join(profile, 'npm/node_modules/pi-fabric'), path.join(profile, 'npm/node_modules/pi-fovea')], retry: { enabled: false }, cacheWarming: 'off', compaction: { enabled: false } });
writePrivateJson(path.join(profile, 'fabric.json'), { configVersion: 4, mcp: { enabled: false }, jev: { enabled: false }, mesh: { enabled: false }, agents: { enabled: false }, prewalk: { enabled: false } });
writePrivateJson(path.join(profile, 'fovea.json'), { sync: { mode: 'disabled', pushFocus: false }, tools: { defaultBudget: 512, grepMode: 'off' } });
const result = spawnSync(process.env.PI_BIN || 'pi', ['--offline', '--no-session', '--no-approve', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', 'fabric_exec', '-e', probe, '--model', 'kiro-acp/auto', '--thinking', 'off', '--mode', 'json', '--print', 'CALL_TOOL'], {
    cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_KIRO_ACP_CONFIG: configFile, PI_OFFLINE: '1', PI_KIRO_CREDIT_TASK_ID: '', PI_KIRO_CREDIT_OWNER_PID: '' },
    encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGINT',
});
assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
const ends = events.filter(event => event.type === 'tool_execution_end');
assert.equal(ends.length, 1, result.stdout.slice(-5000));
assert.equal(ends[0].isError, false, JSON.stringify(ends[0]));
assert.match(JSON.stringify(ends[0].result), /CAPTURED_FRESHNESS_OK/);
assert.match(fs.readFileSync(fixture, 'utf8'), /NATIVE_HOST_EDIT/);
console.log(JSON.stringify({ check: 'installed Pi + real Fabric/Fovea + fake Kiro', result: 'passed', toolCalls: ends.length, paidPrompts: 0 }));
