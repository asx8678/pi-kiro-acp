import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolSurfaceAudit } from '../src/kiro/tool-surface.js';
import { Catalog } from '../src/tools/catalog.js';
import type { Obj } from '../src/util.js';

const version = 'kiro-cli 2.24.0';
const catalog = () => new Catalog([{ name: 'bridge_probe', description: 'Inert tool', parameters: { type: 'object', properties: {} } }]);
const tagSnapshot = (tags: unknown[] = [{ tag: '@kirocrew-core/bridge_probe', source: 'mcp' }]): Obj => ({ sessionId: 'test-session', tags });
const catalogSnapshot = (changes: Obj = {}): Obj => ({ sessionId: 'test-session', servers: [{
    name: 'kirocrew-core', status: 'connected', tools: [{ name: 'bridge_probe', disabled: false }],
    _meta: { kiro: { resource: { source: { origin: 'client' } } } }, ...changes,
}] });
const audit = (v = version) => { const result = new ToolSurfaceAudit(catalog()); result.activate(v); return result; };
const tags = (a: ToolSurfaceAudit, value = tagSnapshot()) => a.observe('_kiro/tools/didChange', value);
const server = (a: ToolSurfaceAudit, value = catalogSnapshot()) => a.observe('_kiro/mcp/status', value);

test('Kiro 2.24 tag snapshot needs the matching client-origin connected catalog', () => {
    const a = audit();
    tags(a);
    assert.equal(a.confirm(), false);
    server(a);
    assert.equal(a.confirm(), true);
    assert.equal(a.status, 'reported-tags-and-catalog');
});
test('MCP readiness alone never qualifies a tool surface', () => {
    const a = audit();
    server(a);
    assert.equal(a.confirm(), false);
});
test('early catalogs survive activation but default-mode tool tags do not', () => {
    const a = new ToolSurfaceAudit(catalog());
    server(a);
    tags(a, tagSnapshot([{ tag: 'shell', source: 'builtin' }]));
    a.activate(version);
    assert.equal(a.confirm(), false);
    tags(a);
    assert.equal(a.confirm(), true);
});
test('tags cannot qualify an unrecognized CLI version', () => {
    const a = audit('kiro-cli 2.25.0');
    server(a);
    tags(a);
    assert.equal(a.confirm(), false);
});
test('native, foreign and unlisted tool tags are rejected after activation', () => {
    for (const tag of [{ tag: 'shell', source: 'builtin' }, { tag: '@foreign/write', source: 'mcp' }, { tag: '@kirocrew_host/bridge_probe', source: 'mcp' }, { tag: '@pi_host/bridge_probe', source: 'mcp' }, { tag: '@kirocrew-core/unlisted', source: 'mcp' }, { tag: '@kirocrew-core/bridge_probe', source: 'unknown' }])
        assert.throws(() => tags(audit(), tagSnapshot([tag])), /Unexpected tool/);
});
test('malformed, grouped and duplicate tool tags cannot qualify', () => {
    for (const values of [[{ tag: '@kirocrew-core/bridge_probe' }], [{ tag: '@kirocrew-core', source: 'mcp' }], [null], [{ tag: '@kirocrew-core/bridge_probe', source: 'mcp' }, { tag: '@kirocrew-core/bridge_probe', source: 'mcp' }]])
        assert.throws(() => tags(audit(), tagSnapshot(values)), /Malformed|Unexpected|Duplicate/);
});
test('missing tags do not become an empty, verified inventory', () => {
    assert.throws(() => tags(audit(), { sessionId: 'test-session' }), /Missing Kiro tool tag/);
});
test('foreign or missing catalog provenance cannot qualify a same-named server', () => {
    for (const meta of [undefined, { kiro: { resource: { source: { origin: 'user' } } } }]) {
        const a = audit();
        server(a, catalogSnapshot({ _meta: meta }));
        tags(a);
        assert.equal(a.confirm(), false);
    }
});
test('missing and disabled expected tools cannot qualify', () => {
    for (const tools of [[], [{ name: 'bridge_probe', disabled: true }]]) {
        const a = audit();
        server(a, catalogSnapshot({ tools }));
        tags(a);
        assert.equal(a.confirm(), false);
    }
});
test('unexpected, malformed and duplicate MCP catalog entries are rejected', () => {
    for (const tools of [[{ name: 'unlisted', disabled: false }], [{ name: 'bridge_probe' }], [{ name: 'bridge_probe', disabled: false }, { name: 'bridge_probe', disabled: false }], [{ name: 'bridge_probe', disabled: false }, { name: 'bridge_probe', disabled: true }]])
        assert.throws(() => server(audit(), catalogSnapshot({ tools })), /Unexpected|Malformed|Duplicate/);
});
test('malformed MCP snapshots cannot preserve verified catalog evidence', () => {
    for (const value of [{}, { servers: null }, { servers: {} }]) {
        const a = audit();
        server(a);
        tags(a);
        assert.equal(a.confirm(), true);
        assert.throws(() => server(a, value), /Malformed MCP server inventory/);
    }
});
test('MCP authentication and startup failures stop verification', () => {
    assert.throws(() => server(audit(), catalogSnapshot({ failedAuthorization: true })), /authorize/);
    assert.throws(() => server(audit(), catalogSnapshot({ status: 'failed' })), /initialize/);
});
test('tool removal, reconnect and lost provenance invalidate a confirmed surface', () => {
    for (const change of [(a: ToolSurfaceAudit) => tags(a, tagSnapshot([])), (a: ToolSurfaceAudit) => server(a, catalogSnapshot({ status: 'connecting' })), (a: ToolSurfaceAudit) => server(a, catalogSnapshot({ _meta: undefined })), (a: ToolSurfaceAudit) => server(a, { servers: [] })]) {
        const a = audit();
        server(a);
        tags(a);
        assert.equal(a.confirm(), true);
        assert.throws(() => change(a), /changed after verification/);
    }
});
test('reconnect requires fresh tags as well as a new catalog', () => {
    const a = audit();
    server(a);
    tags(a);
    server(a, catalogSnapshot({ status: 'connecting' }));
    server(a);
    assert.equal(a.confirm(), false);
    tags(a);
    assert.equal(a.confirm(), true);
});
test('tool-less mode requires an explicit empty activation-era tag snapshot', () => {
    const a = new ToolSurfaceAudit(new Catalog([]));
    a.activate(version);
    assert.equal(a.confirm(), false);
    tags(a, tagSnapshot([]));
    assert.equal(a.confirm(), true);
});
test('legacy complete tool snapshots remain supported', () => {
    const a = audit('mock-kiro 0.1.0');
    a.observe('_kiro/tools/didChange', { tools: [{ name: 'mcp__kirocrew-core__bridge_probe' }] });
    assert.equal(a.confirm(), true);
    assert.equal(a.status, 'reported-exact');
    assert.throws(() => a.observe('_kiro/tools/didChange', { tools: ['shell'] }), /Unexpected tool/);
});
test('legacy incomplete snapshots fail explicitly', () => {
    const a = audit();
    a.observe('_kiro/tools/didChange', { tools: [] });
    assert.throws(() => a.confirm(), /missing an active Pi tool/);
});
test('a new tag report replaces legacy tool evidence instead of retaining it', () => {
    for (const v of [version, 'kiro-cli 2.25.0']) {
        const a = audit(v);
        a.observe('_kiro/tools/didChange', { tools: ['bridge_probe'] });
        assert.equal(a.confirm(), true);
        assert.throws(() => tags(a, tagSnapshot([])), /changed after verification/);
        assert.equal(a.ready(), false);
    }
});
