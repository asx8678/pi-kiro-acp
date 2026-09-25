import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const [fovea, phase] = process.argv.slice(2);
const pi = fs.realpathSync(execFileSync(process.platform === 'win32' ? 'where' : 'which', [process.env.PI_BIN || 'pi'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]);
const { createJiti } = createRequire(pi)('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const ops = await jiti.import(path.join(fovea, 'src/core/ops.ts'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-fovea-probe-'));
const roots = [];
try {
    for (const kind of phase === 'before' ? ['plain'] : ['plain', 'git']) {
        const root = path.join(temp, kind); roots.push(root); fs.mkdirSync(root);
        if (kind === 'git') execFileSync('git', ['init', '-q', root]);
        const fixture = path.join(root, 'fixture.ts');
        const write = value => fs.writeFileSync(fixture, `export const liveMarker = '${value}';\n`);
        write('BEFORE_HOST_EDIT');
        assert.match((await ops.focus(root, 'liveMarker', 512, { fresh: true })).text, /BEFORE_HOST_EDIT/);
        write('AFTER_HOST_EDIT');
        const after = await ops.focus(root, 'liveMarker', 512, { fresh: true });
        if (phase === 'before') { assert.match(after.text, /BEFORE_HOST_EDIT/); continue; }
        assert.match(after.text, /AFTER_HOST_EDIT/); assert.doesNotMatch(after.text, /BEFORE_HOST_EDIT/);
        write('SECOND_HOST_EDIT');
        assert.match((await ops.focus(root, 'liveMarker', 512)).text, /SECOND_HOST_EDIT/);
        const pending = ops.ensureState(root);
        write('DURING_REFRESH');
        const fresh = ops.ensureState(root, { force: true, hints: ['fixture.ts'] });
        assert.notStrictEqual(pending, fresh, 'new force/hints must not reuse the earlier snapshot');
        await Promise.all([pending, fresh]);
        assert.match((await ops.focus(root, 'liveMarker', 512, { fresh: true })).text, /DURING_REFRESH/);
        fs.writeFileSync(path.join(root, 'added.ts'), 'export function newlyAdded() {}\n');
        await ops.sketch(root, 512); assert.ok(ops.getState(root).files.includes('added.ts'));
        fs.unlinkSync(path.join(root, 'added.ts'));
        await ops.impact(root, { files: ['fixture.ts'], includeUncommitted: false, budget: 512 });
        assert.ok(!ops.getState(root).files.includes('added.ts'));
        const snapshot = await ops.ensureState(root, { force: true });
        write('AFTER_SNAPSHOT');
        assert.match((await ops.focus(root, 'liveMarker', 512, { fresh: true }, snapshot)).text, /DURING_REFRESH/);
        await ops.dwell(root, 2, 512);
        assert.match((await ops.focus(root, 'liveMarker', 512, { fresh: true })).text, /AFTER_SNAPSHOT/);
    }
    console.log(JSON.stringify({ check: 'real Fovea opaque same-run edits, adds/deletes, concurrent refresh, supplied snapshot', phase, roots: roots.length, result: phase === 'before' ? 'original bug reproduced' : 'passed' }));
} finally { for (const root of roots) ops.evictState(root); fs.rmSync(temp, { recursive: true, force: true }); }
