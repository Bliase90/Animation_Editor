// Runs the bridge and the Vite dev server together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['bridge/server.mjs'], { stdio: 'inherit' }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
