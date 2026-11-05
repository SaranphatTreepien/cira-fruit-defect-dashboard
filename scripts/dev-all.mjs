// Start the dashboard together with scripts/alert_watcher.py and scripts/telegram_bot.py
// (used by `npm run dev` / `npm run start`).
//   node scripts/dev-all.mjs dev     -> next dev   + alert_watcher
//   node scripts/dev-all.mjs start   -> next start + alert_watcher
// The watcher is restarted if it exits. Only one watcher works at a time (PostgreSQL advisory lock),
// so a watcher already running in another terminal is fine: this one waits as a standby.
// The bot works the same way (its own lock). Set PYTHON to choose the interpreter (default: python),
// NO_WATCHER=1 / NO_BOT=1 to skip one.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const python = process.env.PYTHON || 'python';
const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const children = new Set();
let stopping = false;

function prefix(name, stream, out) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  });
}

function run(name, command, args, onExit) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '1' } });
  children.add(child);
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr);
  child.on('error', (error) => console.error(`[${name}] failed to start: ${error.message}`));
  child.on('exit', (code) => { children.delete(child); onExit?.(code); });
  return child;
}

function startPython(name, script) {
  run(name, python, ['-u', path.join('scripts', script)], (code) => {
    if (stopping) return;
    console.error(`[${name}] exited (code ${code}) · restarting in 5 s`);
    setTimeout(() => { if (!stopping) startPython(name, script); }, 5000);
  });
}

run('web', process.execPath, [nextBin, mode, '-H', '0.0.0.0', '-p', process.env.PORT || '3000'], (code) => {
  if (!stopping) { console.error(`[web] exited (code ${code})`); shutdown(code ?? 1); }
});
if (process.env.NO_WATCHER !== '1') startPython('watcher', 'alert_watcher.py');
if (process.env.NO_BOT !== '1') startPython('bot', 'telegram_bot.py');

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    // On Windows kill the whole tree; elsewhere SIGINT lets the watcher record "watcher_stop".
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGINT');
  }
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
