import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { ToolServer } from '../src/tools/mcp-server.js';
import { Catalog } from '../src/tools/catalog.js';
import { deferred } from '../src/util.js';
import { config } from './helpers.js';
function auth(server: ToolServer) { const d = server.descriptor(); return Object.fromEntries((d.headers as {
    name: string;
    value: string;
}[]).map(h => [h.name, h.value])); }
async function post(s: ToolServer, id: number | string, method: string, params: unknown, headers: Record<string, string> = {}) {
    return fetch(s.url, { method: 'POST', headers: { ...auth(s), 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
}
test('MCP requires bearer auth and rejects hostile origins', async () => {
    const c = config(), s = new ToolServer(new Catalog([]), c.limits, async () => ({ content: [] }));
    await s.start();
    try {
        assert.equal((await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
        assert.equal((await post(s, 1, 'ping', {}, { origin: 'https://malicious.invalid' })).status, 403);
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('MCP rejects DNS rebinding Host header', async () => {
    const c = config(), s = new ToolServer(new Catalog([]), c.limits, async () => ({ content: [] }));
    await s.start();
    try {
        const status = await new Promise<number>(resolve => { const req = http.request(s.url, { method: 'POST', headers: { ...auth(s), host: 'evil.invalid', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end('{}'); });
        assert.equal(status, 403);
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('MCP responds with the exact active catalog and holds execution until Pi supplies a result', async () => {
    const c = config(), d = deferred<{
        content: {
            type: 'text';
            text: string;
        }[];
    }>();
    let called = 0;
    const s = new ToolServer(new Catalog([{ name: 'fabric_exec', description: 'd', parameters: { type: 'object' } }]), c.limits, async () => { called++; return d.promise; });
    await s.start();
    try {
        const initialized = await (await post(s, 0, 'initialize', { protocolVersion: '2025-03-26' })).json() as { result: { serverInfo: unknown } };
        assert.equal(s.descriptor().name, 'kirocrew-core');
        assert.deepEqual(initialized.result.serverInfo, { name: 'kirocrew-core', version: '1.0.0' });
        const catalog = await (await post(s, 1, 'tools/list', {})).json() as {
            result: {
                tools: {
                    name: string;
                }[];
            };
        };
        assert.deepEqual(catalog.result.tools.map(t => t.name), ['fabric_exec']);
        let finished = false;
        const pending = post(s, 2, 'tools/call', { name: 'fabric_exec', arguments: {} }).then(async (r) => { finished = true; return r.json(); });
        await new Promise(r => setTimeout(r, 40));
        assert.equal(called, 1);
        assert.equal(finished, false);
        d.resolve({ content: [{ type: 'text', text: 'Pi result' }] });
        const result = await pending as {
            result: {
                content: {
                    text: string;
                }[];
            };
        };
        assert.equal(result.result.content[0]!.text, 'Pi result');
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('unknown and unlisted MCP tools never dispatch', async () => {
    const c = config();
    let calls = 0;
    const s = new ToolServer(new Catalog([]), c.limits, async () => { calls++; return { content: [] }; });
    await s.start();
    try {
        await post(s, 1, 'tools/call', { name: 'shell', arguments: {} });
        await post(s, 2, 'tools/list', {});
        await post(s, 3, 'tools/call', { name: 'shell', arguments: {} });
        assert.equal(calls, 0);
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
test('closing while the HTTP listener starts leaves no open server', async () => {
    const c = config(), s = new ToolServer(new Catalog([]), c.limits, async () => ({ content: [] }));
    const opening = s.start();
    await s.close();
    await opening;
    await assert.rejects(s.start(), /closed/);
    fs.rmSync(c.stateDir, { recursive: true, force: true });
});
test('numeric and string MCP request IDs retain distinct identities', async () => {
    const c = config(), seen: string[] = [];
    const s = new ToolServer(new Catalog([{ name: 't', description: 'd', parameters: { type: 'object' } }]), c.limits, async (_n, _a, ctx) => { seen.push(ctx.id); return { content: [] }; });
    await s.start();
    try {
        await post(s, 0, 'tools/list', {});
        await post(s, 1, 'tools/call', { name: 't', arguments: {} });
        await post(s, '1', 'tools/call', { name: 't', arguments: {} });
        assert.equal(new Set(seen).size, 2);
    }
    finally {
        await s.close();
        fs.rmSync(c.stateDir, { recursive: true, force: true });
    }
});
