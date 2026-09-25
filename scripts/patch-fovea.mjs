import os from 'node:os';
import path from 'node:path';
import { checkedPatch } from './checked-patch.mjs';

const root = path.resolve(process.argv.slice(2).find(arg => arg !== '--check') || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'npm/node_modules/pi-fovea'));
checkedPatch({ root, packageName: 'pi-fovea', packageVersion: '0.31.1',
    manifestName: '.kiro-acp-freshness.json', metadata: { version: 1, foveaVersion: '0.31.1' },
    check: process.argv.includes('--check'), specs: [
        { name: 'src/core/ops.ts', sha256: '4a0fbd68b8597f0e704009c4bcd48df99f975f4d514d209681b9c521dcf48e95', edits: [
            // Explicit operations must observe filesystem changes even without Git,
            // turn-sync, or a recognized edit/write event. Reuse supplied snapshots.
            ['await ensureState(root)', 'await ensureState(root, { force: true })', 4],
        ] },
        { name: 'src/core/state.ts', sha256: '3ecd8445308694e9a4c643eff23efe535723ea77fc3fed5681ff85a86bfabd76', edits: [
            // A refresh that began before this request cannot satisfy newer hints
            // or a force request. Drain it, then probe again, still serialized.
            ['  if (pending) return pending;', '  if (pending) return opts.force || opts.hints?.length\n    ? pending.then(() => ensureState(root, opts))\n    : pending;'],
        ] },
    ],
});
console.log('Verified Fovea 0.31.1 explicit-operation freshness. Restart Pi to activate.');
