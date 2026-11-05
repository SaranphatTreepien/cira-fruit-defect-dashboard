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

export async function GET() {
  let db: HealthState = 'offline';
  try {
    await pool.query('SELECT 1');
    db = 'online';
  } catch {
    db = 'offline';
  }

  const [mqttOnline, internetOnline] = await Promise.all([checkMqtt(), checkInternet()]);
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

  return NextResponse.json({ ...snapshot, checked_at: new Date().toISOString() });
}
