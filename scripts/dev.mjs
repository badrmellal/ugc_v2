// Runs the API + worker and the Vite dev server together (cross-platform, no extra dependencies).
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = ['server', 'web'].map((workspace) =>
  spawn(npm, ['run', 'dev', '--workspace', workspace], { stdio: 'inherit', shell: process.platform === 'win32' }),
);

let exiting = false;
function stopAll(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}

for (const child of children) child.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
