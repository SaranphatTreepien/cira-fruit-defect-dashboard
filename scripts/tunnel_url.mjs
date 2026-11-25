// Prints the current public link of the cira-tunnel container (Cloudflare quick tunnel).
// The address changes every time the container starts, so read it from the container log.
import { spawnSync } from 'node:child_process';

const r = spawnSync('docker', ['logs', 'cira-tunnel'], { encoding: 'utf8' });
// cloudflared logs to stderr
const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
if (r.status !== 0) { console.error('cira-tunnel is not running: docker compose up -d tunnel'); process.exit(1); }
const urls = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
if (!urls) { console.error('No link yet (the tunnel may still be starting). Try again in a few seconds.'); process.exit(1); }
console.log(urls[urls.length - 1]);
