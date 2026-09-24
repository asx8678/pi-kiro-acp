#!/usr/bin/env node
// Exercise the installed Pi host; live inference requires explicit opt-in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaults, loadConfig, writePrivateJson } from '../dist/src/config.js';
import { ProviderRuntime } from '../dist/src/provider/runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const live = args.length === 3 && args[0] === '--live' && args[1] && !args[1].startsWith('--') && args[2] === '--allow-billed';
if (args.length && !live)
    throw new Error('Usage: bun run test:pi [--live EXACT_MODEL_ID --allow-billed]');
const modelId = live ? args[1] : 'test-opus';
const config = live ? loadConfig() : defaults();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kiro-host-check-'));
const profile = path.join(temp, 'profile');
const configFile = path.join(profile, 'kiro-acp.json');
config.stateDir = path.join(profile, 'kiro-acp');
if (!live) {
    config.cli.binary = process.execPath;
    config.cli.prefixArgs = [path.join(root, 'fixtures', 'fake-kiro.mjs'), '--tags-inventory'];
    config.compatibility.allowUnverified = true;
}
config.cli.rpcTimeoutMs = live ? 30000 : 5000;
config.cli.promptTimeoutMs = live ? 60000 : 15000;
config.cli.cancelGraceMs = 500;
config.limits.maxHandoffMs = 10000;
config.compatibility.requireToolSnapshot = true;
config.admission.scope = path.basename(temp);

try {
    writePrivateJson(configFile, config);
    writePrivateJson(path.join(profile, 'settings.json'), {
        npmCommand: ['bun'],
        packages: [root],
    });
    const runtime = new ProviderRuntime(config);
    try {
        const { models } = await runtime.discover();
        assert.ok(models.some(model => model.id === modelId), `Kiro did not advertise model ${modelId}`);
    } finally {
        await runtime.close();
    }
    const probe = path.join(temp, 'probe.mjs');
    fs.writeFileSync(probe, `
export default function (pi) {
    pi.registerTool({
        name: 'bridge_probe',
        label: 'Bridge probe',
        description: 'Return an inert marker for the host integration test.',
        parameters: {
            type: 'object',
            properties: { value: { type: 'string' }, iteration: { type: 'number' } },
            additionalProperties: false,
        },
        async execute() {
            return { content: [{ type: 'text', text: 'PI_ACTUAL_HOST_OK' }], details: {} };
        },
    });
}
`);
    const result = spawnSync(process.env.PI_BIN || 'pi', [
        '--offline', '--no-session', '--no-approve', '--no-context-files',
        '--no-skills', '--no-prompt-templates', '--no-themes',
        '--no-builtin-tools', '--tools', 'bridge_probe', '--extension', probe,
        '--model', `kiro-acp/${modelId}`, '--thinking', 'off',
        '--system-prompt', 'Call bridge_probe exactly once, then report its response.',
        '--mode', 'json', '--print', live ? 'Call bridge_probe with value "hello" exactly once, then report the response.' : 'CALL_TOOL',
    ], {
        cwd: temp,
        env: {
            ...process.env,
            PI_CODING_AGENT_DIR: profile,
            PI_KIRO_ACP_CONFIG: configFile,
            PI_OFFLINE: '1',
        },
        encoding: 'utf8',
        timeout: live ? 90000 : 30000,
        killSignal: 'SIGINT',
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const messages = events.filter(event => event.type === 'message_end').map(event => event.message);
    const failures = messages.filter(message => ['error', 'aborted'].includes(message.stopReason));
    assert.deepEqual(failures.map(message => message.errorMessage), []);
    const calls = events.filter(event => event.type === 'tool_execution_start');
    assert.equal(calls.length, 1, 'Pi must execute exactly one host tool');
    assert.equal(calls[0].toolName, 'bridge_probe');
    const final = messages.filter(message => message.role === 'assistant').at(-1);
    assert.equal(final?.stopReason, 'stop');
    assert.match(final.content.filter(block => block.type === 'text').map(block => block.text).join(''), /PI_ACTUAL_HOST_OK/);
    console.log(JSON.stringify({
        check: live ? 'installed Pi host with live Kiro' : 'installed Pi host with offline Kiro fixture',
        result: 'passed',
        toolCalls: calls.length,
        marker: 'PI_ACTUAL_HOST_OK',
        paidPromptSent: Boolean(live),
    }, null, 2));
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
