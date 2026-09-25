import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, fallbackExtractors, prefixLength, hashPrefixLength, projectMessage } from '../src/context/snapshot.js';
import { canonical, hash } from '../src/util.js';
import { defaults, parseConfig } from '../src/config.js';
import { Catalog } from '../src/tools/catalog.js';
import { context } from './helpers.js';
test('canonical JSON is deterministic and prototype-safe', () => {
    assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
    assert.equal(canonical(JSON.parse('{"__proto__":{"polluted":true}}')), '{"__proto__":{"polluted":true}}');
    assert.equal({}.polluted, undefined);
});
test('cyclic and non-JSON data are rejected', () => {
    const x = {};
    x.x = x;
    assert.throws(() => hash(x), /Cyclic/);
    assert.throws(() => hash({ v: NaN }), /Non-JSON/);
});
test('system sections and tool removals are replayed in order', () => {
    const ctx = context();
    ctx.messages.push({ role: 'system', content: 'More', sections: { map: 'Fovea old' }, toolsAdded: [{ name: 'read', description: 'r', parameters: { type: 'object' } }] });
    ctx.messages.push({ role: 'system', content: '', sections: { map: 'Fovea new' }, toolsRemoved: [{ name: 'fabric_exec' }] });
    const s = snapshot(ctx);
    assert.match(s.system, /Fovea new/);
    assert.doesNotMatch(s.system, /Fovea old/);
    assert.deepEqual(s.tools.map(t => t.name), ['read']);
});
test('Fovea section changes invalidate instruction fingerprint', () => {
    const ctx = context(), a = snapshot(ctx);
    ctx.messages.push({ role: 'system', content: '', sections: { fovea: 'new code graph' } });
    assert.notEqual(a.systemHash, snapshot(ctx).systemHash);
});
test('toolChoice none genuinely removes the tool surface', () => assert.equal(snapshot(context(), fallbackExtractors, true).tools.length, 0));
test('transcript fingerprints ignore bookkeeping but preserve actual content', () => {
    const a = { role: 'assistant', content: [{ type: 'text', text: 'same' }], timestamp: 1, usage: { input: 1 } }, b = { ...a, timestamp: 2, usage: { input: 100 } };
    assert.equal(hash(projectMessage(a)), hash(projectMessage(b)));
    assert.notEqual(hash(projectMessage(a)), hash(projectMessage({ ...a, content: [{ type: 'text', text: 'different' }] })));
});
test('prefix detection finds history rewrites of identical length', () => {
    assert.equal(prefixLength([{ role: 'user', content: 'a' }], [{ role: 'user', content: 'b' }]), 0);
});
test('precomputed prefix hashes preserve rewrite and append detection', () => {
    const ctx = context('first'), a = snapshot(ctx);
    ctx.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] });
    const b = snapshot(ctx);
    assert.equal(hashPrefixLength(a.hashes, b.hashes), a.messages.length);
    ctx.messages[1] = { role: 'user', content: 'rewritten' };
    const c = snapshot(ctx);
    assert.equal(hashPrefixLength(b.hashes, c.hashes), 0);
    assert.equal(a.hash, hash({ system: a.system, tools: a.tools, messages: a.messages }));
    assert.deepEqual(a.hashes, a.messages.map(hash));
});
test('images are refused, not silently dropped', () => {
    const ctx = context();
    ctx.messages.push({ role: 'user', content: [{ type: 'image', data: 'aA==', mimeType: 'image/png' }] });
    assert.throws(() => snapshot(ctx), /Unsupported transcript block/);
});
test('context byte ceiling is enforced before transmission', () => assert.throws(() => snapshot(context(), fallbackExtractors, false, 30), /byte ceiling/));
test('required constrained decoding is not falsely advertised', () => {
    const ctx = context();
    ctx.tools = [{ name: 'strict', description: 'strict', parameters: { type: 'object' }, constrainedSampling: { type: 'json_schema', strict: 'require' } }];
    assert.throws(() => snapshot(ctx), /constrained/);
});
test('catalog aliases are stable and hidden tools are absent', () => {
    const a = new Catalog([{ name: 'a.strange/tool', description: 'x', parameters: { type: 'object' } }]);
    const b = new Catalog([{ name: 'a.strange/tool', description: 'x', parameters: { type: 'object' } }]);
    assert.equal(a.tools[0].name, b.tools[0].name);
    assert.throws(() => a.resolve('shell'), /not present/);
    assert.equal(a.resolve(a.tools[0].name).name, 'a.strange/tool');
});
test('configuration rejects unknown privilege fields and wrong value types', () => {
    assert.throws(() => parseConfig({ nativeTools: true }), /Unknown/);
    assert.throws(() => parseConfig({ compatibility: { allowUnverified: 'yes' } }), /boolean/);
    assert.throws(() => parseConfig({ admission: { maxActive: 0 } }), /integer/);
    assert.equal(parseConfig({}).compatibility.allowUnverified, false);
    assert.equal(parseConfig({}).client.name, 'kirocrew');
    assert.equal(parseConfig({ client: { name: 'kirocrew' } }).client.name, 'kirocrew');
    assert.equal(parseConfig({ client: { name: 'pi' } }).client.name, 'pi');
    assert.throws(() => parseConfig({ client: { name: 'unknown-client' } }), /client.name/);
    assert.throws(() => parseConfig({ client: { version: '1.0.0' } }), /Unknown client.version/);
});
test('limits are adapter ceilings, not invented vendor model metadata', () => {
    const c = defaults();
    assert.equal(c.models.plannerId, null);
    assert.equal(c.models.workerId, 'auto');
});
//# sourceMappingURL=context.test.js.map