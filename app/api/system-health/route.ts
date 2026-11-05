import net from 'node:net';
import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';

type HealthState = 'online' | 'offline' | 'unknown';
type HealthSnapshot = {
  db: HealthState;
  mqtt: HealthState;
  internet: HealthState;
};

let lastSnapshot: HealthSnapshot | null = null;

function checkMqtt(): Promise<boolean> {
  const host = process.env.MQTT_HOST || '127.0.0.1';
  const port = Number(process.env.MQTT_PORT || 1883);

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function checkInternet(): Promise<boolean> {
  const url = process.env.HEALTHCHECK_URL || 'https://www.google.com/generate_204';
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function writeTransitions(snapshot: HealthSnapshot) {
  if (!lastSnapshot) {
    lastSnapshot = snapshot;
    for (const key of Object.keys(snapshot) as (keyof HealthSnapshot)[]) {
      await pool.query(
        'INSERT INTO system_logs (level, source, message) VALUES ($1, $2, $3)',
        [snapshot[key] === 'online' ? 'info' : 'warning', `system_health.${key}`, `สถานะเริ่มต้น ${key}: ${snapshot[key]}`],
      );
    }
    return;
  }

  const transitions = (Object.keys(snapshot) as (keyof HealthSnapshot)[])
    .filter((key) => snapshot[key] !== lastSnapshot?.[key])
    .map((key) => ({
      source: `system_health.${key}`,
      message: `สถานะ ${key} เปลี่ยนจาก ${lastSnapshot?.[key]} เป็น ${snapshot[key]}`,
      level: snapshot[key] === 'online' ? 'info' : 'warning',
    }));

  lastSnapshot = snapshot;
  for (const transition of transitions) {
    await pool.query(
      'INSERT INTO system_logs (level, source, message) VALUES ($1, $2, $3)',
      [transition.level, transition.source, transition.message],
    );
  }
}

// Several pages poll this endpoint. Cache the whole snapshot briefly and the slow Internet probe
// longer, and share one in-flight check, so polling never stacks up network calls.
const SNAPSHOT_TTL_MS = 3000;
const INTERNET_TTL_MS = 15000;
let cached: { at: number; body: HealthSnapshot & { checked_at: string } } | null = null;
let inflight: Promise<HealthSnapshot & { checked_at: string }> | null = null;
let internetCache: { at: number; ok: boolean } | null = null;

async function internetCached(): Promise<boolean> {
  if (internetCache && Date.now() - internetCache.at < INTERNET_TTL_MS) return internetCache.ok;
  const ok = await checkInternet();
  internetCache = { at: Date.now(), ok };
  return ok;
}

export async function GET() {
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return NextResponse.json(cached.body);
  inflight ??= check().finally(() => { inflight = null; });
  const body = await inflight;
  cached = { at: Date.now(), body };
  return NextResponse.json(body);
}

async function check() {
  let db: HealthState = 'offline';
  try {
    await pool.query('SELECT 1');
    db = 'online';
  } catch {
    db = 'offline';
  }

  const [mqttOnline, internetOnline] = await Promise.all([checkMqtt(), internetCached()]);
  const snapshot: HealthSnapshot = {
    db,
    mqtt: mqttOnline ? 'online' : 'offline',
    internet: internetOnline ? 'online' : 'offline',
  };

  if (db === 'online') {
    try {
      await writeTransitions(snapshot);
    } catch (error) {
      console.error('Failed to write system health transition', error);
    }
  }

  return { ...snapshot, checked_at: new Date().toISOString() };
}
