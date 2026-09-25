// Offline inspection fixture with a separately observable, TERM-resistant descendant.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [dir, mode] = process.argv.slice(2), marker = `${dir}/heartbeat-${process.pid}`;
const child = spawn(process.execPath, ['-e', `
  const fs = require('node:fs');
  process.on('SIGTERM', () => {});
  let n = 0; fs.writeFileSync(process.argv[1], String(n));
  setInterval(() => fs.writeFileSync(process.argv[1], String(++n)), 10);
  console.log('READY');
`, marker], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => {
  fs.appendFileSync(dir + '/inspect-pids.jsonl', JSON.stringify({ parent: process.pid, child: child.pid, marker }) + '\n');
  if (mode === 'parent-exit') process.stdout.write(process.argv.includes('--version') ? 'mock-kiro 0.1.0\n' : 'acp --agent-engine --auth-method\n', () => process.exit(0));
  if (mode === 'oversized') process.stdout.write('x'.repeat(131073));
});
setInterval(() => {}, 1000);
