import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults } from '../src/config.js';
import { toModel } from '../src/provider/models.js';
export function config() {
    const c = defaults();
    c.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kiro-test-'));
    c.cli.binary = process.execPath;
    c.cli.prefixArgs = [fileURLToPath(new URL('../../fixtures/fake-kiro.mjs', import.meta.url))];
    c.cli.rpcTimeoutMs = 3000;
    c.cli.promptTimeoutMs = 20000;
    c.cli.cancelGraceMs = 250;
    c.limits.maxHandoffMs = 15000;
    c.compatibility.allowUnverified = true;
    c.admission.waitMs = 5000;
    return c;
}
export function model(c, id = 'test-opus') { return toModel({ id, name: id }, c); }
export function context(prompt = 'CALL_TOOL') {
    return { messages: [
            { role: 'system', content: 'You are a Pi coding agent.', timestamp: 1, toolsAdded: [{ name: 'fabric_exec', description: 'An inert tool fixture executed by the host.', parameters: { type: 'object', properties: { value: { type: 'string' }, iteration: { type: 'number' } }, additionalProperties: false } }] },
            { role: 'user', content: prompt, timestamp: 2 },
        ] };
}
export async function collect(stream) { for await (const _ of stream) { } return stream.result(); }
export function addResult(ctx, answer, isError = false) {
    ctx.messages.push(answer);
    for (const call of answer.content.filter((b) => b.type === 'toolCall'))
        ctx.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: isError ? 'HOST_DENIED' : 'HOST_OK' }], isError, timestamp: Date.now() });
}
export async function cleanup(runtime, c) { await runtime.close(); fs.rmSync(c.stateDir, { recursive: true, force: true }); }
//# sourceMappingURL=helpers.js.map