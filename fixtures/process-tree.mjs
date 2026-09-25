#!/usr/bin/env node
// Offline cancellation fixture: the grandchild ignores SIGTERM and owns separate pipes.
import { spawn } from 'node:child_process';
const heartbeat = process.argv[2];
const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    let n = 0;
    fs.writeFileSync(process.argv[1], String(n));
    setInterval(() => fs.writeFileSync(process.argv[1], String(++n)), 10);
    console.log('READY');
`, heartbeat], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'fixture/child_ready', params: { pid: child.pid },
}) + '\n'));
setInterval(() => {}, 1000);
