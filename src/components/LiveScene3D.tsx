'use client';

// 3D view of the Live sorting line (react-three-fiber). It only draws: which fruit is on the belt, when it
// started and when it lands all come from SimulateView's replay engine (DB events), same as the 2D scene.
// Every model here (fruit, crates, AGV, trees, siren) is built procedurally in code: no external assets.
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid, Html, OrbitControls, PerformanceMonitor, RoundedBox, Stars } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Moon, Sun, Sunrise, Sunset, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

type Kind = 'good' | 'defect';
export type Fruit3D = {
  id: string; kind: Kind; fruit: string | null; count: number; conf: number | null;
  defectType: string | null; track: number | null; spawnedAt: number;
  model?: string | null; ts?: string | null;
  seed?: boolean; // filler fruit drawn from the window totals (no event behind it)
};

type Props = {
  tokens: Fruit3D[];
  travelMs: number;
  playing: boolean;
  paddleKey: number;
  modelKey: number;
  powerKey: number;
  alert: 'warning' | 'critical' | null;
  seed: { good: number; defect: number; fruits: string[] };
  tv: boolean;
  // counts shown on the crate labels (already "totals - in flight" from SimulateView)
  bins: { good: number; defect: number; lastGood: string | null; lastDefect: string | null; hitGood: number; hitDefect: number };
  stats: { epm: number; defectRate: string; spark: { n: number; defect: number }[] };
  // crate panel (window totals from /api/live) and the KPI wall board
  crates: { windowLabel: string; byFruit: { fruit_type: string; good: number; defect: number; total: number }[]; byDefect: { defect_type: string; n: number }[] };
  kpi: { total: number; good: number; defect: number; defectRate: string; epm: number; model: string | null; device: string | null; state: string; playing: boolean; windowLabel: string };
  system: { db: string; mqtt: string; internet: string; heartbeatAge: number | null; ingestAvg: number | null; ingestMax: number | null; dbToScreen: number | null; lastEventAgo: number | null };
  // web pause / resume gate (the only control the dashboard has; admin only, confirmed in SimulateView)
  control: { device: string | null; known: boolean; paused: boolean; waiting: boolean; busy: boolean; err: string; isAdmin: boolean;
    machine: 'loading' | 'running' | 'paused' | 'stopped'; send: (run: boolean) => void };
};

// ---- Graphics quality ---------------------------------------------------------------------------
// One fixed level ("mid"); it only steps down to "low" by itself when the frame rate drops.
export type Quality = 'low' | 'mid' | 'high';
const QUALITY: Record<Quality, { label: string; shadows: boolean; shadowSize: number; bloom: boolean; dpr: number; smoke: number; burst: number; stars: number; waveLight: boolean }> = {
  low: { label: 'ต่ำ', shadows: false, shadowSize: 512, bloom: false, dpr: 1, smoke: 0, burst: 5, stars: 0, waveLight: false },
  mid: { label: 'กลาง', shadows: true, shadowSize: 1024, bloom: true, dpr: 1.25, smoke: 3, burst: 9, stars: 500, waveLight: true },
  high: { label: 'สูง', shadows: true, shadowSize: 2048, bloom: true, dpr: 1.75, smoke: 6, burst: 14, stars: 1400, waveLight: true },
};
type Q = (typeof QUALITY)[Quality];

// ---- Line layout (world units) -------------------------------------------------------------
const BELT_Y = 0.75;
const FRUIT_R = 0.22;
const FRUIT_Y = BELT_Y + FRUIT_R + 0.02;
const START = new THREE.Vector3(-11, FRUIT_Y, 0);
const CAM = new THREE.Vector3(-5, FRUIT_Y, 0);
const FORK = new THREE.Vector3(0, FRUIT_Y, 0);
const END = { good: new THREE.Vector3(7.2, FRUIT_Y, -3.4), defect: new THREE.Vector3(7.2, FRUIT_Y, 3.4) };
const dirOf = (kind: Kind) => END[kind].clone().sub(FORK).setY(0).normalize();
const CRATE = {
  good: END.good.clone().add(dirOf('good').multiplyScalar(1.35)).setY(0),
  defect: END.defect.clone().add(dirOf('defect').multiplyScalar(1.35)).setY(0),
};
const crateAngle = (kind: Kind) => { const d = dirOf(kind); return -Math.atan2(d.z, d.x); };
const CRATE_FLOOR = 0.08;
// 5 along the branch x 3 across, two layers = 30 fruit per crate (spacing keeps every fruit inside the slats)
const PILE_COLS = 5; const PILE_ROWS = 3; const PILE_LAYER = PILE_COLS * PILE_ROWS;
const PILE_MAX = PILE_LAYER * 2;
const KINDS: Kind[] = ['good', 'defect'];

// Timeline of one fruit, as a share of travelMs: 0-.16 to the gantry, .16-.36 slowly through it (scanned in
// the middle, SCAN), .36-.5 to the fork, .5-.9 along its branch, .9-1 drops into the crate. Fruit never stop,
// so several on the line do not pile up under the camera. The paddle kicks at .47 (SimulateView).
const SCAN = [0.22, 0.3] as const;
const VERDICT = [0.46, 0.6] as const;
const GATE_IN = new THREE.Vector3(CAM.x - 1, FRUIT_Y, 0);
const GATE_OUT = new THREE.Vector3(CAM.x + 1, FRUIT_Y, 0);
// Feed: each fruit comes out from under the elevator hood and rolls down a short chute onto the belt (START).
const CHUTE_TOP = new THREE.Vector3(-12.0, 1.45, 0);
const FEED_P = 0.035;
function fruitPos(p: number, kind: Kind, target: THREE.Vector3, out: THREE.Vector3) {
  if (p < FEED_P) { const t = p / FEED_P; return out.lerpVectors(CHUTE_TOP, START, t * t * 0.6 + t * 0.4); }
  if (p < 0.16) return out.lerpVectors(START, GATE_IN, (p - FEED_P) / (0.16 - FEED_P));
  if (p < 0.36) return out.lerpVectors(GATE_IN, GATE_OUT, (p - 0.16) / 0.2);
  if (p < 0.5) return out.lerpVectors(GATE_OUT, FORK, easeIn((p - 0.36) / 0.14));
  if (p < 0.9) return out.lerpVectors(FORK, END[kind], (p - 0.5) / 0.4);
  const k = Math.min(1, (p - 0.9) / 0.1);
  out.lerpVectors(END[kind], target, k);
  out.y = THREE.MathUtils.lerp(FRUIT_Y, target.y, k) + Math.sin(Math.PI * k) * 0.9;
  return out;
}
const easeIn = (t: number) => t * t * 0.4 + t * 0.6;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

const FRUIT_COLOR: Record<string, string> = { apple: '#d22f27', orange: '#f59a1c', banana: '#f2d23c' };
const FRUIT_TH: Record<string, string> = { apple: 'แอปเปิล', orange: 'ส้ม', banana: 'กล้วย' };
const DEFECT_TH: Record<string, string> = { rot: 'เน่า', bruise: 'ช้ำ', crack: 'แตก' };

// Stable pseudo-random from a string (pile layout must not jump between renders).
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function pileSlot(kind: Kind, index: number, id: string) {
  const layer = Math.floor(index / PILE_LAYER) % 2;
  const i = index % PILE_LAYER;
  const col = i % PILE_COLS; const row = Math.floor(i / PILE_COLS);
  const base = CRATE[kind];
  const dir = dirOf(kind); const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const ja = (hash(id) - 0.5) * 0.03; const jb = (hash(`${id}j`) - 0.5) * 0.03;
  // the top layer sits a little shifted into the dips of the bottom one; both stay inside the crate walls
  return base.clone()
    .add(dir.clone().multiplyScalar((col - (PILE_COLS - 1) / 2) * 0.37 + (layer ? 0.05 : 0) + ja))
    .add(side.multiplyScalar((row - (PILE_ROWS - 1) / 2) * 0.43 - (layer ? 0.05 : 0) + jb))
    .setY(CRATE_FLOOR + FRUIT_R + layer * 0.38);
}

// ---- Time of day (Bangkok) -----------------------------------------------------------------------
function bangkokHour() {
  try {
    const override = Number(new URLSearchParams(window.location.search).get('hour'));
    if (override >= 0 && override < 24 && window.location.search.includes('hour=')) return override;
  } catch { /* no window */ }
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') + get('minute') / 60;
}
// hour, sky, hemi sky, hemi ground, hemi intensity, sun color, sun intensity, night (0..1)
const DAY_KEYS: [number, string, string, string, number, string, number, number][] = [
  [0, '#0b1724', '#6a80b4', '#101a2a', 0.6, '#a9bbff', 0.75, 1],
  [5, '#0b1724', '#6a80b4', '#101a2a', 0.6, '#a9bbff', 0.75, 1],
  [6.5, '#f1cba6', '#ffd6ad', '#a89682', 0.75, '#ffb878', 1.5, 0.35],
  [8, '#e7f1eb', '#ffffff', '#cfe3d6', 1.1, '#fff6e8', 2.6, 0],
  [16, '#e7f1eb', '#ffffff', '#cfe3d6', 1.1, '#fff6e8', 2.6, 0],
  [18, '#f6b98c', '#ffc893', '#9a7a66', 0.8, '#ff9446', 1.9, 0.25],
  [19.5, '#2b2442', '#8a7ab0', '#19142a', 0.45, '#ff8a5a', 0.65, 0.75],
  [21, '#0b1724', '#6a80b4', '#101a2a', 0.6, '#a9bbff', 0.75, 1],
  [24, '#0b1724', '#6a80b4', '#101a2a', 0.6, '#a9bbff', 0.75, 1],
];
type Env = { sky: string; hemiSky: string; hemiGround: string; hemiI: number; sun: string; sunI: number; night: number;
  ground: string; grass: string; road: string; cell: string; section: string; sunPos: [number, number, number]; label: string; icon: 'sun' | 'rise' | 'set' | 'moon'; clock: string };
const mix = (a: string, b: string, t: number) => `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;
function envAt(hour: number, tv: boolean): Env {
  let i = 0;
  while (i < DAY_KEYS.length - 2 && hour >= DAY_KEYS[i + 1][0]) i++;
  const a = DAY_KEYS[i]; const b = DAY_KEYS[i + 1];
  const t = clamp01((hour - a[0]) / (b[0] - a[0]));
  let night = THREE.MathUtils.lerp(a[7], b[7], t);
  let sky = mix(a[1], b[1], t);
  let ground = mix('#eef5f0', '#111c22', night);
  let grass = mix('#a8cf8a', '#12221a', night);
  let hemiI = THREE.MathUtils.lerp(a[4], b[4], t);
  if (tv) { sky = mix(sky, '#07130f', 0.6); ground = mix(ground, '#0b1914', 0.6); grass = mix(grass, '#0b1914', 0.6); night = Math.max(night, 0.4); hemiI *= 0.75; }
  const dayT = clamp01((hour - 6) / 12);
  const isDay = hour >= 6 && hour <= 18.5;
  const ang = dayT * Math.PI;
  const sunPos: [number, number, number] = isDay ? [-Math.cos(ang) * 13, Math.max(3, Math.sin(ang) * 13), 7] : [6, 12, -5];
  const label = hour < 5 ? 'กลางคืน' : hour < 6.5 ? 'เช้ามืด' : hour < 8 ? 'เช้า' : hour < 11 ? 'สาย' : hour < 13 ? 'เที่ยง' : hour < 16 ? 'บ่าย' : hour < 18.5 ? 'เย็น' : hour < 19.5 ? 'พลบค่ำ' : 'กลางคืน';
  const icon = hour < 5 || hour >= 19.5 ? 'moon' : hour < 8 ? 'rise' : hour < 16 ? 'sun' : 'set';
  const hh = Math.floor(hour); const mm = Math.floor((hour - hh) * 60);
  return {
    sky, hemiSky: mix(a[2], b[2], t), hemiGround: mix(a[3], b[3], t), hemiI,
    sun: mix(a[5], b[5], t), sunI: THREE.MathUtils.lerp(a[6], b[6], t), night, ground, grass, road: mix('#cfae84', '#2a241c', Math.max(night, tv ? 0.5 : 0)),
    cell: mix('#d3e4d9', '#1d3a30', night), section: mix('#b7d6c3', '#2c6b55', night), sunPos, label, icon,
    clock: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
  };
}

// ---- Shared geometry / materials (one copy for every fruit on the line and in the crates) ---------------
const APPLE_PROFILE: [number, number][] = [[0.001, -0.17], [0.05, -0.19], [0.12, -0.18], [0.18, -0.12], [0.215, -0.03], [0.22, 0.05], [0.195, 0.13], [0.14, 0.185], [0.075, 0.195], [0.03, 0.16], [0.001, 0.14]];
function makeGeo() {
  const apple = new THREE.LatheGeometry(APPLE_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 16);
  const orange = new THREE.IcosahedronGeometry(FRUIT_R, 3);
  const p = orange.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + (hash(`${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`) - 0.5) * 0.07;
    v.multiplyScalar(n); v.y *= 0.95;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  orange.computeVertexNormals();
  // crack: a zigzag of short segments lying on the sphere surface (front side, +z)
  const crackPts: [number, number][][] = [[[-0.13, 0.05], [-0.07, 0.0], [-0.02, 0.06], [0.04, 0.0], [0.1, 0.04], [0.14, -0.02]], [[-0.02, 0.06], [0.0, 0.13]], [[0.04, 0.0], [0.07, -0.08]]];
  const crack: { pos: THREE.Vector3; quat: THREE.Quaternion; len: number }[] = [];
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (const line of crackPts) for (let i = 0; i < line.length - 1; i++) {
    const [x1, y1] = line[i]; const [x2, y2] = line[i + 1];
    const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
    const r = FRUIT_R * 1.005;
    const pos = new THREE.Vector3(mx, my, Math.sqrt(Math.max(0, r * r - mx * mx - my * my)));
    const quat = new THREE.Quaternion().setFromUnitVectors(zAxis, pos.clone().normalize())
      .multiply(new THREE.Quaternion().setFromAxisAngle(zAxis, Math.atan2(y2 - y1, x2 - x1)));
    crack.push({ pos, quat, len: Math.hypot(x2 - x1, y2 - y1) + 0.012 });
  }
  return {
    apple, orange, generic: new THREE.SphereGeometry(FRUIT_R, 16, 12),
    stem: new THREE.CylinderGeometry(0.012, 0.02, 0.09, 5),
    leaf: new THREE.OctahedronGeometry(0.06, 0),
    calyx: new THREE.CylinderGeometry(0.035, 0.05, 0.025, 6),
    blob: new THREE.SphereGeometry(1, 12, 9),
    box: new THREE.BoxGeometry(1, 1, 1),
    rim: new THREE.SphereGeometry(FRUIT_R * 1.25, 20, 14),
    hit: new THREE.SphereGeometry(0.48, 8, 6),
    puff: new THREE.IcosahedronGeometry(0.06, 0),
    ring: new THREE.TorusGeometry(0.34, 0.025, 6, 32),
    crack,
  };
}
let GEO: ReturnType<typeof makeGeo> | null = null;
const geo = () => (GEO ??= makeGeo());
const MATS = new Map<string, THREE.Material>();
function mat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = MATS.get(key) as T | undefined;
  if (!m) { m = make(); MATS.set(key, m); }
  return m;
}
const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => mat(`std:${color}:${JSON.stringify(extra)}`, () => new THREE.MeshStandardMaterial({ color, ...extra }));
const hitMat = () => mat('hit', () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));

// ---- Fruit ----------------------------------------------------------------------------------
function Defect({ type }: { type: string }) {
  const g = geo();
  if (type === 'crack') return <group>
    {g.crack.map((s, i) => <mesh key={i} geometry={g.box} position={s.pos} quaternion={s.quat} scale={[s.len, 0.016, 0.02]} material={std('#1a110b', { roughness: 1 })} />)}
    {g.crack.map((s, i) => <mesh key={`h${i}`} geometry={g.box} position={s.pos} quaternion={s.quat} scale={[s.len, 0.034, 0.008]} material={std('#e9d7b0', { roughness: 1 })} />)}
  </group>;
  if (type === 'bruise') return <group position={[0.03, 0.01, 0]}>
    <mesh geometry={g.blob} position={[0, 0, FRUIT_R * 0.9]} scale={[0.13, 0.12, 0.05]} material={mat('bruise-o', () => new THREE.MeshStandardMaterial({ color: '#6a3b55', transparent: true, opacity: 0.45, depthWrite: false, roughness: 1 }))} />
    <mesh geometry={g.blob} position={[0, 0, FRUIT_R * 0.93]} scale={[0.08, 0.072, 0.04]} material={mat('bruise-i', () => new THREE.MeshStandardMaterial({ color: '#46223a', transparent: true, opacity: 0.7, depthWrite: false, roughness: 1 }))} />
  </group>;
  // rot (and any other defect): dark sunken patch with a brown halo and a few mould specks
  return <group position={[0.04, 0.02, 0]}>
    <mesh geometry={g.blob} position={[0, 0, FRUIT_R * 0.86]} scale={[0.15, 0.14, 0.06]} material={std('#5b3a1a', { roughness: 1 })} />
    <mesh geometry={g.blob} position={[0, 0, FRUIT_R * 0.9]} scale={[0.1, 0.095, 0.05]} material={std('#24160b', { roughness: 1 })} />
    {[[-0.04, 0.03], [0.03, -0.035], [0.05, 0.04]].map(([x, y], i) => <mesh key={i} geometry={g.blob} position={[x, y, FRUIT_R * 0.97]} scale={0.014} material={std('#d8dcc0', { roughness: 1 })} />)}
  </group>;
}

function FruitBody({ fruit, defectType, seed }: { fruit: string | null; defectType: string | null; seed: string }) {
  const g = geo();
  const color = (fruit && FRUIT_COLOR[fruit]) || '#9cc24a';
  const apple = fruit === 'apple'; const orange = fruit === 'orange';
  const body = apple ? g.apple : orange ? g.orange : g.generic;
  const tilt = hash(seed) * Math.PI * 2;
  const shade = (hash(`${seed}s`) - 0.5) * 0.12;
  const tone = `#${new THREE.Color(color).offsetHSL(0, 0, shade).getHexString()}`;
  return <group rotation={[0, tilt, 0]}>
    <mesh castShadow geometry={body} material={std(tone, { roughness: apple ? 0.4 : 0.72, flatShading: true })} />
    {apple && <>
      <mesh geometry={g.stem} position={[0, 0.19, 0]} rotation={[0, 0, 0.2]} material={std('#5b3a1e')} />
      <mesh geometry={g.leaf} position={[0.055, 0.215, 0]} rotation={[0, 0, -0.9]} scale={[1, 0.25, 0.55]} material={std('#3e9b3a', { flatShading: true })} />
    </>}
    {orange && <>
      <mesh geometry={g.calyx} position={[0, FRUIT_R * 0.94, 0]} material={std('#5f8a2e', { flatShading: true })} />
      <mesh geometry={g.leaf} position={[0.05, FRUIT_R * 0.98, 0.02]} rotation={[0.3, 0, -1.1]} scale={[1.1, 0.22, 0.5]} material={std('#3e9b3a', { flatShading: true })} />
    </>}
    {!apple && !orange && <mesh geometry={g.stem} position={[0, FRUIT_R * 0.95, 0]} material={std('#5b3a1e')} />}
    {/* tilted up so the mark reads from the usual camera angles (and on top of the crate piles) */}
    {defectType && <group rotation={[-0.7, 0, 0]}><Defect type={defectType} /></group>}
  </group>;
}

// Faint smoke above rotting fruit (moving fruit only, count from the quality setting).
function Smoke({ count }: { count: number }) {
  const group = useRef<THREE.Group>(null);
  const mats = useMemo(() => Array.from({ length: count }, () => new THREE.MeshBasicMaterial({ color: '#8a8270', transparent: true, opacity: 0, depthWrite: false })), [count]);
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats]);
  useFrame(({ clock }) => {
    group.current?.children.forEach((child, i) => {
      const t = (clock.elapsedTime * 0.55 + i / count) % 1;
      child.position.set(Math.sin(i * 2.1 + t * 3) * 0.08, FRUIT_R * 0.7 + t * 0.7, Math.cos(i * 1.7 + t * 2) * 0.08);
      child.scale.setScalar(0.6 + t * 1.6);
      mats[i].opacity = Math.sin(t * Math.PI) * 0.32;
    });
  });
  return <group ref={group}>{mats.map((m, i) => <mesh key={i} geometry={geo().puff} material={m} />)}</group>;
}

type ScanState = { active: number; x: number; defect: boolean; flash: number; flashDefect: boolean };

function MovingFruit({ token, travelMs, pileTarget, selected, onPick, registry, q, reduced }: {
  token: Fruit3D; travelMs: number; pileTarget: THREE.Vector3; selected: boolean; onPick: (t: Fruit3D) => void;
  registry: React.MutableRefObject<Map<string, THREE.Vector3>>; q: Q; reduced: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  const roll = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const gl = useThree((s) => s.gl);
  const [stage, setStage] = useState<'move' | 'scan' | 'verdict' | 'go'>('move');
  const stageRef = useRef(stage);
  const rim = useMemo(() => new THREE.MeshBasicMaterial({ color: '#33f0d0', transparent: true, opacity: 0, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), []);
  useEffect(() => () => rim.dispose(), [rim]);
  useEffect(() => {
    registry.current.set(token.id, pos);
    const map = registry.current;
    return () => { map.delete(token.id); gl.domElement.style.cursor = ''; };
  }, [registry, token.id, pos, gl]);
  useFrame(({ clock }) => {
    const p = Math.min(1, (Date.now() - token.spawnedAt) / travelMs);
    fruitPos(p, token.kind, pileTarget, pos);
    const g = ref.current;
    if (g) { g.position.copy(pos); g.visible = p > 0.005; }
    if (roll.current) { roll.current.rotation.z = -pos.x / FRUIT_R * 0.5; roll.current.rotation.x = pos.z / FRUIT_R * 0.5; }
    // rim glow: cyan while the camera scans, then a red (defect) or green (good) flash right after
    const t = clock.elapsedTime;
    if (p >= SCAN[0] && p < SCAN[1]) { rim.color.set('#33f0d0'); rim.opacity = 0.55 + 0.25 * Math.sin(t * 18); }
    else if (p >= SCAN[1] && p < SCAN[1] + 0.08) {
      const k = 1 - (p - SCAN[1]) / 0.08;
      if (token.kind === 'defect') { rim.color.set('#ff2a22'); rim.opacity = (reduced ? 0.8 : Math.sin(t * 40) > 0 ? 0.95 : 0.2) * k; }
      else { rim.color.set('#43ff9a'); rim.opacity = 0.7 * k; }
    } else if (selected) { rim.color.set('#ffe14d'); rim.opacity = 0.35 + 0.15 * Math.sin(t * 5); }
    else rim.opacity = 0;
    if (ringRef.current) ringRef.current.scale.setScalar(1 + (reduced ? 0 : 0.12 * Math.sin(t * 6)));
    const next = p < SCAN[0] ? 'move' : p < SCAN[1] ? 'scan' : p < VERDICT[0] ? 'move' : p < VERDICT[1] ? 'verdict' : 'go';
    if (next !== stageRef.current) { stageRef.current = next; setStage(next); }
  });
  const extra = Math.min(token.count, 3);
  const verdict = token.kind === 'defect' ? (token.defectType ? (DEFECT_TH[token.defectType] ?? token.defectType) : 'เสีย') : 'ดี';
  const defectType = token.kind === 'defect' && token.count === 1 ? (token.defectType ?? 'rot') : null;
  const click = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onPick(token); };
  return <group ref={ref} userData={{ tokenId: token.id }}>
    <group ref={roll}>
      <FruitBody fruit={token.fruit} defectType={defectType} seed={token.id} />
      {extra > 1 && <group position={[-0.32, 0, 0.18]}><FruitBody fruit={token.fruit} defectType={null} seed={`${token.id}b`} /></group>}
      {extra > 2 && <group position={[-0.3, 0, -0.22]}><FruitBody fruit={token.fruit} defectType={null} seed={`${token.id}c`} /></group>}
    </group>
    <mesh geometry={geo().rim} material={rim} scale={extra > 1 ? 1.8 : 1} />
    {defectType === 'rot' && q.smoke > 0 && !reduced && <Smoke count={q.smoke} />}
    <mesh geometry={geo().hit} material={hitMat()} onClick={click}
      onPointerOver={(e) => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }}
      onPointerOut={() => { gl.domElement.style.cursor = ''; }} />
    {selected && <mesh ref={ringRef} geometry={geo().ring} position={[0, -FRUIT_R + 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}
      material={mat('pick-ring', () => new THREE.MeshBasicMaterial({ color: '#ffe14d', toneMapped: false, transparent: true, opacity: 0.9 }))} />}
    {stage === 'scan' && <mesh geometry={geo().box} scale={[FRUIT_R * 2.6 + (extra - 1) * 0.3, FRUIT_R * 2.6, FRUIT_R * 2.6 + (extra - 1) * 0.3]}
      material={mat('bbox', () => new THREE.MeshBasicMaterial({ color: '#33f0d0', wireframe: true, transparent: true, opacity: 0.7, toneMapped: false }))} />}
    {(stage === 'scan' || stage === 'verdict') && <Html center position={[0, 0.62, 0]} zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`lv3d-tag ${stage === 'verdict' ? token.kind : 'scan'}`}>
        {stage === 'scan'
          ? <>{token.fruit ?? '?'} {token.conf == null ? '' : `${Math.round((token.conf <= 1 ? token.conf * 100 : token.conf))}%`}</>
          : <>{verdict}{token.count > 1 ? ` ×${token.count}` : ''}</>}
        <i>{token.count > 1 ? `×${token.count}` : `#${token.track ?? '-'}`}</i>
      </div>
    </Html>}
  </group>;
}

type Piled = { id: string; kind: Kind; fruit: string | null; defectType: string | null; pos: THREE.Vector3; token: Fruit3D | null };

function Burst({ at, color, count, onDone }: { at: THREE.Vector3; color: string; count: number; onDone: () => void }) {
  const group = useRef<THREE.Group>(null);
  const born = useRef(performance.now());
  const dirs = useMemo(() => Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a), 1.2 + (i % 3) * 0.5, Math.sin(a)).multiplyScalar(1.4);
  }), [count]);
  const m = mat(`burst:${color}`, () => new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  useFrame(() => {
    const t = (performance.now() - born.current) / 900;
    if (t >= 1) { onDone(); return; }
    group.current?.children.forEach((child, i) => {
      const d = dirs[i];
      child.position.set(d.x * t, d.y * t - 2.2 * t * t, d.z * t);
      child.scale.setScalar(1 - t);
    });
  });
  return <group ref={group} position={at}>
    {dirs.map((_, i) => <mesh key={i} geometry={geo().puff} material={m} scale={0.8} />)}
  </group>;
}

// ---- Static line ------------------------------------------------------------------------------
function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2d3436'; g.fillRect(0, 0, 128, 32);
  g.fillStyle = '#3d4648';
  for (let x = 0; x < 128; x += 16) g.fillRect(x, 0, 6, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// trim: cut a side rail short at the start (s = side, start) or end, so rails do not cross the other belts at the fork
function Belt({ from, to, width, strip, speed, trim = [], lift = 0 }: {
  from: THREE.Vector3; to: THREE.Vector3; width: number; strip: THREE.Material; speed: React.MutableRefObject<number>;
  trim?: { side: number; start?: number; end?: number }[]; lift?: number;
}) {
  const d = to.clone().sub(from).setY(0);
  const len = d.length();
  const mid = from.clone().add(to).multiplyScalar(0.5);
  const angle = -Math.atan2(d.z, d.x);
  const tex = useMemo(() => { const t = stripeTexture(); t.repeat.set(len / 0.9, 1); return t; }, [len]);
  useEffect(() => () => tex.dispose(), [tex]);
  useFrame((_, dt) => { tex.offset.x -= (speed.current * dt) / 0.9; });
  const legs = Array.from({ length: Math.max(2, Math.floor(len / 2.2)) }, (_, i) => i);
  return <group position={[mid.x, 0, mid.z]} rotation={[0, angle, 0]}>
    <mesh position={[0, BELT_Y - 0.12, 0]} castShadow receiveShadow>
      <boxGeometry args={[len, 0.24, width + 0.3]} />
      <meshStandardMaterial color="#eef3f0" roughness={0.4} />
    </mesh>
    <mesh position={[0, BELT_Y + 0.005 + lift, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[len, width]} />
      <meshStandardMaterial map={tex} roughness={0.85} />
    </mesh>
    {[-1, 1].map((s) => {
      const t = trim.find((x) => x.side === s); const a = t?.start ?? 0; const b = t?.end ?? 0;
      const rl = Math.max(0.1, len - a - b); const rx = (a - b) / 2;
      return <group key={s}>
        <mesh position={[rx, BELT_Y + 0.08, s * (width / 2 + 0.1)]} castShadow>
          <boxGeometry args={[rl, 0.16, 0.12]} />
          <meshStandardMaterial color="#f7faf8" roughness={0.3} />
        </mesh>
        <mesh position={[rx, BELT_Y + 0.02, s * (width / 2 + 0.165)]} material={strip}>
          <boxGeometry args={[rl * 0.96, 0.04, 0.012]} />
        </mesh>
      </group>;
    })}
    {legs.map((i) => {
      const x = -len / 2 + 0.6 + (i * (len - 1.2)) / Math.max(1, legs.length - 1);
      return [-1, 1].map((s) => <mesh key={`${i}${s}`} position={[x, (BELT_Y - 0.24) / 2, s * (width / 2 + 0.05)]} castShadow>
        <boxGeometry args={[0.16, BELT_Y - 0.24, 0.16]} />
        <meshStandardMaterial color="#cfd8d3" />
      </mesh>);
    })}
  </group>;
}

const LENS_Y = 2.08; // bottom of the camera lens (apex of the scan cone)
function Gantry({ beam, cone, head, scan, reduced, fault }: { beam: THREE.Material; cone: THREE.MeshBasicMaterial; head: THREE.MeshStandardMaterial; scan: React.MutableRefObject<ScanState>; reduced: boolean; fault: boolean }) {
  const laser = useRef<THREE.Group>(null);
  const lineMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#4dffe0', toneMapped: false, transparent: true, opacity: 0.95 }), []);
  const fanMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#4dffe0', toneMapped: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }), []);
  const fan = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, LENS_Y, 0, 0, BELT_Y + 0.03, -0.72, 0, BELT_Y + 0.03, 0.72], 3));
    return g;
  }, []);
  useEffect(() => () => { lineMat.dispose(); fanMat.dispose(); fan.dispose(); }, [lineMat, fanMat, fan]);
  const red = useMemo(() => new THREE.Color('#ff2a22'), []);
  const teal = useMemo(() => new THREE.Color('#4dffe0'), []);
  const led = useMemo(() => new THREE.MeshBasicMaterial({ color: '#38f59a', toneMapped: false }), []);
  useEffect(() => () => led.dispose(), [led]);
  useFrame(({ clock }) => {
    const s = scan.current; const t = clock.elapsedTime;
    // idle: slow sweep across the gate; scanning: locks onto the fruit and sweeps fast over it
    const idle = reduced ? 0 : Math.sin(t * 1.3) * 0.85;
    const onFruit = s.x - CAM.x + (reduced ? 0 : Math.sin(t * 16) * 0.26);
    if (laser.current) laser.current.position.x = THREE.MathUtils.lerp(idle, onFruit, s.active);
    const flashRed = s.flash > 0 && s.flashDefect;
    lineMat.color.copy(flashRed ? red : teal);
    fanMat.color.copy(flashRed ? red : teal);
    fanMat.opacity = 0.06 + s.active * 0.16 + (flashRed ? 0.2 * s.flash : 0);
    cone.opacity = 0.08 + s.active * 0.2;
    // status LED: red on a defect verdict, cyan while scanning, slow green blink when idle
    led.color.set(flashRed ? '#ff2a22' : s.active > 0.3 ? '#4dffe0' : (reduced || Math.sin(t * 2.4) > -0.6) ? '#38f59a' : '#0d3a22');
    // camera-fault drill: status LED and scan cone blink red
    if (fault) { const on = reduced || Math.sin(t * 10) > 0; led.color.set(on ? '#ff2a22' : '#3a0a08'); cone.color.set(on ? '#ff3b2f' : '#5ff7dc'); }
    else cone.color.set('#5ff7dc');
  });
  const g = geo();
  const body = std('#2b3136', { metalness: 0.55, roughness: 0.38 });
  const fin = std('#4a535a', { metalness: 0.6, roughness: 0.4 });
  const steel = std('#a9b4ba', { metalness: 0.7, roughness: 0.3 });
  const black = std('#14181b', { roughness: 0.5 });
  return <group position={[CAM.x, 0, 0]}>
    {[-1, 1].map((s) => <RoundedBox key={s} args={[0.32, 2.9, 0.32]} radius={0.06} position={[0, 1.45, s * 1.2]} castShadow>
      <meshStandardMaterial color="#f4f7f5" roughness={0.3} />
    </RoundedBox>)}
    {[-1, 1].map((s) => <mesh key={`b${s}`} position={[0.17, 1.4, s * 1.2]} material={beam}><boxGeometry args={[0.012, 1.6, 0.08]} /></mesh>)}
    <RoundedBox args={[0.7, 0.4, 2.75]} radius={0.08} position={[0, 2.95, 0]} castShadow>
      <meshStandardMaterial color="#f4f7f5" roughness={0.3} />
    </RoundedBox>
    {/* machine-vision camera hanging under the beam, looking straight down at the belt */}
    <group position={[0, 2.75, 0]}>
      <mesh geometry={g.box} position={[0, -0.03, 0]} scale={[0.52, 0.06, 0.4]} material={steel} />
      {[-1, 1].map((s) => <mesh key={s} geometry={g.box} position={[0, -0.09, s * 0.15]} scale={[0.06, 0.1, 0.04]} material={steel} />)}
      <RoundedBox args={[0.36, 0.38, 0.32]} radius={0.035} position={[0, -0.32, 0]} material={body} castShadow />
      {[-1, 1].flatMap((s) => [0, 1, 2, 3, 4].map((i) => <mesh key={`${s}${i}`} geometry={g.box} position={[s * 0.19, -0.18 - i * 0.065, 0]} scale={[0.035, 0.03, 0.28]} material={fin} />))}
      {/* teal brand stripe (pulses blue when the model changes) + status LED */}
      <mesh geometry={g.box} position={[0, -0.25, 0.162]} scale={[0.26, 0.035, 0.01]} material={head} />
      <mesh geometry={g.box} position={[0, -0.25, -0.162]} scale={[0.26, 0.035, 0.01]} material={head} />
      <mesh geometry={g.blob} position={[0.12, -0.37, 0.163]} scale={0.022} material={led} />
      <mesh geometry={g.blob} position={[0.12, -0.37, -0.163]} scale={0.022} material={led} />
      {/* cable gland on the back */}
      <mesh position={[-0.12, -0.36, 0.17]} rotation={[Math.PI / 2, 0, 0]} material={black}><cylinderGeometry args={[0.03, 0.03, 0.06, 8]} /></mesh>
      {/* lens: barrel, two knurled rings, light ring, glass */}
      <mesh position={[0, -0.585, 0]} material={black}><cylinderGeometry args={[0.105, 0.115, 0.15, 20]} /></mesh>
      <mesh position={[0, -0.545, 0]} material={steel}><cylinderGeometry args={[0.122, 0.122, 0.03, 20]} /></mesh>
      <mesh position={[0, -0.615, 0]} material={steel}><cylinderGeometry args={[0.122, 0.122, 0.025, 20]} /></mesh>
      <mesh position={[0, -0.665, 0]} rotation={[Math.PI / 2, 0, 0]} material={head}><torusGeometry args={[0.1, 0.018, 8, 24]} /></mesh>
      <mesh position={[0, -0.665, 0]} material={mat('lens-glass', () => new THREE.MeshStandardMaterial({ color: '#0f2a3a', metalness: 0.9, roughness: 0.08, emissive: new THREE.Color('#1a6f72'), emissiveIntensity: 0.4 }))}>
        <cylinderGeometry args={[0.075, 0.075, 0.012, 20]} />
      </mesh>
    </group>
    <mesh position={[0, (LENS_Y + BELT_Y) / 2, 0]} material={cone}>
      <coneGeometry args={[0.95, LENS_Y - BELT_Y, 32, 1, true]} />
    </mesh>
    <group ref={laser}>
      <mesh position={[0, BELT_Y + 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]} material={lineMat}>
        <planeGeometry args={[0.03, 1.44]} />
      </mesh>
      <mesh geometry={fan} material={fanMat} />
    </group>
    <spotLight position={[0, LENS_Y - 0.05, 0]} target-position={[CAM.x, 0, 0]} angle={0.5} penumbra={0.6} intensity={6} color="#6ff2dc" distance={4} />
  </group>;
}

function Diverter({ paddleKey, mat: m }: { paddleKey: number; mat: THREE.MeshStandardMaterial }) {
  const pivot = useRef<THREE.Group>(null);
  const kickAt = useRef(-1e9);
  useEffect(() => { if (paddleKey) kickAt.current = performance.now(); }, [paddleKey]);
  const rest = 0.38; const kick = -0.42;
  useFrame(() => {
    const t = (performance.now() - kickAt.current) / 850;
    const env = t < 0 || t > 1 ? 0 : t < 0.22 ? t / 0.22 : t < 0.62 ? 1 : 1 - (t - 0.62) / 0.38;
    if (pivot.current) pivot.current.rotation.y = rest + (kick - rest) * env;
    m.emissive.set(env > 0.05 ? '#ff8a2a' : '#2fe0b4');
  });
  return <group position={[FORK.x - 0.2, BELT_Y + 0.2, -0.85]}>
    <mesh position={[0, -0.1, 0]} castShadow><cylinderGeometry args={[0.12, 0.14, 0.4, 16]} /><meshStandardMaterial color="#e9efeb" /></mesh>
    <group ref={pivot}>
      <RoundedBox args={[1.45, 0.16, 0.1]} radius={0.04} position={[0.72, 0, 0]} material={m} castShadow />
    </group>
  </group>;
}

// Slatted plastic crate, local +x along the branch direction.
const CW = 2.1; const CD = 1.5; const CH = 0.95; const CT = 0.07;
function CrateModel({ kind, rim }: { kind: Kind; rim: THREE.Material }) {
  const g = geo();
  const body = std(kind === 'good' ? '#2f9e63' : '#d8752e', { roughness: 0.55 });
  const inner = std(kind === 'good' ? '#bfe8cf' : '#f6d2b4', { roughness: 0.8 });
  const post = std(kind === 'good' ? '#24804f' : '#b35d22', { roughness: 0.5 });
  const slatY = [0.2, 0.47, 0.74];
  return <group>
    <mesh geometry={g.box} position={[0, CT / 2, 0]} scale={[CW, CT, CD]} material={inner} receiveShadow />
    {[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz], i) => <mesh key={`p${i}`} geometry={g.box} position={[sx * (CW / 2 - 0.05), CH / 2, sz * (CD / 2 - 0.05)]} scale={[0.12, CH, 0.12]} material={post} castShadow />)}
    {slatY.map((y) => <group key={y}>
      {[-1, 1].map((s) => <mesh key={`l${s}`} geometry={g.box} position={[0, y, s * CD / 2]} scale={[CW, 0.17, CT]} material={body} castShadow receiveShadow />)}
      {[-1, 1].map((s) => <mesh key={`s${s}`} geometry={g.box} position={[s * CW / 2, y, 0]} scale={[CT, 0.17, CD]} material={body} castShadow receiveShadow />)}
    </group>)}
    {[-1, 1].map((s) => <mesh key={`r${s}`} geometry={g.box} position={[0, CH + 0.02, s * CD / 2]} scale={[CW + CT, 0.05, 0.1]} material={rim} />)}
    {[-1, 1].map((s) => <mesh key={`q${s}`} geometry={g.box} position={[s * CW / 2, CH + 0.02, 0]} scale={[0.1, 0.05, CD]} material={rim} />)}
  </group>;
}

type Swap = { start: number; carried: Piled[] | null };
const SWAP = { arrive: 1800, pulled: 2600, dropFrom: 1950, dropTo: 2500, done: 4800 };

function StationCrate({ kind, rim, swap, glow, onClick }: { kind: Kind; rim: THREE.Material; swap: Swap | null; glow: number; onClick: (kind: Kind) => void }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    if (!swap) { ref.current.position.y = 0; ref.current.visible = true; return; }
    const t = performance.now() - swap.start;
    ref.current.visible = !(t >= SWAP.arrive && t < SWAP.dropFrom);
    const k = clamp01((t - SWAP.dropFrom) / (SWAP.dropTo - SWAP.dropFrom));
    // a fresh crate drops in with a small bounce while the AGV pulls the full one out
    ref.current.position.y = t < SWAP.dropFrom ? 0 : (1 - k) * (1 - k) * 3 + Math.sin(k * Math.PI) * 0.15 * (1 - k);
  });
  const c = CRATE[kind];
  return <group position={[c.x, 0, c.z]} rotation={[0, crateAngle(kind), 0]}>
    <group ref={ref} onClick={(e) => { e.stopPropagation(); onClick(kind); }}><CrateModel kind={kind} rim={rim} /></group>
    <pointLight position={[0, CH + 0.6, 0]} intensity={2.2 * glow} distance={3.2} color={kind === 'good' ? '#5dffa4' : '#ffae55'} />
  </group>;
}

function Agv({ kind, swap, rim }: { kind: Kind; swap: Swap; rim: THREE.Material }) {
  const agv = useRef<THREE.Group>(null);
  const carried = useRef<THREE.Group>(null);
  const beacon = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffb02e', toneMapped: false }), []);
  useEffect(() => () => beacon.dispose(), [beacon]);
  const dir = dirOf(kind); const station = CRATE[kind];
  const dock = station.clone().add(dir.clone().multiplyScalar(CW / 2 + 0.95));
  const far = station.clone().add(dir.clone().multiplyScalar(14.2)); // good side: out through the warehouse door
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    const t = performance.now() - swap.start;
    if (t < SWAP.arrive) tmp.lerpVectors(far, dock, easeOut(t / SWAP.arrive));
    else if (t < SWAP.pulled) tmp.copy(dock);
    else tmp.lerpVectors(dock, far, easeIn(clamp01((t - SWAP.pulled) / (SWAP.done - SWAP.pulled))) ** 1.4);
    agv.current?.position.set(tmp.x, 0, tmp.z);
    beacon.color.set(Math.sin(clock.elapsedTime * 10) > 0 ? '#ffb02e' : '#3a2a10');
    const c = carried.current;
    if (c) {
      c.visible = !!swap.carried && t >= SWAP.arrive;
      const deck = new THREE.Vector3(tmp.x, 0.42, tmp.z);
      if (t < SWAP.pulled) {
        const k = easeOut(clamp01((t - SWAP.arrive) / (SWAP.pulled - SWAP.arrive)));
        c.position.lerpVectors(new THREE.Vector3(station.x, 0, station.z), deck, k);
        c.position.y += Math.sin(k * Math.PI) * 0.25;
      } else c.position.copy(deck);
    }
  });
  const angle = crateAngle(kind);
  const g = geo();
  return <>
    <group ref={agv} rotation={[0, angle, 0]}>
      <RoundedBox args={[1.7, 0.32, 1.3]} radius={0.08} position={[0, 0.24, 0]} castShadow>
        <meshStandardMaterial color="#f2c230" roughness={0.45} />
      </RoundedBox>
      <mesh geometry={g.box} position={[0, 0.41, 0]} scale={[1.6, 0.04, 1.2]} material={std('#3b4246', { roughness: 0.7 })} />
      {[[-0.6, -0.66], [0.6, -0.66], [-0.6, 0.66], [0.6, 0.66]].map(([x, z], i) => <mesh key={i} position={[x, 0.12, z]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.12, 0.1, 12]} /><meshStandardMaterial color="#22272a" roughness={0.8} />
      </mesh>)}
      <mesh geometry={g.box} position={[0.86, 0.26, 0]} scale={[0.02, 0.08, 1.0]} material={rim} />
      <mesh geometry={g.box} position={[-0.86, 0.26, 0]} scale={[0.02, 0.08, 1.0]} material={rim} />
      <mesh position={[-0.55, 0.52, 0.5]} material={beacon}><sphereGeometry args={[0.07, 10, 8]} /></mesh>
    </group>
    <group ref={carried} rotation={[0, angle, 0]} visible={false}>
      <CrateModel kind={kind} rim={rim} />
      {swap.carried?.map((p) => {
        // pile slots are world positions; turn them into the crate's local frame
        const local = p.pos.clone().sub(station).applyAxisAngle(new THREE.Vector3(0, 1, 0), -angle);
        return <group key={p.id} position={local}><FruitBody fruit={p.fruit} defectType={p.defectType} seed={p.id} /></group>;
      })}
    </group>
  </>;
}

// Potted trees (planters) around the viewpoint deck and in front of the warehouse; the orchard is ORCHARD.
const TREES: { x: number; z: number; s: number; fruit: string }[] = [
  { x: -14.2, z: 12.8, s: 0.95, fruit: 'orange' }, { x: -3.8, z: 12.8, s: 0.9, fruit: 'apple' },
  { x: 14, z: 11, s: 1, fruit: 'orange' }, { x: 18, z: 13.4, s: 1.1, fruit: 'apple' }, { x: -23.4, z: 9.6, s: 0.95, fruit: 'apple' },
];
function Tree({ x, z, s = 1, fruit }: { x: number; z: number; s?: number; fruit: string }) {
  const balls = useMemo(() => Array.from({ length: 8 }, (_, i) => {
    const a = i * 2.3; const r = 0.85 + (i % 2) * 0.2;
    return [Math.cos(a) * r, 2.0 + (i % 3) * 0.4, Math.sin(a) * r] as [number, number, number];
  }), []);
  const g = geo();
  return <group position={[x, 0, z]} scale={s}>
    <mesh position={[0, 0.25, 0]} castShadow receiveShadow><cylinderGeometry args={[0.75, 0.62, 0.5, 8]} /><meshStandardMaterial color="#e3ebe6" flatShading /></mesh>
    <mesh position={[0, 0.52, 0]}><cylinderGeometry args={[0.66, 0.66, 0.05, 8]} /><meshStandardMaterial color="#6b4a2e" flatShading /></mesh>
    <mesh position={[0, 1.1, 0]} castShadow><cylinderGeometry args={[0.09, 0.15, 1.5, 6]} /><meshStandardMaterial color="#7a5636" flatShading /></mesh>
    <mesh position={[0, 2.25, 0]} castShadow><icosahedronGeometry args={[1.0, 0]} /><meshStandardMaterial color="#4fae55" flatShading /></mesh>
    <mesh position={[0.55, 2.0, 0.2]} castShadow><icosahedronGeometry args={[0.7, 0]} /><meshStandardMaterial color="#3f9b4b" flatShading /></mesh>
    <mesh position={[-0.45, 2.55, -0.25]} castShadow><icosahedronGeometry args={[0.65, 0]} /><meshStandardMaterial color="#5cbd5f" flatShading /></mesh>
    {balls.map((p, i) => <mesh key={i} position={p} geometry={fruit === 'apple' ? g.apple : g.orange} scale={0.55} material={std(FRUIT_COLOR[fruit], { flatShading: true })} castShadow />)}
  </group>;
}

// Rotating siren on a pole: lit and turning while an alert is open.
function Siren({ alert, reduced }: { alert: Props['alert']; reduced: boolean }) {
  const spin = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const dome = useMemo(() => new THREE.MeshStandardMaterial({ color: '#555', emissive: new THREE.Color('#000'), transparent: true, opacity: 0.9, roughness: 0.2 }), []);
  const beam = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff3b2f', transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), []);
  useEffect(() => () => { dome.dispose(); beam.dispose(); }, [dome, beam]);
  const color = alert === 'critical' ? '#ff3b2f' : '#ff9b2f';
  useFrame(({ clock }, dt) => {
    const on = !!alert;
    if (spin.current) { spin.current.visible = on; if (!reduced) spin.current.rotation.y += dt * 5; }
    dome.color.set(on ? color : '#6b6f72');
    dome.emissive.set(on ? color : '#000000');
    dome.emissiveIntensity = on ? 1.4 + (reduced ? 0 : 0.6 * Math.sin(clock.elapsedTime * 10)) : 0;
    beam.color.set(color);
    if (light.current) light.current.intensity = on ? (alert === 'critical' ? 26 : 16) * (reduced ? 0.7 : 0.55 + 0.45 * Math.sin(clock.elapsedTime * 5)) : 0;
  });
  return <group position={[SIREN_AT.x, 0, SIREN_AT.z]}>
    <mesh position={[0, 0.06, 0]} castShadow><cylinderGeometry args={[0.24, 0.3, 0.12, 12]} /><meshStandardMaterial color="#3b4246" /></mesh>
    <mesh position={[0, 1.6, 0]} castShadow><cylinderGeometry args={[0.05, 0.06, 3.1, 8]} /><meshStandardMaterial color="#cfd8d3" metalness={0.4} roughness={0.4} /></mesh>
    <mesh position={[0, 3.2, 0]}><cylinderGeometry args={[0.2, 0.22, 0.1, 14]} /><meshStandardMaterial color="#2b3033" /></mesh>
    <mesh position={[0, 3.27, 0]} material={dome}><sphereGeometry args={[0.18, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
    <group ref={spin} position={[0, 3.36, 0]} visible={false}>
      {[0, Math.PI].map((a) => <mesh key={a} rotation={[0, a, Math.PI / 2]} position={[Math.cos(a) * 1.6, 0, -Math.sin(a) * 1.6]} material={beam}>
        <coneGeometry args={[0.5, 3.2, 16, 1, true]} />
      </mesh>)}
    </group>
    <pointLight ref={light} position={[0, 3.3, 0]} distance={16} color={color} intensity={0} />
  </group>;
}

// Blue light wave that runs along the belts when the model changes.
function ModelWave({ modelKey, reduced, withLight }: { modelKey: number; reduced: boolean; withLight: boolean }) {
  const start = useRef(-1e9);
  useEffect(() => { if (modelKey) start.current = performance.now(); }, [modelKey]);
  const main = useRef<THREE.Group>(null); const good = useRef<THREE.Group>(null); const bad = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const m = useMemo(() => new THREE.MeshBasicMaterial({ color: '#4f8dff', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), []);
  useEffect(() => () => m.dispose(), [m]);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const DUR = 2600;
  useFrame(() => {
    const w = (performance.now() - start.current) / DUR;
    const on = w >= 0 && w < 1 && !reduced;
    [main, good, bad].forEach((r) => { if (r.current) r.current.visible = false; });
    if (light.current) light.current.intensity = 0;
    if (!on) return;
    m.opacity = 0.75 * (w < 0.85 ? 1 : (1 - w) / 0.15);
    if (w < 0.42) {
      tmp.lerpVectors(START, FORK, w / 0.42);
      if (main.current) { main.current.visible = true; main.current.position.set(tmp.x, BELT_Y + 0.2, 0); main.current.rotation.y = 0; }
    } else {
      const k = (w - 0.42) / 0.58;
      ([['good', good], ['defect', bad]] as const).forEach(([kind, r]) => {
        tmp.lerpVectors(FORK, END[kind], k);
        if (r.current) { r.current.visible = true; r.current.position.set(tmp.x, BELT_Y + 0.2, tmp.z); r.current.rotation.y = crateAngle(kind); }
      });
    }
    if (light.current && withLight) { light.current.position.set(tmp.x, 1.6, w < 0.42 ? 0 : tmp.z * 0); light.current.intensity = 14 * m.opacity; }
  });
  const band = <>
    <mesh geometry={geo().box} scale={[0.14, 0.45, 1.75]} material={m} />
    <mesh geometry={geo().box} scale={[0.6, 0.06, 1.75]} position={[-0.25, -0.18, 0]} material={m} />
  </>;
  return <>
    <group ref={main} visible={false}>{band}</group>
    <group ref={good} visible={false}>{band}</group>
    <group ref={bad} visible={false}>{band}</group>
    <pointLight ref={light} distance={6} color="#4f8dff" intensity={0} />
  </>;
}

// Holographic stats panel floating near the start of the line (throughput / defect rate / last 5 minutes).
// last screen of the board wall (6th slot, see WALL); glass panel with live bars
const HOLO = { pos: [2.5 * (4.8 + 0.22), 2.9, -9.42] as [number, number, number], w: 4.8, h: 2.4 };
function HoloPanel({ stats, reduced }: { stats: Props['stats']; reduced: boolean }) {
  const bars = stats.spark.length ? stats.spark : Array.from({ length: 60 }, () => ({ n: 0, defect: 0 }));
  const max = Math.max(1, ...bars.map((b) => b.n));
  const targets = useRef<{ g: number; d: number }[]>([]);
  targets.current = bars.map((b) => ({ g: (b.n - b.defect) / max, d: b.defect / max }));
  const goodRefs = useRef<(THREE.Mesh | null)[]>([]);
  const badRefs = useRef<(THREE.Mesh | null)[]>([]);
  const frame = useMemo(() => new THREE.EdgesGeometry(new THREE.PlaneGeometry(HOLO.w, HOLO.h)), []);
  const barGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const glass = useMemo(() => new THREE.MeshBasicMaterial({ color: '#2fe0c0', transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }), []);
  const edge = useMemo(() => new THREE.LineBasicMaterial({ color: '#6ff7e4', transparent: true, opacity: 0.85, toneMapped: false }), []);
  const gm = useMemo(() => new THREE.MeshBasicMaterial({ color: '#3dffb0', transparent: true, opacity: 0.85, toneMapped: false }), []);
  const dm = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffa043', transparent: true, opacity: 0.9, toneMapped: false }), []);
  const beam = useMemo(() => new THREE.MeshBasicMaterial({ color: '#2fe0c0', transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), []);
  useEffect(() => () => { frame.dispose(); barGeo.dispose(); glass.dispose(); edge.dispose(); gm.dispose(); dm.dispose(); beam.dispose(); }, [frame, barGeo, glass, edge, gm, dm, beam]);
  const n = bars.length; const bw = (HOLO.w - 0.3) / n; const H = HOLO.h - 0.85; const base = -HOLO.h / 2 + 0.15;
  useFrame(({ clock }, dt) => {
    const k = reduced ? 1 : 1 - Math.exp(-dt * 4);
    for (let i = 0; i < n; i++) {
      const tg = targets.current[i] ?? { g: 0, d: 0 };
      const g = goodRefs.current[i]; const d = badRefs.current[i];
      if (g) { g.scale.y = Math.max(0.002, g.scale.y + (tg.g * H - g.scale.y) * k); }
      if (d && g) { d.scale.y = Math.max(0.002, d.scale.y + (tg.d * H - d.scale.y) * k); d.position.y = base + g.scale.y; }
    }
    glass.opacity = 0.07 + (reduced ? 0 : 0.02 * Math.sin(clock.elapsedTime * 7));
  });
  return <group>
    <group position={HOLO.pos}>
      <mesh material={glass}><planeGeometry args={[HOLO.w, HOLO.h]} /></mesh>
      <lineSegments geometry={frame} material={edge} />
      {bars.map((_, i) => {
        const x = -HOLO.w / 2 + 0.15 + bw * (i + 0.5);
        return <group key={i}>
          <mesh ref={(el) => { goodRefs.current[i] = el; }} geometry={barGeo} material={gm} position={[x, base, 0.01]} scale={[bw * 0.7, 0.002, 0.02]} />
          <mesh ref={(el) => { badRefs.current[i] = el; }} geometry={barGeo} material={dm} position={[x, base, 0.012]} scale={[bw * 0.7, 0.002, 0.02]} />
        </group>;
      })}
      <Html position={[0, HOLO.h / 2 - 0.4, 0]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
        <div className="lv3d-holo">
          <div><b>{stats.epm.toLocaleString()}</b><span>ผล/นาที</span></div>
          <div className={Number(stats.defectRate) >= 30 ? 'bad' : Number(stats.defectRate) >= 15 ? 'warn' : ''}><b>{stats.defectRate}%</b><span>defect</span></div>
          <em>5 นาทีล่าสุด</em>
        </div>
      </Html>
    </group>
  </group>;
}

function CrateLabel({ kind, count, last, hit, fill, swapping }: { kind: Kind; count: number; last: string | null; hit: number; fill: number; swapping: boolean }) {
  const c = CRATE[kind];
  return <Html position={[c.x, 2.05, c.z]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
    <div className={`lv3d-bin ${kind}`}>
      <span>{kind === 'good' ? 'ตะกร้าดี' : 'ตะกร้าเสีย'}</span>
      <strong key={hit} className={hit ? 'pop' : ''}>{count.toLocaleString()}</strong>
      <div className="lv3d-bin-fill" title="ผลไม้ในลังนี้ (เปลี่ยนลังเมื่อเต็ม)"><i style={{ width: `${Math.min(100, (fill / PILE_MAX) * 100)}%` }} /></div>
      <em>{swapping ? 'AGV กำลังเปลี่ยนลัง...' : last ? `ล่าสุด ${last}` : `ลัง ${fill}/${PILE_MAX}`}</em>
    </div>
  </Html>;
}

// ---- Scene --------------------------------------------------------------------------------------
type LineProps = Props & { fun: Fun; boardData: BoardData | null; onConsole: () => void; env: Env; q: Q; reduced: boolean; pickId: string | null; onPick: (t: Fruit3D) => void; onCrate: (kind: Kind) => void; onPile: (p: Piled) => void; pileIndex: React.MutableRefObject<Map<string, Piled>>; registry: React.MutableRefObject<Map<string, THREE.Vector3>> };

function Line({ tokens, travelMs, playing, paddleKey, modelKey, powerKey, alert, seed, bins, stats, kpi, crates, system, control, fun, boardData, onConsole, env, q, reduced, pickId, onPick, onCrate, onPile, pileIndex, registry }: LineProps) {
  const speed = useRef(0);
  const power = useRef(0);
  const emDef = fun.emerg ? EMERG[fun.emerg] : null;
  const dim = fun.emerg === 'power' ? 0.3 : 1; // power-cut drill: daylight through the openings only
  const dimRef = useRef(dim); dimRef.current = dim;
  const scan = useRef<ScanState>({ active: 0, x: CAM.x, defect: false, flash: 0, flashDefect: false });
  const powerKick = useRef(-1e9);
  const modelKick = useRef(-1e9);
  useEffect(() => { if (powerKey) powerKick.current = performance.now(); }, [powerKey]);
  useEffect(() => { if (modelKey) modelKick.current = performance.now(); }, [modelKey]);

  const mats = useMemo(() => ({
    green: new THREE.MeshBasicMaterial({ color: new THREE.Color('#38f59a'), toneMapped: false }),
    orange: new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffa043'), toneMapped: false }),
    teal: new THREE.MeshBasicMaterial({ color: new THREE.Color('#4dffe0'), toneMapped: false }),
    cone: new THREE.MeshBasicMaterial({ color: new THREE.Color('#5ff7dc'), transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
    head: new THREE.MeshStandardMaterial({ color: '#f4f7f5', emissive: new THREE.Color('#2fe0b4'), emissiveIntensity: 0.25, roughness: 0.3 }),
    paddle: new THREE.MeshStandardMaterial({ color: '#f2fffa', emissive: new THREE.Color('#2fe0b4'), emissiveIntensity: 0.9, roughness: 0.3 }),
  }), []);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  const base = useMemo(() => ({ green: mats.green.color.clone(), orange: mats.orange.color.clone(), teal: mats.teal.color.clone() }), [mats]);
  const keyLight = useRef<THREE.DirectionalLight>(null);
  const glow = 1 + env.night * 0.9;
  const glowRef = useRef(glow); glowRef.current = glow;

  // shadow quality: drop the old map so three allocates one at the new size
  useEffect(() => {
    const l = keyLight.current;
    if (!l) return;
    l.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    l.shadow.map?.dispose(); l.shadow.map = null;
  }, [q.shadowSize]);

  // Crate piles: seeded from the window totals so crates are not empty on open, then grow as fruit land.
  const [pile, setPile] = useState<Record<Kind, Piled[]>>(() => {
    const make = (kind: Kind, n: number) => Array.from({ length: Math.min(n, kind === 'good' ? 18 : 9) }, (_, i) => {
      const id = `seed-${kind}-${i}`;
      const fruit = seed.fruits.length ? seed.fruits[Math.floor(hash(id) * seed.fruits.length)] : 'apple';
      return { id, kind, fruit, defectType: kind === 'defect' ? ['rot', 'bruise', 'crack'][i % 3] : null, pos: pileSlot(kind, i, id), token: null };
    });
    return { good: make('good', seed.good), defect: make('defect', seed.defect) };
  });
  const pileRef = useRef(pile); pileRef.current = pile;
  pileIndex.current = new Map([...pile.good, ...pile.defect].map((p) => [p.id, p]));
  const glPile = useThree((st) => st.gl);
  const pileCount = useRef({ good: pile.good.length, defect: pile.defect.length });
  const [bursts, setBursts] = useState<{ key: string; at: THREE.Vector3; color: string }[]>([]);
  const [swap, setSwap] = useState<Record<Kind, Swap | null>>({ good: null, defect: null });
  const swapRef = useRef(swap); swapRef.current = swap;
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  // Where each fruit on the belt will land, fixed when it first appears.
  const targets = useRef(new Map<string, THREE.Vector3>());
  const kindOf = useRef(new Map<string, Kind>());
  const prev = useRef(new Map<string, Fruit3D>());
  for (const t of tokens) {
    if (!targets.current.has(t.id)) {
      const index = pileCount.current[t.kind] % PILE_MAX;
      pileCount.current[t.kind] += 1;
      targets.current.set(t.id, pileSlot(t.kind, index, t.id));
      kindOf.current.set(t.id, t.kind);
    }
  }
  useEffect(() => {
    const now = new Map(tokens.map((t) => [t.id, t]));
    const landed: Fruit3D[] = [];
    prev.current.forEach((t, id) => { if (!now.has(id) && Date.now() - t.spawnedAt >= travelMs * 0.9) landed.push(t); });
    prev.current = now;
    if (!landed.length) return;
    setPile((cur) => {
      const next = { good: [...cur.good], defect: [...cur.defect] };
      for (const t of landed) {
        const pos = targets.current.get(t.id) ?? pileSlot(t.kind, 0, t.id);
        const list = next[t.kind];
        if (list.some((p) => p.id === t.id)) continue;
        // reuse the slot this fruit aimed at (oldest fruit there leaves if the crate is still full)
        const clash = list.findIndex((p) => p.pos.distanceToSquared(pos) < 0.01);
        if (clash >= 0) list.splice(clash, 1);
        list.push({ id: t.id, kind: t.kind, fruit: t.fruit, defectType: t.kind === 'defect' ? (t.count === 1 ? t.defectType ?? 'rot' : null) : null, pos: pos.clone(), token: t });
        if (list.length > PILE_MAX) list.shift();
      }
      return next;
    });
    setBursts((cur) => [...cur.slice(-6), ...landed.map((t) => ({ key: `${t.id}-b`, at: (targets.current.get(t.id) ?? CRATE[t.kind]).clone().setY(1.1), color: t.kind === 'good' ? '#43ff9a' : '#ffa043' }))]);
    landed.forEach((t) => { targets.current.delete(t.id); kindOf.current.delete(t.id); });
  }, [tokens, travelMs]);

  // Crate swap: a full crate (PILE_MAX fruit) is pulled out by an AGV and a fresh one drops in.
  // Only the picture resets; the counts on the labels come from the DB totals and are not touched.
  useEffect(() => {
    const empty = (kind: Kind) => {
      const ids = new Set(pileRef.current[kind].map((p) => p.id));
      const carried = pileRef.current[kind];
      setPile((cur) => ({ ...cur, [kind]: cur[kind].filter((p) => !ids.has(p.id)) }));
      // fruit still on their way re-aim at the bottom of the new crate (same Vector3, so they follow it)
      let i = 0;
      targets.current.forEach((v, id) => { if (kindOf.current.get(id) === kind) v.copy(pileSlot(kind, i++, id)); });
      pileCount.current[kind] = i;
      return carried;
    };
    for (const kind of KINDS) {
      if (swapRef.current[kind] || pile[kind].length < PILE_MAX) continue;
      if (reduced) { empty(kind); continue; }
      setSwap((s) => ({ ...s, [kind]: { start: performance.now(), carried: null } }));
      timers.current.push(window.setTimeout(() => {
        const carried = empty(kind);
        setSwap((s) => (s[kind] ? { ...s, [kind]: { ...s[kind]!, carried } } : s));
      }, SWAP.arrive));
      timers.current.push(window.setTimeout(() => setSwap((s) => ({ ...s, [kind]: null })), SWAP.done));
    }
  }, [pile, reduced]);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const k = 1 - Math.exp(-dt * 1.6);
    speed.current += ((playing ? 3.6 : 0) - speed.current) * k;
    power.current += ((playing ? 1 : 0.12) - power.current) * (1 - Math.exp(-dt * 2.2));
    const sincePower = (performance.now() - powerKick.current) / 1000;
    const flash = sincePower < 1.2 ? Math.sin(Math.min(1, sincePower / 1.2) * Math.PI) * 1.6 : 0;
    const pw = power.current + flash;
    const gl = glowRef.current;
    mats.green.color.copy(base.green).multiplyScalar((0.25 + 1.6 * pw) * gl);
    mats.orange.color.copy(base.orange).multiplyScalar((0.25 + 1.6 * pw) * gl);
    mats.teal.color.copy(base.teal).multiplyScalar((0.25 + 1.6 * pw) * gl);
    const sinceModel = (performance.now() - modelKick.current) / 1000;
    const modelPulse = sinceModel < 2.4 ? (1 - sinceModel / 2.4) * (0.5 + 0.5 * Math.sin(sinceModel * 14)) : 0;
    mats.head.emissive.set(modelPulse > 0.05 ? '#4f7dff' : '#2fe0b4');
    mats.head.emissiveIntensity = 0.25 * pw * gl + modelPulse * 3;
    mats.paddle.emissiveIntensity = (0.3 + 0.8 * pw) * gl;
    // which fruit is under the camera right now (laser target) and which one just got its verdict
    let active = false; let flashK = 0; let flashDefect = false;
    for (const t of tokens) {
      const p = (Date.now() - t.spawnedAt) / travelMs;
      if (p > SCAN[0] && p < SCAN[1]) { active = true; scan.current.x = fruitPos(p, t.kind, CRATE[t.kind], tmp).x; scan.current.defect = t.kind === 'defect'; }
      else if (p >= SCAN[1] && p < SCAN[1] + 0.06) { const f = 1 - (p - SCAN[1]) / 0.06; if (f > flashK) { flashK = f; flashDefect = t.kind === 'defect'; } }
    }
    scan.current.active += ((active ? 1 : 0) - scan.current.active) * (1 - Math.exp(-dt * 10));
    scan.current.flash = flashK; scan.current.flashDefect = flashDefect;
    if (keyLight.current) keyLight.current.intensity = env.sunI * (0.5 + 0.5 * Math.min(1, pw)) * dimRef.current;
  });

  return <>
    <color attach="background" args={[env.sky]} />
    <fog attach="fog" args={[env.sky, 30, 140]} />
    <hemisphereLight color={env.hemiSky} groundColor={env.hemiGround} intensity={env.hemiI * dim} />
    <directionalLight ref={keyLight} position={env.sunPos} color={env.sun} intensity={env.sunI} castShadow={q.shadows}
      shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={9} shadow-camera-bottom={-9} shadow-bias={-0.0004} />
    {q.stars > 0 && env.night > 0.5 && <Stars radius={70} depth={25} count={q.stars} factor={3} saturation={0} fade speed={reduced ? 0 : 0.4} />}

    {/* grass all around, concrete slab under the warehouse (the grid only on the slab) */}
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[420, 420]} />
      <meshStandardMaterial color={env.grass} roughness={1} />
    </mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(SHED.x0 + SHED.x1) / 2, 0.012, (SHED.z0 + SHED.z1) / 2]} receiveShadow>
      <planeGeometry args={[SHED.x1 - SHED.x0, SHED.z1 - SHED.z0]} />
      <meshStandardMaterial color={env.ground} roughness={0.9} />
    </mesh>
    <Grid position={[(SHED.x0 + SHED.x1) / 2, 0.02, (SHED.z0 + SHED.z1) / 2]} args={[SHED.x1 - SHED.x0, SHED.z1 - SHED.z0]} cellSize={1} cellThickness={0.5} sectionSize={5} sectionThickness={1}
      cellColor={env.cell} sectionColor={env.section} fadeDistance={60} fadeStrength={1} />
    <Warehouse lampsOn={fun.emerg !== 'power'} />
    <Scenery env={env} lite={q === QUALITY.low} reduced={reduced} />
    <FeedLine speed={speed} reduced={reduced} />
    <Cat callKey={fun.meowKey} onCall={() => fun.onPet('cat')} reduced={reduced} marker={fun.marks.cat} />
    <Dog callKey={fun.barkKey} onCall={() => fun.onPet('dog')} reduced={reduced} marker={fun.marks.dog} />
    {TEAM.map((m, i) => <TeamMember key={m.letter} m={m} i={i} talking={fun.talk === i} onTeam={fun.onTeam} />)}
    <EmergencyPanel active={fun.emerg} onPress={fun.onEmerg} />
    {emDef && <EmergencyBeacons color={emDef.color} reduced={reduced} withLight={q.waveLight} />}
    {fun.emerg === 'fire' && <Fire reduced={reduced} />}
    {fun.emerg === 'jam' && <JamWarning reduced={reduced} />}

    <Belt from={new THREE.Vector3(START.x - 0.6, 0, 0)} to={new THREE.Vector3(FORK.x + 0.4, 0, 0)} width={1.4} strip={mats.green} speed={speed} trim={[{ side: -1, end: 0.55 }, { side: 1, end: 0.55 }]} />
    <Belt from={new THREE.Vector3(FORK.x, 0, -0.1)} to={END.good.clone().add(dirOf('good').multiplyScalar(0.35))} width={1.3} strip={mats.green} speed={speed} trim={[{ side: 1, start: 2.1 }]} />
    <Belt from={new THREE.Vector3(FORK.x, 0, 0.1)} to={END.defect.clone().add(dirOf('defect').multiplyScalar(0.35))} width={1.3} strip={mats.orange} speed={speed} trim={[{ side: -1, start: 2.1 }]} lift={0.004} />
    <Gantry beam={mats.teal} cone={mats.cone} head={mats.head} scan={scan} reduced={reduced} fault={fun.emerg === 'camera'} />
    <Diverter paddleKey={paddleKey} mat={mats.paddle} />
    {KINDS.map((kind) => <StationCrate key={kind} kind={kind} rim={kind === 'good' ? mats.green : mats.orange} swap={swap[kind]} glow={1 + env.night * 1.5} onClick={onCrate} />)}
    {KINDS.map((kind) => swap[kind] && <Agv key={`agv-${kind}`} kind={kind} swap={swap[kind]!} rim={kind === 'good' ? mats.green : mats.orange} />)}
    <CrateLabel kind="good" count={bins.good} last={bins.lastGood} hit={bins.hitGood} fill={pile.good.length} swapping={!!swap.good} />
    <CrateLabel kind="defect" count={bins.defect} last={bins.lastDefect} hit={bins.hitDefect} fill={pile.defect.length} swapping={!!swap.defect} />
    <Siren alert={alert ?? emDef?.level ?? null} reduced={reduced} />
    <ModelWave modelKey={modelKey} reduced={reduced} withLight={q.waveLight} />
    <HoloPanel stats={stats} reduced={reduced} />

    {TREES.map((t, i) => <Tree key={i} x={t.x} z={t.z} s={t.s} fruit={t.fruit} />)}
    <BoardWall glow={mats.teal} />
    <KpiBoard kpi={kpi} />
    <HourlyBoard data={boardData} />
    <ParetoBoard crates={crates} />
    <AlertBoard data={boardData} />
    <SystemBoard system={system} />
    <ControlConsole control={control} onPress={onConsole} />

    {tokens.map((t) => <MovingFruit key={t.id} token={t} travelMs={travelMs} pileTarget={targets.current.get(t.id) ?? CRATE[t.kind]}
      selected={pickId === t.id} onPick={onPick} registry={registry} q={q} reduced={reduced} />)}
    {KINDS.flatMap((kind) => pile[kind].map((p) => <group key={`pile-${p.id}`} position={p.pos} userData={{ pileId: p.id }}
      onClick={(e) => { e.stopPropagation(); onPile(p); }}
      onPointerOver={(e) => { e.stopPropagation(); glPile.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { glPile.domElement.style.cursor = ''; }}>
      <FruitBody fruit={p.fruit} defectType={p.defectType} seed={p.id} />
    </group>))}
    {bursts.map((b) => <Burst key={b.key} at={b.at} color={b.color} count={q.burst} onDone={() => setBursts((cur) => cur.filter((x) => x.key !== b.key))} />)}
  </>;
}

// ---- Site: warehouse, feed line, orchard and the rest of the scenery --------------------------------------
// Far scenery is instanced (one draw call per part) and never casts shadows; birds/clouds drop out on the low level.

const TEXS = new Map<string, THREE.CanvasTexture>();
type Paint = (g: CanvasRenderingContext2D, w: number, h: number, font: string) => void;
function canvasTex(key: string, w: number, h: number, paint: Paint) {
  const hit = TEXS.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  const draw = () => {
    const g = c.getContext('2d'); if (!g) return;
    g.clearRect(0, 0, w, h);
    paint(g, w, h, getComputedStyle(document.body).fontFamily || 'sans-serif');
    t.needsUpdate = true;
  };
  draw(); void document.fonts?.ready.then(draw);
  TEXS.set(key, t);
  return t;
}

function leafShape(g: CanvasRenderingContext2D, x: number, y: number, len: number, wid: number, rot: number) {
  g.save(); g.translate(x, y); g.rotate(rot);
  g.fillStyle = '#2f8a3a';
  g.beginPath(); g.moveTo(-len / 2, 0); g.quadraticCurveTo(0, -wid * 1.6, len / 2, 0); g.quadraticCurveTo(0, wid * 1.6, -len / 2, 0); g.fill();
  g.strokeStyle = 'rgba(200,245,175,.55)'; g.lineWidth = Math.max(1, wid * 0.12);
  g.beginPath(); g.moveTo(-len * 0.45, 0); g.lineTo(len * 0.42, 0); g.stroke();
  g.restore();
}
// Group logo "ส้มหยุด": an orange with a bite, a stem and two leaves (drawn, no image files).
function drawLogo(g: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  leafShape(g, cx - r * 0.62, cy - r * 0.95, r * 1.0, r * 0.32, -0.45);
  leafShape(g, cx + r * 0.52, cy - r * 1.16, r * 0.62, r * 0.22, -0.55);
  g.strokeStyle = '#2f7a33'; g.lineCap = 'round'; g.lineWidth = r * 0.11;
  g.beginPath(); g.moveTo(cx + r * 0.05, cy - r * 0.85); g.quadraticCurveTo(cx + r * 0.02, cy - r * 1.18, cx - r * 0.2, cy - r * 1.36); g.stroke();
  const size = Math.ceil(r * 2.2);
  const o = document.createElement('canvas'); o.width = o.height = size;
  const k = o.getContext('2d'); if (!k) return;
  const oc = size / 2;
  const grad = k.createRadialGradient(oc - r * 0.3, oc - r * 0.35, r * 0.1, oc, oc, r);
  grad.addColorStop(0, '#ffb347'); grad.addColorStop(0.65, '#f68a12'); grad.addColorStop(1, '#de6a06');
  k.fillStyle = grad; k.beginPath(); k.arc(oc, oc, r, 0, Math.PI * 2); k.fill();
  const bx = oc + r * 0.95; const by = oc - r * 0.02; const br = r * 0.42;
  k.globalCompositeOperation = 'destination-out'; k.beginPath(); k.arc(bx, by, br, 0, Math.PI * 2); k.fill();
  // pith rim and segments inside the bite (only where the fruit is)
  k.globalCompositeOperation = 'source-atop';
  k.strokeStyle = '#fff4df'; k.lineWidth = r * 0.1; k.beginPath(); k.arc(bx, by, br + r * 0.05, 0, Math.PI * 2); k.stroke();
  k.fillStyle = '#ffa53a'; k.lineWidth = r * 0.035;
  for (let i = 0; i < 4; i++) {
    const a0 = Math.PI * 0.62 + i * 0.6; const a1 = a0 + 0.5;
    k.beginPath(); k.arc(bx, by, br + r * 0.3, a0, a1); k.arc(bx, by, br + r * 0.12, a1, a0, true); k.closePath(); k.fill(); k.stroke();
  }
  k.globalCompositeOperation = 'source-over';
  k.fillStyle = 'rgba(255,255,255,.3)'; k.beginPath(); k.ellipse(oc - r * 0.4, oc - r * 0.4, r * 0.2, r * 0.1, -0.7, 0, Math.PI * 2); k.fill();
  g.drawImage(o, cx - oc, cy - oc);
}
const badgeTex = () => canvasTex('badge', 256, 256, (g, w, h, font) => {
  g.fillStyle = '#ffffff'; g.beginPath(); g.roundRect(8, 8, 240, 240, 36); g.fill();
  g.strokeStyle = '#1f6b33'; g.lineWidth = 6; g.stroke();
  drawLogo(g, 122, 112, 54);
  g.fillStyle = '#1f6b33'; g.font = `900 46px ${font}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillText('ส้มหยุด', 128, 226);
});
const badgeMat = () => mat('badge', () => new THREE.MeshStandardMaterial({ map: badgeTex(), transparent: true, alphaTest: 0.5, roughness: 0.8 }));
const signTex = () => canvasTex('sign', 1024, 256, (g, w, h, font) => {
  g.fillStyle = '#123828'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 28); g.fill();
  g.strokeStyle = '#f68a12'; g.lineWidth = 8; g.stroke();
  drawLogo(g, 150, 146, 74);
  g.fillStyle = '#ffffff'; g.font = `900 128px ${font}`; g.textBaseline = 'alphabetic'; g.fillText('ส้มหยุด', 268, 158);
  g.fillStyle = '#ffcf8a'; g.font = `700 34px ${font}`; g.fillText('ศูนย์คัดแยกผลไม้ · CIRA CORE', 274, 216);
});
const viewSignTex = () => canvasTex('view-sign', 512, 160, (g, w, h, font) => {
  g.fillStyle = '#6b4a2e'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 18); g.fill();
  g.fillStyle = '#fff3dc'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = `900 64px ${font}`; g.fillText('จุดชมวิว', w / 2, 86);
  g.font = `600 26px ${font}`; g.fillText('มองเห็นไลน์คัดแยกทั้งสาย', w / 2, 130);
});
const ribTex = () => canvasTex('ribs', 64, 64, (g) => {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  for (let x = 0; x < 64; x += 16) { g.fillStyle = 'rgba(0,0,0,.13)'; g.fillRect(x, 0, 5, 64); g.fillStyle = 'rgba(255,255,255,.7)'; g.fillRect(x + 6, 0, 2, 64); }
});
// corrugated sheet; repeat in sheets of 0.9 units
const ribbed = (key: string, color: string, rx: number, ry = 1, side: THREE.Side = THREE.FrontSide) => mat(`rib:${key}`, () => {
  const t = ribTex().clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry);
  return new THREE.MeshStandardMaterial({ color, map: t, roughness: 0.75, metalness: 0.15, side });
});

// Merge non-indexed copies of simple geometries (positions only; scenery uses flat shading).
function mergeGeos(parts: THREE.BufferGeometry[]) {
  const arrs = parts.map((p) => (p.index ? p.toNonIndexed() : p).attributes.position.array as Float32Array);
  const out = new Float32Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

// One InstancedMesh from a list of matrices (and optional per-instance colours).
function Inst({ geometry, material, matrices, colors }: { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[]; colors?: THREE.Color[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current; if (!m) return;
    matrices.forEach((mx, i) => m.setMatrixAt(i, mx));
    colors?.forEach((c, i) => m.setColorAt(i, c));
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [matrices, colors]);
  return <instancedMesh ref={ref} args={[geometry, material, matrices.length]} frustumCulled={false} />;
}
type BoxItem = { p: [number, number, number]; s: [number, number, number]; r?: [number, number, number] };
function boxMatrices(items: BoxItem[]) {
  const o = new THREE.Object3D();
  return items.map((b) => { o.position.set(...b.p); o.rotation.set(...(b.r ?? [0, 0, 0])); o.scale.set(...b.s); o.updateMatrix(); return o.matrix.clone(); });
}
function Boxes({ items, material }: { items: BoxItem[]; material: THREE.Material }) {
  const matrices = useMemo(() => boxMatrices(items), [items]);
  return <Inst geometry={geo().box} material={material} matrices={matrices} />;
}

// ---- Warehouse ("โกดัง"): steel frame, gable roof, open front; walls only at the back and the back half of the sides.
const SHED = { x0: -21, x1: 21.5, z0: -11.2, z1: 7.5, eave: 9.8, ridge: 11.4, sideZ: -3, doorZ0: -11.1, doorZ1: -8.7, doorH: 3.4 };
const SHED_CX = (SHED.x0 + SHED.x1) / 2; const SHED_W = SHED.x1 - SHED.x0;
const SHED_ZC = (SHED.z0 + SHED.z1) / 2; const SHED_HALF = (SHED.z1 - SHED.z0) / 2;
const SLOPE = Math.atan2(SHED.ridge - SHED.eave, SHED_HALF);
const SHED_POSTS: [number, number][] = [[SHED.x0, SHED.z1], [SHED.x1, SHED.z1], [SHED.x0, 2.5], [SHED.x1, 2.5]];
const roofY = (z: number) => SHED.ridge - Math.abs(z - SHED_ZC) * Math.tan(SLOPE);
const SHED_FRAME: BoxItem[] = (() => {
  const out: BoxItem[] = [];
  const col = (x: number, z: number) => out.push({ p: [x, SHED.eave / 2, z], s: [0.36, SHED.eave, 0.36] });
  [SHED.x0, -14, -7, 0, 7, 14, SHED.x1].forEach((x) => col(x, SHED.z0 + 0.25));
  [...SHED_POSTS, [SHED.x0, SHED.sideZ], [SHED.x1, SHED.sideZ]].forEach(([x, z]) => col(x, z));
  out.push({ p: [SHED_CX, SHED.eave - 0.1, SHED.z1], s: [SHED_W + 0.4, 0.22, 0.3] });
  out.push({ p: [SHED_CX, SHED.eave - 0.1, SHED.z0], s: [SHED_W + 0.4, 0.22, 0.3] });
  out.push({ p: [SHED_CX, SHED.ridge + 0.04, SHED_ZC], s: [SHED_W + 0.5, 0.16, 0.34] });
  // rafters on both gable ends
  for (const x of [SHED.x0, SHED.x1]) for (const side of [1, -1]) {
    const len = SHED_HALF / Math.cos(SLOPE);
    out.push({ p: [x, (SHED.ridge + SHED.eave) / 2, SHED_ZC + side * SHED_HALF / 2], s: [0.3, 0.26, len], r: [side * SLOPE, 0, 0] });
  }
  return out;
})();
// trusses and hanging lamps: only drawn while the camera is under the roof
const TRUSS_X = [-14, -7, 0, 7, 14];
const SHED_TRUSS: BoxItem[] = (() => {
  const out: BoxItem[] = [];
  const low = SHED.eave - 0.25; const len = SHED_HALF / Math.cos(SLOPE);
  for (const x of TRUSS_X) {
    out.push({ p: [x, low, SHED_ZC], s: [0.14, 0.14, SHED.z1 - SHED.z0] });
    for (const side of [1, -1]) out.push({ p: [x, (SHED.ridge + SHED.eave) / 2 - 0.1, SHED_ZC + side * SHED_HALF / 2], s: [0.14, 0.16, len], r: [side * SLOPE, 0, 0] });
    for (const dz of [-6.5, -3.2, 0, 3.2, 6.5]) { const z = SHED_ZC + dz; const top = roofY(z) - 0.15; out.push({ p: [x, (low + top) / 2, z], s: [0.08, top - low, 0.08] }); }
  }
  for (const x of [-10.5, -3.5, 3.5, 10.5]) for (const z of [-4.5, 1.5]) out.push({ p: [x, low - 0.7, z], s: [0.025, 1.3, 0.025] }, { p: [x, low - 1.38, z], s: [1.1, 0.12, 0.38] });
  return out;
})();
const SHED_LAMPS: BoxItem[] = [-10.5, -3.5, 3.5, 10.5].flatMap((x) => [-4.5, 1.5].map((z) => ({ p: [x, SHED.eave - 0.25 - 1.45, z] as [number, number, number], s: [1.0, 0.03, 0.3] as [number, number, number] })));

function Warehouse({ lampsOn }: { lampsOn: boolean }) {
  const inside = useRef<THREE.Group>(null);
  const lamp = mat('shed-lamp', () => new THREE.MeshBasicMaterial({ color: '#fff1cf', toneMapped: false }));
  useEffect(() => { lamp.color.set(lampsOn ? '#fff1cf' : '#34332e'); }, [lamp, lampsOn]);
  const top = useMemo(() => new THREE.MeshStandardMaterial({ color: '#b8c4c6', transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.6, metalness: 0.2 }), []);
  useEffect(() => () => top.dispose(), [top]);
  useFrame(({ camera }) => {
    // from above the roof is see-through (the boards and the line stay readable); from below it is solid
    top.opacity = THREE.MathUtils.clamp(0.34 - (camera.position.y - 12) * 0.028, 0.08, 0.34);
    if (inside.current) inside.current.visible = camera.position.y < SHED.eave - 0.3;
  });
  const steel = std('#5d6b73', { roughness: 0.5, metalness: 0.45 });
  const wallCol = '#c6d1cd';
  const backLen = SHED.sideZ - SHED.z0;
  const len = SHED_HALF / Math.cos(SLOPE) + 0.05;
  const gable = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-SHED.z0, SHED.eave); s.lineTo(-SHED.z1, SHED.eave); s.lineTo(-SHED_ZC, SHED.ridge); s.closePath();
    return new THREE.ShapeGeometry(s);
  }, []);
  useEffect(() => () => gable.dispose(), [gable]);
  const g = geo();
  return <group>
    <Boxes items={SHED_FRAME} material={steel} />
    {/* back wall with a darker dado, side walls (back half), right wall with the AGV door */}
    <mesh geometry={g.box} position={[SHED_CX, SHED.eave / 2, SHED.z0 - 0.08]} scale={[SHED_W, SHED.eave, 0.12]} material={ribbed('back', wallCol, SHED_W / 0.9)} receiveShadow />
    <mesh geometry={g.box} position={[SHED_CX, 0.6, SHED.z0 + 0.0]} scale={[SHED_W, 1.2, 0.06]} material={std('#7c8a86', { roughness: 0.8 })} />
    <mesh geometry={g.box} position={[SHED.x0 - 0.08, SHED.eave / 2, (SHED.z0 + SHED.sideZ) / 2]} scale={[0.12, SHED.eave, backLen]} material={ribbed('left', wallCol, backLen / 0.9)} />
    <mesh geometry={g.box} position={[SHED.x1 + 0.08, SHED.eave / 2, (SHED.doorZ1 + SHED.sideZ) / 2]} scale={[0.12, SHED.eave, SHED.sideZ - SHED.doorZ1]} material={ribbed('right', wallCol, (SHED.sideZ - SHED.doorZ1) / 0.9)} />
    <mesh geometry={g.box} position={[SHED.x1 + 0.08, (SHED.eave + SHED.doorH) / 2, (SHED.z0 + SHED.doorZ1) / 2]} scale={[0.12, SHED.eave - SHED.doorH, SHED.doorZ1 - SHED.z0]} material={ribbed('lintel', wallCol, (SHED.doorZ1 - SHED.z0) / 0.9)} />
    {[SHED.doorZ0, SHED.doorZ1].map((z) => <mesh key={z} geometry={g.box} position={[SHED.x1 + 0.1, SHED.doorH / 2, z]} scale={[0.18, SHED.doorH, 0.14]} material={std('#f2c230', { roughness: 0.5 })} />)}
    {[SHED.x0 - 0.02, SHED.x1 + 0.02].map((x) => <mesh key={x} geometry={gable} position={[x, 0, 0]} rotation={[0, Math.PI / 2, 0]} material={ribbed('gable', wallCol, 1.1, 1.1, THREE.DoubleSide)} />)}
    {/* roof: see-through top sheet + solid corrugated underside (each face is culled from the other side) */}
    {[1, -1].map((side) => {
      const rot = side === 1 ? SLOPE - Math.PI / 2 : -(Math.PI / 2 + SLOPE);
      const cz = SHED_ZC + side * SHED_HALF / 2; const cy = (SHED.ridge + SHED.eave) / 2;
      return <group key={side}>
        <mesh position={[SHED_CX, cy + 0.02, cz]} rotation={[rot, 0, 0]} material={top}><planeGeometry args={[SHED_W + 0.5, len]} /></mesh>
        <mesh position={[SHED_CX, cy - 0.02, cz]} rotation={[rot + Math.PI, 0, 0]} material={ribbed('roof', '#d3dbda', SHED_W / 0.9)}><planeGeometry args={[SHED_W + 0.5, len]} /></mesh>
      </group>;
    })}
    <group ref={inside}>
      <Boxes items={SHED_TRUSS} material={steel} />
      <Boxes items={SHED_LAMPS} material={lamp} />
    </group>
    {/* "ส้มหยุด" sign over the open front, and one on the left gable wall facing the road */}
    <group position={[-0.6, 10.42, SHED.z1 + 0.1]}>
      <mesh geometry={g.box} position={[0, 0, -0.06]} scale={[4.75, 1.3, 0.1]} material={std('#1a2125', { roughness: 0.5 })} />
      <mesh><planeGeometry args={[4.5, 1.125]} /><meshBasicMaterial map={signTex()} toneMapped={false} /></mesh>
    </group>
    <group position={[SHED.x0 - 0.2, 6.6, -7.1]} rotation={[0, -Math.PI / 2, 0]}>
      <mesh geometry={g.box} position={[0, 0, -0.05]} scale={[6.2, 1.7, 0.08]} material={std('#1a2125', { roughness: 0.5 })} />
      <mesh><planeGeometry args={[6, 1.5]} /><meshBasicMaterial map={signTex()} toneMapped={false} /></mesh>
    </group>
  </group>;
}

// ---- Orchard, hills, road, fence, clouds, birds, viewpoint ------------------------------------------
const FENCE = 30.8;
const VIEW = { x: -9, z: 14 };
const BENCHES = [-2.3, 0, 2.3].map((dx) => ({ x: VIEW.x + dx, z: VIEW.z + 0.7 }));
const VIEW_SIGN = { x: VIEW.x + 4.1, z: VIEW.z - 2.2 }; // beside the right end of the railing
type TreeSpot = { x: number; z: number; s: number; fruit: 'orange' | 'apple'; rot: number };
const ORCHARD: TreeSpot[] = (() => {
  const out: TreeSpot[] = [];
  const add = (x: number, z: number, fruit: TreeSpot['fruit']) => {
    const k = `${x},${z}`;
    out.push({ x: x + (hash(`ox${k}`) - 0.5) * 0.5, z: z + (hash(`oz${k}`) - 0.5) * 0.5, s: 0.85 + hash(`os${k}`) * 0.4, fruit, rot: hash(`or${k}`) * Math.PI * 2 });
  };
  [-15, -19.5, -24, -28.5].forEach((z, j) => { for (let x = -27; x <= 27.01; x += 4.5) add(x, z, j % 2 ? 'apple' : 'orange'); });
  [-25, -28.5].forEach((x, j) => [-10.5, -6.5, 7, 11.5, 16, 20.5, 25].forEach((z) => add(x, z, j ? 'apple' : 'orange')));
  [25.5, 29].forEach((x, j) => { for (let z = -10.5; z <= 25.6; z += 4) add(x, z, j ? 'orange' : 'apple'); });
  for (let x = -20; x <= 20.01; x += 5) add(x, 28.5, 'orange');
  return out;
})();
const HILLS = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2 + (hash(`ha${i}`) - 0.5) * 0.3; const d = 95 + hash(`hd${i}`) * 40;
  return { x: Math.cos(a) * d, z: Math.sin(a) * d, sx: 20 + hash(`hx${i}`) * 22, sy: 6 + hash(`hy${i}`) * 11, sz: 16 + hash(`hz${i}`) * 16, rot: hash(`hr${i}`) * 6.28 };
});
const CLOUDS = Array.from({ length: 8 }, (_, i) => ({ x: -150 + i * 40 + hash(`cx${i}`) * 20, y: 28 + hash(`cy${i}`) * 10, z: -95 + hash(`cz${i}`) * 150, s: 3 + hash(`cs${i}`) * 3, v: 0.5 + hash(`cv${i}`) * 0.6 }));
const BIRDS = Array.from({ length: 5 }, (_, i) => ({ cx: -14 + i * 7, cz: -20 + (i % 2) * 26, r: 9 + i * 2.2, y: 13 + (i % 3) * 1.6, w: (0.22 + (i % 3) * 0.06) * (i % 2 ? 1 : -1), ph: i * 1.7 }));

let SCENERY_GEO: ReturnType<typeof makeSceneryGeo> | null = null;
function makeSceneryGeo() {
  const ico = (r: number, d: number, x: number, y: number, z: number) => new THREE.IcosahedronGeometry(r, d).translate(x, y, z);
  const fruitAt = (offset: number) => Array.from({ length: 11 }, (_, i) => {
    const a = i * 2.4 + offset; const y = 1.75 + (i % 3) * 0.38; const rr = 0.98 - (i % 3) * 0.12;
    return ico(0.11, 0, Math.cos(a) * rr, y, Math.sin(a) * rr);
  });
  const hill = new THREE.IcosahedronGeometry(1, 1);
  const p = hill.attributes.position as THREE.BufferAttribute; const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + (hash(`h${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`) - 0.5) * 0.25;
    v.multiplyScalar(n); v.y = Math.max(v.y, -0.1);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  hill.computeVertexNormals();
  const wing = new THREE.BufferGeometry();
  wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.1, 0, 0, -0.1, 0.6, 0.04, -0.06], 3));
  wing.computeVertexNormals();
  return {
    trunk: new THREE.CylinderGeometry(0.12, 0.18, 1.5, 6).translate(0, 0.75, 0),
    canopy: mergeGeos([ico(1.0, 0, 0, 2.2, 0), ico(0.75, 0, 0.55, 1.95, 0.25), ico(0.68, 0, -0.48, 2.5, -0.22), ico(0.6, 0, 0.1, 2.0, -0.6)]),
    orangeFruit: mergeGeos(fruitAt(0)), appleFruit: mergeGeos(fruitAt(0.7)),
    hill,
    cloud: mergeGeos([ico(1.2, 1, 0, 0, 0), ico(0.9, 1, 1.2, -0.2, 0.2), ico(0.85, 1, -1.15, -0.25, -0.1), ico(0.7, 1, 0.4, 0.45, -0.5), ico(0.65, 1, -0.5, 0.3, 0.55)]),
    wing,
  };
}
const sceneryGeo = () => (SCENERY_GEO ??= makeSceneryGeo());

function Orchard() {
  const g = sceneryGeo();
  const { all, greens, oranges, apples } = useMemo(() => {
    const o = new THREE.Object3D();
    const m = (t: TreeSpot) => { o.position.set(t.x, 0, t.z); o.rotation.set(0, t.rot, 0); o.scale.setScalar(t.s); o.updateMatrix(); return o.matrix.clone(); };
    const shades = ['#4fae55', '#3f9b4b', '#5cbd5f', '#47a24f', '#56b65a'];
    return {
      all: ORCHARD.map(m),
      greens: ORCHARD.map((t) => new THREE.Color(shades[Math.floor(hash(`g${t.x},${t.z}`) * shades.length)])),
      oranges: ORCHARD.filter((t) => t.fruit === 'orange').map(m),
      apples: ORCHARD.filter((t) => t.fruit === 'apple').map(m),
    };
  }, []);
  return <>
    <Inst geometry={g.trunk} material={std('#7a5636', { flatShading: true })} matrices={all} />
    <Inst geometry={g.canopy} material={std('#ffffff', { flatShading: true, roughness: 0.9 })} matrices={all} colors={greens} />
    <Inst geometry={g.orangeFruit} material={std(FRUIT_COLOR.orange, { flatShading: true, roughness: 0.6 })} matrices={oranges} />
    <Inst geometry={g.appleFruit} material={std(FRUIT_COLOR.apple, { flatShading: true, roughness: 0.5 })} matrices={apples} />
  </>;
}

function Hills() {
  const { matrices, colors } = useMemo(() => {
    const o = new THREE.Object3D(); const shades = ['#7fb26a', '#6aa35c', '#8cbf73', '#5f9a57'];
    return {
      matrices: HILLS.map((h) => { o.position.set(h.x, 0, h.z); o.rotation.set(0, h.rot, 0); o.scale.set(h.sx, h.sy, h.sz); o.updateMatrix(); return o.matrix.clone(); }),
      colors: HILLS.map((_, i) => new THREE.Color(shades[i % shades.length])),
    };
  }, []);
  return <Inst geometry={sceneryGeo().hill} material={std('#ffffff', { flatShading: true, roughness: 1 })} matrices={matrices} colors={colors} />;
}

const FENCE_ITEMS: BoxItem[] = (() => {
  const out: BoxItem[] = []; const gate = 3.2; const n = 24; const step = (2 * FENCE) / n;
  const post = (x: number, z: number) => out.push({ p: [x, 0.55, z], s: [0.12, 1.1, 0.12] });
  for (let i = 0; i <= n; i++) {
    const t = -FENCE + i * step;
    post(t, -FENCE); post(t, FENCE); post(FENCE, t);
    if (Math.abs(t) > gate) post(-FENCE, t);
  }
  for (const y of [0.45, 0.85]) {
    out.push({ p: [0, y, -FENCE], s: [2 * FENCE, 0.08, 0.05] }, { p: [0, y, FENCE], s: [2 * FENCE, 0.08, 0.05] }, { p: [FENCE, y, 0], s: [0.05, 0.08, 2 * FENCE] });
    for (const s of [-1, 1]) out.push({ p: [-FENCE, y, s * (FENCE + gate) / 2], s: [0.05, 0.08, FENCE - gate] });
  }
  for (const s of [-1, 1]) out.push({ p: [-FENCE, 0.75, s * gate], s: [0.24, 1.5, 0.24] });
  return out;
})();

function Clouds({ night, reduced }: { night: number; reduced: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const m = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1, fog: false, transparent: true, opacity: 0.92 }), []);
  useEffect(() => () => m.dispose(), [m]);
  useEffect(() => { m.color.set(mix('#ffffff', '#3a4660', night)); m.emissive.set(mix('#3d4044', '#000000', night)); }, [m, night]);
  const o = useMemo(() => new THREE.Object3D(), []);
  const place = (t: number) => {
    const mesh = ref.current; if (!mesh) return;
    CLOUDS.forEach((c, i) => {
      const x = ((c.x + t * c.v + 160) % 320 + 320) % 320 - 160;
      o.position.set(x, c.y, c.z); o.scale.set(c.s * 1.6, c.s * 0.8, c.s); o.updateMatrix(); mesh.setMatrixAt(i, o.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  useLayoutEffect(() => place(0));
  useFrame(({ clock }) => { if (!reduced) place(clock.elapsedTime); });
  return <instancedMesh ref={ref} args={[sceneryGeo().cloud, m, CLOUDS.length]} frustumCulled={false} />;
}

function Birds() {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const wing = sceneryGeo().wing;
  const m = mat('bird', () => new THREE.MeshBasicMaterial({ color: '#2b2f33', side: THREE.DoubleSide }));
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    BIRDS.forEach((b, i) => {
      const g = refs.current[i]; if (!g) return;
      const a = b.ph + t * b.w;
      g.position.set(b.cx + Math.cos(a) * b.r, b.y + Math.sin(t * 0.7 + b.ph) * 0.6, b.cz + Math.sin(a) * b.r);
      g.rotation.y = Math.atan2(-Math.sin(a) * b.w, Math.cos(a) * b.w);
      const flap = Math.sin(t * 9 + b.ph) * 0.6;
      (g.children[1] as THREE.Object3D).rotation.z = flap; (g.children[2] as THREE.Object3D).rotation.z = -flap;
    });
  });
  return <>{BIRDS.map((b, i) => <group key={i} ref={(el) => { refs.current[i] = el; }}>
    <mesh geometry={geo().blob} scale={[0.07, 0.06, 0.2]} material={m} />
    <mesh geometry={wing} material={m} />
    <mesh geometry={wing} material={m} scale={[-1, 1, 1]} />
  </group>)}</>;
}

const VIEW_ITEMS: BoxItem[] = (() => {
  const out: BoxItem[] = [];
  for (const b of BENCHES) {
    out.push({ p: [b.x, 0.45, b.z], s: [1.7, 0.07, 0.44] }, { p: [b.x, 0.76, b.z + 0.24], s: [1.7, 0.4, 0.06], r: [-0.14, 0, 0] });
    for (const s of [-1, 1]) out.push({ p: [b.x + s * 0.72, 0.225, b.z], s: [0.08, 0.45, 0.4] });
  }
  for (const s of [-1, 1]) {
    const cx = VIEW.x + s * 2.1;
    out.push({ p: [cx, 0.95, VIEW.z - 2.1], s: [2.6, 0.07, 0.07] }, { p: [cx, 0.55, VIEW.z - 2.1], s: [2.6, 0.05, 0.05] });
    for (let i = 0; i < 5; i++) out.push({ p: [cx - 1.25 + i * 0.625, 0.48, VIEW.z - 2.1], s: [0.09, 0.96, 0.09] });
  }
  out.push({ p: [VIEW_SIGN.x, 0.7, VIEW_SIGN.z], s: [0.1, 1.4, 0.1] });
  return out;
})();
function Viewpoint() {
  const wood = std('#a0784e', { roughness: 0.85 });
  return <group>
    <mesh geometry={geo().box} position={[VIEW.x, 0.04, VIEW.z]} scale={[7, 0.08, 4.4]} material={std('#b88d5e', { roughness: 0.9 })} receiveShadow />
    <Boxes items={VIEW_ITEMS} material={wood} />
    {/* coin telescope pointing at the line */}
    <group position={[VIEW.x - 1.6, 0, VIEW.z - 1.3]}>
      <mesh position={[0, 0.55, 0]} material={std('#2f6b8a', { metalness: 0.5, roughness: 0.4 })}><cylinderGeometry args={[0.05, 0.08, 1.1, 8]} /></mesh>
      <group position={[0, 1.2, 0]} rotation={[0.12, 0.25, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]} material={std('#2f6b8a', { metalness: 0.5, roughness: 0.4 })}><cylinderGeometry args={[0.1, 0.075, 0.5, 12]} /></mesh>
        <mesh geometry={geo().box} position={[0, -0.12, 0.05]} scale={[0.22, 0.16, 0.2]} material={std('#f2c230')} />
      </group>
    </group>
    <group position={[VIEW_SIGN.x, 1.45, VIEW_SIGN.z]}>
      <mesh position={[0, 0, -0.03]} rotation={[0, Math.PI, 0]}><planeGeometry args={[1.3, 0.41]} /><meshStandardMaterial map={viewSignTex()} /></mesh>
      <mesh position={[0, 0, 0.03]}><planeGeometry args={[1.3, 0.41]} /><meshStandardMaterial map={viewSignTex()} /></mesh>
    </group>
  </group>;
}

function Scenery({ env, lite, reduced }: { env: Env; lite: boolean; reduced: boolean }) {
  const track = mix(env.road, '#000000', 0.2);
  const roadLen = SHED.x0 + 220;
  return <group>
    <Orchard />
    <Hills />
    <Boxes items={FENCE_ITEMS} material={std('#9a7650', { roughness: 0.9 })} />
    {/* dirt road from the far hills, through the fence gate, to the left opening of the warehouse */}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[SHED.x0 - roadLen / 2, 0.008, 0]}><planeGeometry args={[roadLen, 4.6]} /><meshStandardMaterial color={env.road} roughness={1} /></mesh>
    {[-0.8, 0.8].map((z) => <mesh key={z} rotation={[-Math.PI / 2, 0, 0]} position={[SHED.x0 - roadLen / 2, 0.011, z]}><planeGeometry args={[roadLen, 0.35]} /><meshStandardMaterial color={track} roughness={1} /></mesh>)}
    <Viewpoint />
    {!lite && <Clouds night={env.night} reduced={reduced} />}
    {!lite && !reduced && <Birds />}
  </group>;
}

// ---- Feed: pickup truck backed up to a hopper, an elevator up to a hood, then a short chute onto the belt ----
const TRUCK_X = -17.6; // truck centre; its tail (+x) is at -15
const HOPPER = { x: -14.35 };
const ELEV_A = new THREE.Vector3(-14.1, 0.55, 0); const ELEV_B = new THREE.Vector3(-12.4, 1.55, 0);
const ELEV_LEN = ELEV_A.distanceTo(ELEV_B); const ELEV_ANG = Math.atan2(ELEV_B.y - ELEV_A.y, ELEV_B.x - ELEV_A.x);
const ELEV_N = new THREE.Vector3(-Math.sin(ELEV_ANG), Math.cos(ELEV_ANG), 0);
const TAIL_FROM = new THREE.Vector3(-15.55, 1.25, 0); const TAIL_EDGE = new THREE.Vector3(-14.55, 1.16, 0); const TAIL_IN = new THREE.Vector3(-14.35, 0.72, 0);
const FEED_PILE = (() => {
  const out: { p: [number, number, number]; c: string; r: number }[] = [];
  const add = (x: number, y: number, z: number) => {
    const k = `${x.toFixed(2)},${y},${z.toFixed(2)}`;
    out.push({ p: [x + (hash(`px${k}`) - 0.5) * 0.08, y + (hash(`py${k}`) - 0.5) * 0.04, z + (hash(`pz${k}`) - 0.5) * 0.08], c: ['#f08a12', '#f59a1c', '#e67a0a', '#f7a42e'][Math.floor(hash(`pc${k}`) * 4)], r: hash(`pr${k}`) * 6.28 });
  };
  const bx = (lx: number) => TRUCK_X + lx; // truck local x -> world
  for (let i = 0; i < 7; i++) for (let j = 0; j < 4; j++) add(bx(0.0 + i * 0.4), 1.25, -0.56 + j * 0.373);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) add(bx(0.2 + i * 0.4), 1.6, -0.37 + j * 0.37);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) add(bx(0.4 + i * 0.4), 1.93, -0.18 + j * 0.36);
  [[-0.2, -0.25], [0.2, -0.3], [-0.25, 0.2], [0.18, 0.28], [0, 0], [-0.05, 0.42]].forEach(([dx, dz]) => add(HOPPER.x + dx, 0.7, dz));
  return out;
})();

function FeedLine({ speed, reduced }: { speed: React.MutableRefObject<number>; reduced: boolean }) {
  const g = geo();
  const white = std('#f3f1ea', { roughness: 0.45, metalness: 0.1 });
  const steel = std('#b7c1c6', { roughness: 0.4, metalness: 0.5 });
  const dark = std('#3b4246', { roughness: 0.7 });
  const glass = std('#1d2a33', { roughness: 0.1, metalness: 0.6 });
  const accent = std('#f68a12', { roughness: 0.5 });
  const fruitMat = mat('feed-fruit', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.72, flatShading: true }));
  const tex = useMemo(() => { const t = stripeTexture(); t.repeat.set(ELEV_LEN / 0.3, 1); return t; }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  const wheel = useMemo(() => new THREE.CylinderGeometry(0.38, 0.38, 0.26, 14), []);
  const hopperGeo = useMemo(() => new THREE.CylinderGeometry(0.85, 0.45, 0.55, 4, 1, true), []);
  useEffect(() => () => { wheel.dispose(); hopperGeo.dispose(); }, [wheel, hopperGeo]);
  const pile = useMemo(() => {
    const o = new THREE.Object3D();
    return {
      matrices: FEED_PILE.map((f) => { o.position.set(...f.p); o.rotation.set(0, f.r, 0.3); o.scale.setScalar(1); o.updateMatrix(); return o.matrix.clone(); }),
      colors: FEED_PILE.map((f) => new THREE.Color(f.c)),
    };
  }, []);
  // 4 fruit riding the elevator + 3 tumbling off the tailgate into the hopper (only while the line runs)
  const moving = useRef<THREE.InstancedMesh>(null);
  const phase = useRef(0);
  const o = useMemo(() => new THREE.Object3D(), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useLayoutEffect(() => {
    const m = moving.current; if (!m) return;
    for (let i = 0; i < 7; i++) m.setColorAt(i, new THREE.Color(i % 2 ? '#f59a1c' : '#f7a42e'));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, []);
  useFrame((_, dt) => {
    const v = speed.current;
    tex.offset.x -= (v * dt * 0.5) / 0.3;
    const on = v > 0.3 && !reduced;
    phase.current += dt * (v / 3.6);
    const m = moving.current; if (!m) return;
    for (let i = 0; i < 7; i++) {
      let show = on;
      if (i < 4) {
        const u = (phase.current * 0.9 + i / 4) % 1;
        tmp.lerpVectors(ELEV_A, ELEV_B, u).addScaledVector(ELEV_N, FRUIT_R + 0.02);
        show = show && u > 0.1 && u < 0.9;
        o.rotation.set(0, 0, -u * 8);
      } else {
        const c = (phase.current * 0.7 + (i - 4) / 3) % 1;
        if (c < 0.6) tmp.lerpVectors(TAIL_FROM, TAIL_EDGE, c / 0.6);
        else { const k = (c - 0.6) / 0.4; tmp.lerpVectors(TAIL_EDGE, TAIL_IN, k); tmp.y = THREE.MathUtils.lerp(TAIL_EDGE.y, TAIL_IN.y, k * k); }
        show = show && c < 0.95;
        o.rotation.set(0, 0, -c * 9);
      }
      o.position.copy(tmp); o.scale.setScalar(show ? 1 : 0); o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  const elevMid = ELEV_A.clone().add(ELEV_B).multiplyScalar(0.5);
  const surfY = (x: number) => ELEV_A.y + ((x - ELEV_A.x) / (ELEV_B.x - ELEV_A.x)) * (ELEV_B.y - ELEV_A.y);
  return <group>
    {/* pickup truck (white with the group stripe + logo on the doors), tail toward the hopper */}
    <group position={[TRUCK_X, 0, 0]}>
      <mesh geometry={g.box} position={[0.1, 0.62, 0]} scale={[4.9, 0.22, 1.45]} material={dark} />
      {[[-1.75, -0.78], [-1.75, 0.78], [1.55, -0.78], [1.55, 0.78]].map(([x, z]) => <group key={`${x}${z}`} position={[x, 0.38, z]} rotation={[Math.PI / 2, 0, 0]}>
        <mesh geometry={wheel} material={std('#1f2326', { roughness: 0.85 })} />
        <mesh scale={[0.5, 1.04, 0.5]} geometry={wheel} material={steel} />
      </group>)}
      <mesh geometry={g.box} position={[-2.0, 1.0, 0]} scale={[1.2, 0.56, 1.72]} material={white} />
      <mesh geometry={g.box} position={[-0.88, 1.22, 0]} scale={[1.12, 1.0, 1.72]} material={white} />
      <mesh geometry={g.box} position={[-1.47, 1.45, 0]} rotation={[0, 0, -0.35]} scale={[0.04, 0.46, 1.5]} material={glass} />
      {[-1, 1].map((s) => <mesh key={`w${s}`} geometry={g.box} position={[-0.8, 1.46, s * 0.865]} scale={[0.8, 0.36, 0.02]} material={glass} />)}
      <mesh geometry={g.box} position={[-0.31, 1.46, 0]} scale={[0.02, 0.32, 1.4]} material={glass} />
      <mesh geometry={g.box} position={[-1.42, 0.86, 0]} scale={[2.38, 0.09, 1.74]} material={accent} />
      <mesh position={[-0.86, 1.06, 0.863]} material={badgeMat()}><planeGeometry args={[0.44, 0.44]} /></mesh>
      <mesh position={[-0.86, 1.06, -0.863]} rotation={[0, Math.PI, 0]} material={badgeMat()}><planeGeometry args={[0.44, 0.44]} /></mesh>
      <mesh geometry={g.box} position={[-2.63, 0.72, 0]} scale={[0.1, 0.16, 1.7]} material={dark} />
      <mesh geometry={g.box} position={[-2.61, 1.02, 0]} scale={[0.03, 0.25, 0.9]} material={dark} />
      {[-1, 1].map((s) => <mesh key={`h${s}`} geometry={g.box} position={[-2.615, 1.05, s * 0.65]} scale={[0.03, 0.12, 0.26]} material={mat('headlight', () => new THREE.MeshBasicMaterial({ color: '#fff6d8', toneMapped: false }))} />)}
      {[-1, 1].map((s) => <mesh key={`m${s}`} geometry={g.box} position={[-1.3, 1.42, s * 0.98]} scale={[0.08, 0.14, 0.18]} material={dark} />)}
      {/* bed with its load of oranges; tailgate open, resting on the hopper rim */}
      <mesh geometry={g.box} position={[1.15, 1.0, 0]} scale={[2.85, 0.08, 1.62]} material={std('#5f6a70', { roughness: 0.7 })} />
      {[-1, 1].map((s) => <mesh key={`b${s}`} geometry={g.box} position={[1.15, 1.25, s * 0.8]} scale={[2.85, 0.42, 0.06]} material={white} />)}
      <mesh geometry={g.box} position={[-0.27, 1.25, 0]} scale={[0.06, 0.42, 1.62]} material={white} />
      {[-1, 1].map((s) => <mesh key={`t${s}`} geometry={g.box} position={[2.58, 1.3, s * 0.79]} scale={[0.03, 0.2, 0.08]} material={mat('taillight', () => new THREE.MeshBasicMaterial({ color: '#ff3b2f', toneMapped: false }))} />)}
      <mesh geometry={g.box} position={[2.82, 1.0, 0]} rotation={[0, 0, -0.12]} scale={[0.5, 0.05, 1.5]} material={white} />
    </group>
    <Inst geometry={g.orange} material={fruitMat} matrices={pile.matrices} colors={pile.colors} />
    <instancedMesh ref={moving} args={[g.orange, fruitMat, 7]} frustumCulled={false} />
    {/* receiving hopper */}
    <group position={[HOPPER.x, 0, 0]}>
      <mesh geometry={hopperGeo} position={[0, 0.725, 0]} rotation={[0, Math.PI / 4, 0]} scale={[1, 1, 1.15]} material={std('#b7c1c6', { roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide })} />
      {[-1, 1].map((s) => <mesh key={`x${s}`} geometry={g.box} position={[0, 1.0, s * 0.69]} scale={[1.25, 0.06, 0.06]} material={accent} />)}
      {[-1, 1].map((s) => <mesh key={`z${s}`} geometry={g.box} position={[s * 0.6, 1.0, 0]} scale={[0.06, 0.06, 1.4]} material={accent} />)}
      {[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => <mesh key={`l${sx}${sz}`} geometry={g.box} position={[sx * 0.42, 0.37, sz * 0.48]} scale={[0.07, 0.74, 0.07]} material={dark} />)}
    </group>
    {/* elevator (cleated belt) up to the hood */}
    <group position={elevMid} rotation={[0, 0, ELEV_ANG]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[ELEV_LEN, 0.62]} /><meshStandardMaterial map={tex} roughness={0.85} /></mesh>
      <mesh geometry={g.box} position={[0, -0.07, 0]} scale={[ELEV_LEN, 0.12, 0.72]} material={steel} />
      {[-1, 1].map((s) => <mesh key={s} geometry={g.box} position={[0, 0.06, s * 0.36]} scale={[ELEV_LEN, 0.16, 0.05]} material={accent} />)}
    </group>
    {[-13.55, -12.65].map((x) => [-1, 1].map((s) => <mesh key={`${x}${s}`} geometry={g.box} position={[x, (surfY(x) - 0.12) / 2, s * 0.3]} scale={[0.08, surfY(x) - 0.12, 0.08]} material={dark} />))}
    <mesh geometry={g.box} position={[-12.3, 1.75, 0]} scale={[0.75, 0.62, 0.95]} material={steel} />
    <mesh geometry={g.box} position={[-12.3, 1.75, 0]} scale={[0.77, 0.12, 0.97]} material={accent} />
    <mesh geometry={g.box} position={[-12.3, 0.8, 0]} scale={[0.1, 1.6, 0.1]} material={dark} />
    {/* chute from the hood onto the start of the main belt */}
    <group position={[-11.65, 1.04, 0]} rotation={[0, 0, Math.atan2(-0.36, 0.8)]}>
      <mesh geometry={g.box} scale={[0.88, 0.04, 0.6]} material={steel} />
      {[-1, 1].map((s) => <mesh key={s} geometry={g.box} position={[0, 0.06, s * 0.3]} scale={[0.88, 0.12, 0.03]} material={accent} />)}
    </group>
  </group>;
}

// ---- Pets: salmon tabby cat + chihuahua; they wander around the colliders, sit, groom / sniff and nap ----------
const PET_AREA = { x0: -19.5, x1: 19.5, z0: -8.6, z1: 15.5 };
function petClear(x: number, z: number) {
  if (x < PET_AREA.x0 || x > PET_AREA.x1 || z < PET_AREA.z0 || z > PET_AREA.z1) return false;
  for (const c of allColliders()) {
    const dx = c.bx - c.ax; const dz = c.bz - c.az; const len = dx * dx + dz * dz;
    const t = len ? clamp01(((x - c.ax) * dx + (z - c.az) * dz) / len) : 0;
    if (Math.hypot(x - (c.ax + dx * t), z - (c.az + dz * t)) < c.r + 0.3) return false;
  }
  return true;
}
function petPath(ax: number, az: number, bx: number, bz: number) {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.3));
  for (let i = 1; i <= n; i++) if (!petClear(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)) return false;
  return true;
}
type PetMode = 'walk' | 'sit' | 'groom' | 'lie';
type PetState = { x: number; z: number; yaw: number; mode: PetMode; until: number; tx: number; tz: number; ph: number; walkK: number; sitK: number; lieK: number; groomK: number; callAt: number };
const newPet = (x: number, z: number, yaw: number): PetState => ({ x, z, yaw, mode: 'sit', until: 0, tx: 0, tz: 0, ph: 0, walkK: 0, sitK: 1, lieK: 0, groomK: 0, callAt: -10 });
// Moves the pet (walk to a free spot, then rest a while); returns dt and now for the pose code.
function stepPet(s: PetState, raw: number, reduced: boolean, speed: number, stride: number) {
  const dt = Math.min(raw, 0.05); const now = performance.now() / 1000;
  const rest = () => {
    const r = Math.random();
    s.mode = r < 0.4 ? 'sit' : r < 0.7 ? 'groom' : 'lie';
    s.until = now + (s.mode === 'lie' ? 7 + Math.random() * 8 : 3 + Math.random() * 4);
  };
  if (!s.until) s.until = now + 2;
  if (s.mode === 'walk') {
    const dx = s.tx - s.x; const dz = s.tz - s.z; const d = Math.hypot(dx, dz);
    let diff = Math.atan2(dx, dz) - s.yaw; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    s.yaw += THREE.MathUtils.clamp(diff, -2.5 * dt, 2.5 * dt);
    const step = Math.min(d, (Math.abs(diff) < 0.6 ? speed : speed * 0.2) * dt);
    const nx = s.x + Math.sin(s.yaw) * step; const nz = s.z + Math.cos(s.yaw) * step;
    if (d < 0.08 || !petClear(nx, nz)) rest();
    else { s.x = nx; s.z = nz; s.ph += step * stride; }
  } else if (now > s.until) {
    if (reduced) { s.mode = s.mode === 'lie' ? 'sit' : 'lie'; s.until = now + 10; }
    else if (Math.random() < 0.65) {
      let found = false;
      for (let i = 0; i < 14 && !found; i++) {
        const a = Math.random() * Math.PI * 2; const dist = 1.5 + Math.random() * 6;
        const tx = s.x + Math.sin(a) * dist; const tz = s.z + Math.cos(a) * dist;
        if (petClear(tx, tz) && petPath(s.x, s.z, tx, tz)) { s.tx = tx; s.tz = tz; s.mode = 'walk'; found = true; }
      }
      if (!found) { s.mode = 'sit'; s.until = now + 2; }
    } else rest();
  }
  const k = 1 - Math.exp(-dt * 5);
  s.walkK += ((s.mode === 'walk' ? 1 : 0) - s.walkK) * k;
  s.lieK += ((s.mode === 'lie' ? 1 : 0) - s.lieK) * k;
  s.groomK += ((s.mode === 'groom' ? 1 : 0) - s.groomK) * k;
  return { dt, now, k };
}
// Click reaction: play the sound, sit down, show a speech bubble for 1.6 s.
function usePetCall(key: number, s: React.MutableRefObject<PetState>, sound: () => void) {
  const [bubble, setBubble] = useState(0);
  useEffect(() => {
    if (!key) return;
    sound();
    const now = performance.now() / 1000; const p = s.current;
    p.callAt = now;
    if (p.mode === 'walk' || p.mode === 'lie') { p.mode = 'sit'; p.until = now + 3; }
    setBubble(key);
    const id = window.setTimeout(() => setBubble(0), 1600);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return bubble;
}

let AUDIO: AudioContext | null = null;
function audioCtx() {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  AUDIO ??= new Ctx();
  void AUDIO.resume?.();
  return AUDIO;
}
// "Mee-ow": the mouth (low-pass) opens for the "m", two vowel formants glide "ee" to "ow", then the mouth closes.
function meow() {
  try {
    const ac = audioCtx(); if (!ac) return;
    const t = ac.currentTime + 0.01; const k = 0.92 + Math.random() * 0.16; const d = 0.6 + Math.random() * 0.12;
    const o = ac.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(520 * k, t);
    o.frequency.linearRampToValueAtTime(700 * k, t + d * 0.2);
    o.frequency.linearRampToValueAtTime(780 * k, t + d * 0.38);
    o.frequency.linearRampToValueAtTime(600 * k, t + d * 0.75);
    o.frequency.linearRampToValueAtTime(470 * k, t + d);
    const vib = ac.createOscillator(); vib.frequency.value = 5.5;
    const vg = ac.createGain(); vg.gain.value = 6; vib.connect(vg).connect(o.frequency);
    const mouth = ac.createBiquadFilter(); mouth.type = 'lowpass'; mouth.Q.value = 0.9;
    mouth.frequency.setValueAtTime(350, t); mouth.frequency.linearRampToValueAtTime(3200, t + d * 0.2);
    mouth.frequency.linearRampToValueAtTime(2600, t + d * 0.6); mouth.frequency.linearRampToValueAtTime(650, t + d);
    const f1 = ac.createBiquadFilter(); f1.type = 'peaking'; f1.Q.value = 4; f1.gain.value = 10;
    f1.frequency.setValueAtTime(1000, t); f1.frequency.linearRampToValueAtTime(1500, t + d * 0.33); f1.frequency.linearRampToValueAtTime(900, t + d * 0.9);
    const f2 = ac.createBiquadFilter(); f2.type = 'peaking'; f2.Q.value = 5; f2.gain.value = 8;
    f2.frequency.setValueAtTime(2700, t); f2.frequency.linearRampToValueAtTime(2200, t + d * 0.5); f2.frequency.linearRampToValueAtTime(1400, t + d * 0.9);
    const v = ac.createGain();
    v.gain.setValueAtTime(0.0001, t); v.gain.linearRampToValueAtTime(0.2, t + 0.07);
    v.gain.setValueAtTime(0.2, t + d * 0.65); v.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.02);
    o.connect(mouth).connect(f1).connect(f2).connect(v).connect(ac.destination);
    o.start(t); vib.start(t); o.stop(t + d + 0.05); vib.stop(t + d + 0.05);
  } catch { /* audio not available */ }
}
// Two short chihuahua yips: a falling squeak through a band-pass plus a puff of noise.
function bark() {
  try {
    const ac = audioCtx(); if (!ac) return;
    const noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.12), ac.sampleRate);
    const data = noise.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    [0, 0.2].forEach((off, n) => {
      const t = ac.currentTime + 0.01 + off; const k = 1 + n * 0.08 + Math.random() * 0.06;
      const o = ac.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(950 * k, t); o.frequency.linearRampToValueAtTime(1250 * k, t + 0.025); o.frequency.exponentialRampToValueAtTime(620 * k, t + 0.11);
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1700; f.Q.value = 1.4;
      const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.connect(f).connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.15);
      const src = ac.createBufferSource(); src.buffer = noise;
      const nf = ac.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2500; nf.Q.value = 0.8;
      const ng = ac.createGain(); ng.gain.value = 0.06;
      src.connect(nf).connect(ng).connect(ac.destination); src.start(t);
    });
  } catch { /* audio not available */ }
}

const catFur = () => mat('cat-fur', () => new THREE.MeshStandardMaterial({
  roughness: 0.95,
  map: canvasTex('cat-stripes', 64, 128, (g, w, h) => {
    g.fillStyle = '#f4a27c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#d4693f';
    for (let i = 0; i < 9; i++) {
      const y = 8 + i * 13;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= w; x += 8) g.lineTo(x, y + Math.sin(x * 0.25 + i) * 2);
      for (let x = w; x >= 0; x -= 8) g.lineTo(x, y + 5 + Math.sin(x * 0.3 + i * 2) * 2);
      g.closePath(); g.fill();
    }
  }),
}));
type PetProps = { callKey: number; onCall: () => void; reduced: boolean; marker: React.MutableRefObject<SVGCircleElement | null> };
function petHit(kind: 'cat' | 'dog', onCall: () => void, gl: THREE.WebGLRenderer, y: number, s: number) {
  return <mesh geometry={geo().hit} position={[0, y, 0.08]} scale={s} material={hitMat()} userData={{ pet: kind }}
    onClick={(e) => { e.stopPropagation(); onCall(); }}
    onPointerOver={(e) => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = ''; }} />;
}
function Cat({ callKey, onCall, reduced, marker }: PetProps) {
  const root = useRef<THREE.Group>(null); const hip = useRef<THREE.Group>(null); const upper = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null); const tail = useRef<THREE.Group>(null); const tail2 = useRef<THREE.Group>(null);
  const legs = useRef<(THREE.Group | null)[]>([]); // front left, front right, back left, back right
  const gl = useThree((st) => st.gl);
  const st = useRef(newPet(3, 6.4, -2.4));
  const bubble = usePetCall(callKey, st, meow);
  useFrame((_, raw) => {
    const s = st.current;
    const { now, k } = stepPet(s, raw, reduced, 0.45, 13);
    s.sitK += ((s.mode === 'sit' || s.mode === 'groom' ? 1 : 0) - s.sitK) * k;
    if (root.current) { root.current.position.set(s.x, 0, s.z); root.current.rotation.y = s.yaw; }
    if (marker.current) { marker.current.setAttribute('cx', s.x.toFixed(2)); marker.current.setAttribute('cy', s.z.toFixed(2)); }
    if (hip.current) hip.current.position.y = 0.22 - 0.06 * s.sitK - 0.12 * s.lieK;
    if (upper.current) upper.current.rotation.x = -0.55 * s.sitK;
    const swing = Math.sin(s.ph) * 0.55 * s.walkK;
    const L = legs.current; const tuck = 1 - 0.68 * s.lieK;
    if (L[0]) { L[0].rotation.x = swing + 0.55 * s.sitK; L[0].scale.y = (1 + 0.6 * s.sitK) * tuck; }
    if (L[1]) { L[1].rotation.x = -swing + 0.55 * s.sitK - s.groomK * (1.3 + 0.25 * Math.sin(now * 7)); L[1].scale.y = (1 + 0.6 * s.sitK) * tuck; }
    if (L[2]) { L[2].rotation.x = -swing - 1.1 * s.sitK - 1.2 * s.lieK; L[2].scale.y = (1 - 0.4 * s.sitK) * tuck; }
    if (L[3]) { L[3].rotation.x = swing - 1.1 * s.sitK - 1.2 * s.lieK; L[3].scale.y = (1 - 0.4 * s.sitK) * tuck; }
    const since = now - s.callAt;
    if (head.current) {
      head.current.rotation.x = 0.45 * s.sitK + s.groomK * (0.55 + 0.2 * Math.sin(now * 7)) + 0.15 * s.lieK - (since < 0.9 ? 0.3 : 0);
      head.current.rotation.y = s.groomK * 0.5 + (reduced ? 0 : Math.sin(now * 0.4) * 0.25 * (1 - s.walkK) * (1 - s.groomK));
      head.current.rotation.z = since < 0.9 ? Math.sin(since * 12) * 0.15 : 0;
    }
    if (tail.current) tail.current.rotation.x = -0.75 + 0.35 * s.walkK - 0.8 * s.lieK + (reduced ? 0 : 0.15 * Math.sin(now * 1.6));
    if (tail2.current) tail2.current.rotation.z = reduced ? 0.3 : Math.sin(now * 2.1) * 0.45;
  });
  const g = geo();
  const fur = catFur(); const plain = std('#f4a27c', { roughness: 0.95 }); const stripe = std('#d4693f', { roughness: 0.95 });
  const cream = std('#fbe3cf', { roughness: 0.95 }); const pink = std('#ef8f9c'); const eye = std('#1b2a1a', { roughness: 0.2 });
  const ear = useMemo(() => new THREE.ConeGeometry(0.045, 0.09, 4), []);
  const seg = useMemo(() => new THREE.CylinderGeometry(0.022, 0.03, 1, 6), []);
  useEffect(() => () => { ear.dispose(); seg.dispose(); }, [ear, seg]);
  const leg = (i: number, x: number, z: number, parentY: number) => <group key={i} ref={(el) => { legs.current[i] = el; }} position={[x, parentY, z]}>
    <mesh geometry={g.box} position={[0, -0.1, 0]} scale={[0.05, 0.2, 0.055]} material={plain} />
    <mesh geometry={g.blob} position={[0, -0.2, 0.012]} scale={[0.03, 0.018, 0.04]} material={cream} />
  </group>;
  return <group ref={root}>
    <group ref={hip} position={[0, 0.22, -0.14]}>
      {leg(2, -0.065, 0, 0)}
      {leg(3, 0.065, 0, 0)}
      <group ref={upper}>
        <mesh geometry={g.blob} position={[0, 0.02, 0.17]} rotation={[Math.PI / 2, 0, 0]} scale={[0.12, 0.25, 0.11]} material={fur} castShadow />
        <mesh geometry={g.blob} position={[0, -0.04, 0.17]} scale={[0.095, 0.07, 0.2]} material={cream} />
        <mesh geometry={g.blob} position={[0, 0.07, 0.34]} scale={[0.085, 0.1, 0.085]} material={plain} />
        {leg(0, -0.06, 0.33, -0.02)}
        {leg(1, 0.06, 0.33, -0.02)}
        <group ref={head} position={[0, 0.16, 0.42]}>
          <mesh geometry={g.blob} scale={[0.1, 0.088, 0.095]} material={plain} castShadow />
          <mesh geometry={g.blob} position={[0, -0.032, 0.07]} scale={[0.052, 0.036, 0.04]} material={cream} />
          <mesh geometry={g.blob} position={[0, -0.008, 0.105]} scale={0.014} material={pink} />
          {[-1, 1].map((s) => <mesh key={`e${s}`} geometry={g.blob} position={[s * 0.04, 0.018, 0.083]} scale={[0.017, 0.02, 0.012]} material={eye} />)}
          {[-1, 1].map((s) => <mesh key={`r${s}`} geometry={ear} position={[s * 0.056, 0.085, -0.01]} rotation={[0, 0, -s * 0.28]} material={plain} />)}
          {[-0.025, 0, 0.025].map((x) => <mesh key={`m${x}`} geometry={g.box} position={[x, 0.07, 0.05]} rotation={[-0.6, 0, x * 8]} scale={[0.01, 0.004, 0.04]} material={stripe} />)}
        </group>
        <group ref={tail} position={[0, 0.05, -0.07]}>
          <mesh geometry={seg} position={[0, 0.07, 0]} scale={[1, 0.14, 1]} material={plain} />
          <mesh geometry={seg} position={[0, 0.18, 0]} scale={[0.9, 0.09, 0.9]} material={stripe} />
          <group ref={tail2} position={[0, 0.22, 0]} rotation={[-0.5, 0, 0]}>
            <mesh geometry={seg} position={[0, 0.06, 0]} scale={[0.85, 0.12, 0.85]} material={plain} />
            <mesh geometry={seg} position={[0, 0.16, 0]} scale={[0.75, 0.09, 0.75]} material={stripe} />
          </group>
        </group>
      </group>
    </group>
    {petHit('cat', onCall, gl, 0.28, 0.75)}
    {bubble > 0 && <Html position={[0, 0.82, 0.1]} center zIndexRange={[7, 0]} style={{ pointerEvents: 'none' }}>
      <div key={bubble} className="lv3d-meow">เมี้ยว</div>
    </Html>}
  </group>;
}

// Chihuahua: small tan dog with big ears; trots faster than the cat and sniffs the floor instead of grooming.
function Dog({ callKey, onCall, reduced, marker }: PetProps) {
  const root = useRef<THREE.Group>(null); const hip = useRef<THREE.Group>(null); const upper = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null); const tail = useRef<THREE.Group>(null);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const gl = useThree((st) => st.gl);
  const st = useRef(newPet(-1.2, 9.6, 2.6));
  const bubble = usePetCall(callKey, st, bark);
  useFrame((_, raw) => {
    const s = st.current;
    const { now, k } = stepPet(s, raw, reduced, 0.75, 24);
    s.sitK += ((s.mode === 'sit' ? 1 : 0) - s.sitK) * k;
    if (root.current) { root.current.position.set(s.x, 0, s.z); root.current.rotation.y = s.yaw; }
    if (marker.current) { marker.current.setAttribute('cx', s.x.toFixed(2)); marker.current.setAttribute('cy', s.z.toFixed(2)); }
    const trot = s.walkK * Math.abs(Math.sin(s.ph)) * 0.015;
    if (hip.current) hip.current.position.y = 0.17 - 0.05 * s.sitK - 0.1 * s.lieK + trot;
    if (upper.current) upper.current.rotation.x = -0.5 * s.sitK;
    const swing = Math.sin(s.ph) * 0.6 * s.walkK;
    const L = legs.current; const tuck = 1 - 0.7 * s.lieK;
    if (L[0]) { L[0].rotation.x = swing + 0.5 * s.sitK; L[0].scale.y = (1 + 0.55 * s.sitK) * tuck; }
    if (L[1]) { L[1].rotation.x = -swing + 0.5 * s.sitK; L[1].scale.y = (1 + 0.55 * s.sitK) * tuck; }
    if (L[2]) { L[2].rotation.x = -swing - 1.1 * s.sitK - 1.2 * s.lieK; L[2].scale.y = (1 - 0.4 * s.sitK) * tuck; }
    if (L[3]) { L[3].rotation.x = swing - 1.1 * s.sitK - 1.2 * s.lieK; L[3].scale.y = (1 - 0.4 * s.sitK) * tuck; }
    const since = now - s.callAt;
    if (head.current) {
      // sniffing the floor (the "groom" mode), looking around, a little hop of the head when it barks
      head.current.rotation.x = 0.4 * s.sitK + s.groomK * (0.75 + 0.15 * Math.sin(now * 9)) + 0.2 * s.lieK - (since < 0.5 ? 0.35 * Math.sin(since * 12) : 0);
      head.current.rotation.y = reduced ? 0 : Math.sin(now * 0.7) * 0.35 * (1 - s.walkK);
      head.current.rotation.z = (1 - s.walkK) * 0.15 * Math.sin(now * 0.5);
    }
    if (tail.current) tail.current.rotation.z = reduced ? 0 : Math.sin(now * (s.walkK > 0.5 || since < 3 ? 16 : 5)) * 0.5 * (1 - s.lieK);
  });
  const g = geo();
  const tan = std('#d8a465', { roughness: 0.9 }); const cream = std('#f3dcb8', { roughness: 0.9 });
  const dark = std('#1d1a18', { roughness: 0.25 }); const pink = std('#ef9aa8'); const collar = std('#d6332b', { roughness: 0.5 });
  const ear = useMemo(() => new THREE.ConeGeometry(0.042, 0.11, 4), []);
  const seg = useMemo(() => new THREE.CylinderGeometry(0.012, 0.018, 1, 6), []);
  const ring = useMemo(() => new THREE.TorusGeometry(0.05, 0.011, 6, 14), []);
  useEffect(() => () => { ear.dispose(); seg.dispose(); ring.dispose(); }, [ear, seg, ring]);
  const leg = (i: number, x: number, z: number, parentY: number) => <group key={i} ref={(el) => { legs.current[i] = el; }} position={[x, parentY, z]}>
    <mesh geometry={g.box} position={[0, -0.08, 0]} scale={[0.026, 0.16, 0.03]} material={tan} />
    <mesh geometry={g.blob} position={[0, -0.16, 0.008]} scale={[0.018, 0.012, 0.024]} material={cream} />
  </group>;
  return <group ref={root}>
    <group ref={hip} position={[0, 0.17, -0.1]}>
      {leg(2, -0.045, 0, 0)}
      {leg(3, 0.045, 0, 0)}
      <group ref={upper}>
        <mesh geometry={g.blob} position={[0, 0.02, 0.1]} scale={[0.085, 0.075, 0.15]} material={tan} castShadow />
        <mesh geometry={g.blob} position={[0, -0.005, 0.19]} scale={[0.062, 0.062, 0.06]} material={cream} />
        <mesh geometry={ring} position={[0, 0.065, 0.225]} rotation={[Math.PI / 2 - 0.4, 0, 0]} material={collar} />
        <mesh geometry={g.blob} position={[0, 0.02, 0.272]} scale={0.012} material={std('#f2c230', { metalness: 0.6, roughness: 0.3 })} />
        {leg(0, -0.04, 0.19, -0.02)}
        {leg(1, 0.04, 0.19, -0.02)}
        <group ref={head} position={[0, 0.13, 0.26]}>
          <mesh geometry={g.blob} scale={[0.075, 0.07, 0.07]} material={tan} castShadow />
          <mesh geometry={g.blob} position={[0, -0.025, 0.062]} scale={[0.032, 0.026, 0.035]} material={cream} />
          <mesh geometry={g.blob} position={[0, -0.016, 0.096]} scale={0.011} material={dark} />
          {[-1, 1].map((s) => <mesh key={`e${s}`} geometry={g.blob} position={[s * 0.034, 0.012, 0.056]} scale={[0.016, 0.018, 0.012]} material={dark} />)}
          {[-1, 1].map((s) => <group key={`r${s}`} position={[s * 0.05, 0.075, -0.005]} rotation={[0, 0, -s * 0.5]}>
            <mesh geometry={ear} material={tan} />
            <mesh geometry={ear} position={[0, -0.005, 0.012]} scale={[0.6, 0.75, 0.4]} material={pink} />
          </group>)}
        </group>
        <group ref={tail} position={[0, 0.05, -0.04]} rotation={[-1.0, 0, 0]}>
          <mesh geometry={seg} position={[0, 0.05, 0]} scale={[1, 0.1, 1]} material={tan} />
          <mesh geometry={seg} position={[0, 0.11, 0.025]} rotation={[0.7, 0, 0]} scale={[0.85, 0.07, 0.85]} material={tan} />
        </group>
      </group>
    </group>
    {petHit('dog', onCall, gl, 0.2, 0.55)}
    {bubble > 0 && <Html position={[0, 0.62, 0.1]} center zIndexRange={[7, 0]} style={{ pointerEvents: 'none' }}>
      <div key={bubble} className="lv3d-meow">โฮ่ง!</div>
    </Html>}
  </group>;
}

// ---- Team figures: the four members stand at their part of the line; walk up and press E to see who they are --------
const TEAM = [
  { letter: 'A', no: '01', name: 'วุฒิไกร แย้มพุ่ม', nick: 'วุฒิไกร', role: 'Dataset / Labeling', desc: 'จัดเตรียมชุดข้อมูลและทำ Labeling ให้พร้อมสำหรับการเทรน', color: '#f5a623', hair: 'short', x: -12.2, z: 3.4, rot: 0.3 },
  { letter: 'B', no: '02', name: 'ธาริณี สนิทสตรี', nick: 'ธาริณี', role: 'Training (CIRA CORE)', desc: 'ฝึกและพัฒนาโมเดลสำหรับการตรวจจับผลไม้และตำหนิ', color: '#22b8a0', hair: 'long', x: -7.9, z: 2.4, rot: 0.4 },
  { letter: 'C', no: '03', name: 'ณัฐกฤษณ์ เบ้าสาลี', nick: 'ณัฐกฤษณ์', role: 'Coding & Functions', desc: 'พัฒนาฟังก์ชันและโค้ดที่เชื่อมการทำงานของระบบ', color: '#8a63d2', hair: 'short', x: -2.6, z: 6.6, rot: -0.3 },
  { letter: 'D', no: '04', name: 'ศรัณย์ภัทร ตรีเพียร', nick: 'ศรัณย์ภัทร', role: 'Platform & Dashboard', desc: 'ออกแบบแพลตฟอร์มและ Dashboard สำหรับติดตามระบบ', color: '#3a9be0', hair: 'short', x: 0.4, z: -7.3, rot: 0 },
] as const;
type Member = (typeof TEAM)[number];
const letterTex = (m: Member) => canvasTex(`team-${m.letter}`, 128, 128, (g, w, h, font) => {
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
  g.fillStyle = m.color; g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff'; g.font = `900 72px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(m.letter, 64, 68);
});
function TeamMember({ m, i, talking, onTeam }: { m: Member; i: number; talking: boolean; onTeam: (i: number) => void }) {
  const head = useRef<THREE.Group>(null); const arm = useRef<THREE.Group>(null); const body = useRef<THREE.Group>(null);
  const gl = useThree((st) => st.gl);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + i * 1.7;
    if (body.current) body.current.scale.y = 1 + Math.sin(t * 1.6) * 0.008;
    if (head.current) head.current.rotation.y = talking ? 0 : Math.sin(t * 0.45) * 0.35;
    if (arm.current) arm.current.rotation.z = talking ? 2.6 + Math.sin(t * 8) * 0.3 : 0.06;
  });
  const g = geo();
  const shirt = std(m.color, { flatShading: true, roughness: 0.7 }); const pants = std('#34404a', { flatShading: true });
  const skin = std('#e7b48a', { flatShading: true }); const hair = std('#2b2118', { flatShading: true, roughness: 0.6 });
  return <group position={[m.x, 0, m.z]} rotation={[0, m.rot, 0]}>
    <group ref={body}>
      {[-0.12, 0.12].map((x) => <group key={x} position={[x, 0, 0]}>
        <mesh geometry={g.box} position={[0, 0.41, 0]} scale={[0.17, 0.8, 0.19]} material={pants} castShadow />
        <mesh geometry={g.box} position={[0, 0.03, 0.05]} scale={[0.19, 0.08, 0.3]} material={std('#f4f4f4')} />
      </group>)}
      <mesh geometry={g.box} position={[0, 1.13, 0]} scale={[0.5, 0.64, 0.28]} material={shirt} castShadow />
      <mesh position={[0.12, 1.28, 0.142]} material={mat(`team-badge-${m.letter}`, () => new THREE.MeshBasicMaterial({ map: letterTex(m), transparent: true, alphaTest: 0.5 }))}><planeGeometry args={[0.15, 0.15]} /></mesh>
      <group position={[-0.33, 1.4, 0]}>
        <mesh geometry={g.box} position={[0, -0.28, 0]} scale={[0.13, 0.58, 0.15]} material={shirt} castShadow />
        <mesh geometry={g.box} position={[0, -0.6, 0]} scale={[0.11, 0.1, 0.12]} material={skin} />
      </group>
      <group ref={arm} position={[0.33, 1.4, 0]}>
        <mesh geometry={g.box} position={[0, -0.28, 0]} scale={[0.13, 0.58, 0.15]} material={shirt} castShadow />
        <mesh geometry={g.box} position={[0, -0.6, 0]} scale={[0.11, 0.1, 0.12]} material={skin} />
      </group>
      <group ref={head} position={[0, 1.62, 0]}>
        <mesh geometry={g.blob} scale={0.17} material={skin} castShadow />
        <mesh geometry={g.blob} position={[0, 0.06, -0.02]} scale={[0.182, 0.13, 0.18]} material={hair} />
        {m.hair === 'long' && <mesh geometry={g.box} position={[0, -0.1, -0.1]} scale={[0.32, 0.38, 0.1]} material={hair} />}
        {[-1, 1].map((s) => <mesh key={s} geometry={g.blob} position={[s * 0.06, 0.01, 0.155]} scale={[0.02, 0.026, 0.01]} material={std('#1d1a18')} />)}
      </group>
    </group>
    <mesh geometry={g.box} position={[0, 0.95, 0]} scale={[0.75, 1.95, 0.6]} material={hitMat()} userData={{ team: i }}
      onClick={(e) => { e.stopPropagation(); onTeam(i); }}
      onPointerOver={(e) => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = ''; }} />
    <Html position={[0, 2.08, 0]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
      <div className="lv3d-member" style={{ ['--c' as string]: m.color }}><b>{m.letter}</b>{m.nick}</div>
    </Html>
  </group>;
}
function TeamCard({ i, onClose }: { i: number; onClose: () => void }) {
  const m = TEAM[i];
  return <div className="lv3d-team" style={{ ['--c' as string]: m.color }} role="dialog" aria-label={`สมาชิก ${m.name}`}>
    <div className="lv3d-team-head">
      <i>{m.letter}</i><span>สมาชิกทีม · {m.no}</span>
      <button type="button" title="ปิด (Esc)" onClick={onClose}><X size={13} /></button>
    </div>
    <small>ชื่อ-นามสกุล</small>
    <strong>{m.name}</strong>
    <small>หน้าที่ในทีม</small>
    <b>{m.role}</b>
    <p>{m.desc}</p>
    <em>ทีมส้มหยุด · ระบบคัดแยกผลไม้ CIRA CORE</em>
  </div>;
}

// ---- Emergency drills: visual-only test cases started from the panel next to the control console.
// Nothing here sends a command or writes data; counts and the replay keep running as usual.
type Emerg = 'fire' | 'power' | 'jam' | 'camera' | 'estop';
const EMERG: Record<Emerg, { label: string; color: string; level: 'warning' | 'critical'; desc: string }> = {
  fire: { label: 'ไฟไหม้', color: '#ff3b2f', level: 'critical', desc: 'เปลวไฟและควันที่มุมโกดัง ไฟแดงหมุนรอบโกดัง' },
  power: { label: 'ไฟดับ', color: '#ffd21f', level: 'warning', desc: 'ไฟในโกดังดับ เหลือไฟฉุกเฉินสีเหลือง' },
  jam: { label: 'สายพานติด', color: '#ff9b2f', level: 'warning', desc: 'ไฟเตือนกะพริบตลอดสายพานหลัก' },
  camera: { label: 'กล้องขัดข้อง', color: '#4f8dff', level: 'warning', desc: 'ไฟสถานะกล้องเป็นสีแดงกะพริบ' },
  estop: { label: 'หยุดฉุกเฉิน', color: '#ff3b2f', level: 'critical', desc: 'ไฟแดงรอบโกดังและไซเรน' },
};
const EMERG_KEYS = Object.keys(EMERG) as Emerg[];
const EMERG_SEC = 30;
const TEST_PANEL = { x: -8.3, z: 5.8 }; // left of the control console (CONSOLE)
const FIRE_AT = { x: -18.2, z: -7.4 };
const BEACONS: [number, number][] = [[SHED.x0 + 0.3, SHED.z1], [SHED.x1 - 0.3, SHED.z1], [SHED.x0 + 0.3, 2.5], [SHED.x1 - 0.3, 2.5], [SHED.x0 + 0.3, SHED.sideZ], [SHED.x1 - 0.3, SHED.sideZ], [-14, SHED.z0 + 0.5], [0, SHED.z0 + 0.5], [14, SHED.z0 + 0.5]];

function EmergencyPanel({ active, onPress }: { active: Emerg | null; onPress: (e: Emerg) => void }) {
  const g = geo();
  const gl = useThree((st) => st.gl);
  const caps = useMemo(() => EMERG_KEYS.map((k) => new THREE.MeshStandardMaterial({ color: EMERG[k].color, emissive: new THREE.Color(EMERG[k].color), emissiveIntensity: 0.2, roughness: 0.35 })), []);
  useEffect(() => () => caps.forEach((m) => m.dispose()), [caps]);
  useFrame(({ clock }) => {
    caps.forEach((m, i) => { m.emissiveIntensity = EMERG_KEYS[i] === active ? 0.9 + 0.6 * Math.sin(clock.elapsedTime * 9) : 0.25; });
  });
  const tex = canvasTex('emerg-panel', 1024, 440, (c, w, h, font) => {
    c.fillStyle = '#1a1206'; c.fillRect(0, 0, w, h);
    for (let x = -h; x < w; x += 60) { c.fillStyle = '#f2c230'; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 30, 0); c.lineTo(x + 30 + 26, 26); c.lineTo(x + 26, 26); c.fill(); }
    c.fillStyle = '#ffd27a'; c.font = `900 50px ${font}`; c.textAlign = 'center'; c.fillText('จำลองเหตุฉุกเฉิน', w / 2, 92);
    c.fillStyle = '#cfd8d3'; c.font = `600 26px ${font}`; c.fillText('โหมดทดสอบ · แค่ภาพในฉาก ไม่ส่งคำสั่ง ไม่กระทบระบบ', w / 2, 136);
    EMERG_KEYS.forEach((k, i) => { c.fillStyle = '#ffffff'; c.font = `800 28px ${font}`; c.fillText(EMERG[k].label, 112 + i * 200, 392); });
  });
  return <group position={[TEST_PANEL.x, 0, TEST_PANEL.z]}>
    <mesh geometry={g.box} position={[0, 0.5, 0]} scale={[2.2, 1.0, 0.9]} material={std('#2b3236', { roughness: 0.5 })} castShadow receiveShadow />
    <mesh geometry={g.box} position={[0, 0.25, 0.452]} scale={[2.2, 0.12, 0.01]} material={std('#f2c230', { roughness: 0.6 })} />
    <group position={[0, 1.08, 0.05]} rotation={[0.55, 0, 0]}>
      <mesh geometry={g.box} scale={[2.2, 0.06, 1.0]} material={std('#1d2427', { roughness: 0.4 })} castShadow />
      <mesh position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[2.1, 0.9]} /><meshBasicMaterial map={tex} toneMapped={false} /></mesh>
      {EMERG_KEYS.map((k, i) => {
        // canvas x 112 + i*200 of 1024 across 2.1 units; buttons sit just above their labels
        const x = -1.05 + ((112 + i * 200) / 1024) * 2.1;
        return <group key={k} position={[x, 0.06, 0.12]} userData={{ emerg: k }}
          onClick={(e) => { e.stopPropagation(); onPress(k); }}
          onPointerOver={(e) => { e.stopPropagation(); gl.domElement.style.cursor = 'pointer'; }} onPointerOut={() => { gl.domElement.style.cursor = ''; }}>
          <mesh position={[0, 0, 0]}><cylinderGeometry args={[0.15, 0.17, 0.04, 20]} /><meshStandardMaterial color="#3b4246" /></mesh>
          <mesh position={[0, 0.05, 0]} material={caps[i]}><cylinderGeometry args={[0.11, 0.12, 0.07, 20]} /></mesh>
        </group>;
      })}
    </group>
  </group>;
}

function EmergencyBeacons({ color, reduced, withLight }: { color: string; reduced: boolean; withLight: boolean }) {
  const spins = useRef<(THREE.Group | null)[]>([]);
  const light = useRef<THREE.PointLight>(null);
  const dome = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  const beam = useMemo(() => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), [color]);
  useEffect(() => () => { dome.dispose(); beam.dispose(); }, [dome, beam]);
  const cone = useMemo(() => new THREE.ConeGeometry(0.35, 2.4, 12, 1, true), []);
  useEffect(() => () => cone.dispose(), [cone]);
  useFrame(({ clock }, dt) => {
    spins.current.forEach((g) => { if (g && !reduced) g.rotation.y += dt * 5; });
    const pulse = reduced ? 0.7 : 0.5 + 0.5 * Math.sin(clock.elapsedTime * 6);
    if (light.current) light.current.intensity = withLight ? 30 * pulse : 0;
  });
  return <>
    {BEACONS.map(([x, z], i) => <group key={i} position={[x, 4.6, z]}>
      <mesh geometry={geo().box} position={[0, -0.08, 0]} scale={[0.3, 0.08, 0.3]} material={std('#2b3033')} />
      <mesh material={dome}><sphereGeometry args={[0.15, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
      <group ref={(el) => { spins.current[i] = el; }} position={[0, 0.08, 0]}>
        {[0, Math.PI].map((a) => <mesh key={a} geometry={cone} rotation={[0, a, Math.PI / 2]} position={[Math.cos(a) * 1.2, 0, -Math.sin(a) * 1.2]} material={beam} />)}
      </group>
    </group>)}
    <pointLight ref={light} position={[0, 7, -1]} distance={48} color={color} intensity={0} />
  </>;
}

function Fire({ reduced }: { reduced: boolean }) {
  const flames = useRef<(THREE.Mesh | null)[]>([]); const smoke = useRef<(THREE.Mesh | null)[]>([]);
  const light = useRef<THREE.PointLight>(null);
  const cone = useMemo(() => new THREE.ConeGeometry(0.3, 1, 8, 1, true).translate(0, 0.5, 0), []);
  const hot = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff7a1a', transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }), []);
  const core = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffd84a', transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }), []);
  const puffs = useMemo(() => Array.from({ length: 7 }, () => new THREE.MeshBasicMaterial({ color: '#3d3a36', transparent: true, opacity: 0, depthWrite: false })), []);
  useEffect(() => () => { cone.dispose(); hot.dispose(); core.dispose(); puffs.forEach((m) => m.dispose()); }, [cone, hot, core, puffs]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    flames.current.forEach((f, i) => { if (f) f.scale.set(1, (i < 3 ? 1.3 : 0.8) * (reduced ? 1 : 0.8 + 0.35 * Math.abs(Math.sin(t * (9 + i * 2.3) + i))), 1); });
    smoke.current.forEach((p, i) => {
      if (!p) return;
      const k = (t * 0.25 + i / puffs.length) % 1;
      p.position.set(Math.sin(i * 2 + t * 0.6) * 0.4 * k, 1.2 + k * 5, Math.cos(i * 1.3) * 0.3 * k);
      p.scale.setScalar(0.4 + k * 1.6);
      puffs[i].opacity = Math.sin(k * Math.PI) * 0.55;
    });
    if (light.current) light.current.intensity = 14 + (reduced ? 0 : 6 * Math.sin(t * 17) * Math.sin(t * 7.3));
  });
  const g = geo();
  return <group position={[FIRE_AT.x, 0, FIRE_AT.z]}>
    <mesh geometry={g.box} position={[0, 0.15, 0]} scale={[1.2, 0.3, 1.0]} material={std('#2a1d14', { roughness: 1 })} />
    {[[0, 0, 1], [0.3, 0.15, 0.8], [-0.3, -0.1, 0.85], [0.15, -0.3, 0.6], [-0.2, 0.3, 0.6]].map(([x, z, s], i) => <mesh key={i} ref={(el) => { flames.current[i] = el; }}
      geometry={cone} position={[x, 0.3, z]} scale={[s, 1, s]} material={i < 3 ? hot : core} />)}
    {puffs.map((m, i) => <mesh key={`s${i}`} ref={(el) => { smoke.current[i] = el; }} geometry={g.blob} material={m} />)}
    <pointLight ref={light} position={[0, 1.4, 0]} distance={10} color="#ff7a2a" intensity={14} />
  </group>;
}

function JamWarning({ reduced }: { reduced: boolean }) {
  const m = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ff9b2f', transparent: true, opacity: 0.8, toneMapped: false }), []);
  useEffect(() => () => m.dispose(), [m]);
  useFrame(({ clock }) => { m.opacity = reduced ? 0.7 : Math.sin(clock.elapsedTime * 8) > 0 ? 0.95 : 0.15; });
  const len = FORK.x - START.x; const cx = (FORK.x + START.x) / 2;
  return <>
    {[-1, 1].map((s) => <mesh key={s} geometry={geo().box} position={[cx, BELT_Y + 0.18, s * 0.8]} scale={[len, 0.05, 0.14]} material={m} />)}
  </>;
}

// ---- Walk mode (first / third person) ------------------------------------------------------------
// Pure viewing: the player only moves the camera around the line; nothing here writes data.
type BoardDef = { x: number; z: number; rot: number; w: number; y: number; label: string };
// rot: board faces (sin rot, 0, cos rot); stand in front and look at it with yaw = rot
const WALL = { z: -9.5, y: 2.9, w: 4.8, gap: 0.22 };
const WALL_KEYS = ['system', 'alerts', 'kpi', 'hourly', 'pareto'] as const;
type BoardKey = (typeof WALL_KEYS)[number];
const WALL_SLOTS = WALL_KEYS.length + 1; // + the holo panel at the right end
const BOARD_LABEL: Record<BoardKey, string> = { system: 'สุขภาพระบบ', alerts: 'Alert', kpi: 'กระดาน KPI', hourly: 'รายชั่วโมง', pareto: 'ชนิดที่เสีย' };
const BOARDS = Object.fromEntries(WALL_KEYS.map((k, i) => [k, {
  x: (i - (WALL_SLOTS - 1) / 2) * (WALL.w + WALL.gap), z: WALL.z, rot: 0, w: WALL.w, y: WALL.y, label: BOARD_LABEL[k],
}])) as Record<BoardKey, BoardDef>;
const WALL_SPAN = WALL_SLOTS * WALL.w + (WALL_SLOTS - 1) * WALL.gap;
const BOARD = BOARDS.kpi;
const CONSOLE = { x: -5.6, z: 5.8 };
const boardEnds = (b: BoardDef) => {
  const ax = Math.cos(b.rot) * b.w / 2; const az = -Math.sin(b.rot) * b.w / 2;
  return { x1: b.x - ax, z1: b.z - az, x2: b.x + ax, z2: b.z + az };
};
const SIREN_AT = { x: -2.4, z: -1.6 };
const EYE = 1.6; const PLAYER_R = 0.35; const BOUND = 30.2; // the fence runs at FENCE (just outside)
// Obstacles as capsules on the floor (a point when a = b): r = radius, h = height the player can jump over.
type Capsule = { ax: number; az: number; bx: number; bz: number; r: number; h: number };
function buildColliders(): Capsule[] {
  const out: Capsule[] = [];
  const cap = (ax: number, az: number, bx: number, bz: number, r: number, h = Infinity) => out.push({ ax, az, bx, bz, r, h });
  cap(START.x - 0.6, 0, FORK.x + 0.4, 0, 0.85, 0.95);
  for (const kind of KINDS) {
    const end = END[kind].clone().add(dirOf(kind).multiplyScalar(0.35));
    cap(FORK.x, 0, end.x, end.z, 0.8, 0.95);
    cap(CRATE[kind].x, CRATE[kind].z, CRATE[kind].x, CRATE[kind].z, 1.25, 1.05);
  }
  for (const s of [-1, 1]) cap(CAM.x, s * 1.2, CAM.x, s * 1.2, 0.28);
  for (const t of TREES) cap(t.x, t.z, t.x, t.z, 0.78 * t.s);
  cap(SIREN_AT.x, SIREN_AT.z, SIREN_AT.x, SIREN_AT.z, 0.32);
  cap(-WALL_SPAN / 2 - 0.3, WALL.z - 0.1, WALL_SPAN / 2 + 0.3, WALL.z - 0.1, 0.4);
  cap(CONSOLE.x - 1.1, CONSOLE.z, CONSOLE.x + 1.1, CONSOLE.z, 0.55);
  // warehouse walls and posts (front and the front half of the sides are open; AGV door in the right wall)
  cap(SHED.x0, SHED.z0, SHED.x1, SHED.z0, 0.3);
  cap(SHED.x0, SHED.z0, SHED.x0, SHED.sideZ, 0.3);
  cap(SHED.x1, SHED.doorZ1, SHED.x1, SHED.sideZ, 0.3);
  for (const [x, z] of SHED_POSTS) cap(x, z, x, z, 0.3);
  // pickup truck, hopper, elevator and chute at the start of the line
  cap(TRUCK_X - 2.5, 0, TRUCK_X + 2.4, 0, 1.0);
  cap(HOPPER.x, 0, HOPPER.x, 0, 0.8);
  cap(HOPPER.x + 0.4, 0, START.x - 0.6, 0, 0.5, 1.3);
  for (const t of ORCHARD) cap(t.x, t.z, t.x, t.z, 0.55 * t.s);
  // viewpoint: benches (can be jumped), telescope, railing halves
  for (const b of BENCHES) cap(b.x - 0.85, b.z, b.x + 0.85, b.z, 0.32, 0.6);
  cap(VIEW.x - 1.6, VIEW.z - 1.3, VIEW.x - 1.6, VIEW.z - 1.3, 0.25);
  cap(VIEW.x - 3.4, VIEW.z - 2.1, VIEW.x - 0.8, VIEW.z - 2.1, 0.12, 0.95);
  cap(VIEW.x + 0.8, VIEW.z - 2.1, VIEW.x + 3.4, VIEW.z - 2.1, 0.12, 0.95);
  cap(VIEW_SIGN.x, VIEW_SIGN.z, VIEW_SIGN.x, VIEW_SIGN.z, 0.15);
  for (const m of TEAM) cap(m.x, m.z, m.x, m.z, 0.35);
  cap(TEST_PANEL.x - 1.1, TEST_PANEL.z, TEST_PANEL.x + 1.1, TEST_PANEL.z, 0.5);
  return out;
}
let COLLIDERS: Capsule[] | null = null;
const allColliders = () => (COLLIDERS ??= buildColliders());

type Person = 'first' | 'third';
type Warp = { x: number; z: number; yaw: number; pitch?: number; n: number };
const WARPS: { key: string; label: string; x: number; z: number; yaw: number; pitch?: number }[] = [
  { key: 'start', label: 'จุดเริ่ม', x: -2.5, z: 7.6, yaw: 0 },
  { key: 'gate', label: 'ประตูสแกน', x: -6.4, z: 2.7, yaw: -0.45 },
  { key: 'fork', label: 'ทางแยก', x: 1.2, z: 2.6, yaw: 0.25 },
  { key: 'good', label: 'ตะกร้าดี', x: CRATE.good.x - 2.7, z: CRATE.good.z + 0.4, yaw: -Math.PI / 2 + 0.15 },
  { key: 'defect', label: 'ตะกร้าเสีย', x: CRATE.defect.x - 2.4, z: CRATE.defect.z + 0.9, yaw: -Math.PI / 2 + 0.36 },
  { key: 'console', label: 'ห้องควบคุม', x: CONSOLE.x, z: CONSOLE.z + 2.3, yaw: 0 },
  { key: 'truck', label: 'รถส่งผลไม้', x: -14.4, z: 3.7, yaw: 0.4 },
  { key: 'view', label: 'จุดชมวิว', x: VIEW.x, z: VIEW.z - 0.9, yaw: 0.05, pitch: 0.02 },
  ...WALL_KEYS.map((key) => { const b = BOARDS[key]; return { key, label: b.label, x: b.x + Math.sin(b.rot) * 4.5, z: b.z + Math.cos(b.rot) * 4.5, yaw: b.rot, pitch: 0.24 }; }),
];
type Aim = { pileId?: string; tokenId?: string; console?: boolean; pet?: 'cat' | 'dog'; team?: number; emerg?: Emerg };
type Fun = {
  meowKey: number; barkKey: number; onPet: (p: 'cat' | 'dog') => void; marks: { cat: React.MutableRefObject<SVGCircleElement | null>; dog: React.MutableRefObject<SVGCircleElement | null> };
  talk: number | null; onTeam: (i: number) => void; emerg: Emerg | null; onEmerg: (e: Emerg) => void;
};
type NearKey = Kind | 'console' | 'test' | `team${number}` | null;

function Worker({ moving, phase }: { moving: React.MutableRefObject<number>; phase: React.MutableRefObject<number> }) {
  const legL = useRef<THREE.Group>(null); const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null); const armR = useRef<THREE.Group>(null);
  useFrame(() => {
    const s = Math.sin(phase.current) * 0.7 * moving.current;
    if (legL.current) legL.current.rotation.x = s;
    if (legR.current) legR.current.rotation.x = -s;
    if (armL.current) armL.current.rotation.x = -s * 0.8;
    if (armR.current) armR.current.rotation.x = s * 0.8;
  });
  const g = geo();
  const pants = std('#2f4a6b', { flatShading: true }); const vest = std('#ff8a1f', { flatShading: true });
  const skin = std('#e7b48a', { flatShading: true }); const helmet = std('#ffd21f', { roughness: 0.35, flatShading: true });
  return <group>
    {([[legL, -0.12], [legR, 0.12]] as const).map(([r, x]) => <group key={x} ref={r} position={[x, 0.82, 0]}>
      <mesh geometry={g.box} position={[0, -0.4, 0]} scale={[0.17, 0.8, 0.19]} material={pants} castShadow />
      <mesh geometry={g.box} position={[0, -0.79, -0.05]} scale={[0.19, 0.08, 0.3]} material={std('#2a2a2a')} castShadow />
    </group>)}
    <mesh geometry={g.box} position={[0, 1.13, 0]} scale={[0.5, 0.64, 0.28]} material={vest} castShadow />
    <mesh geometry={g.box} position={[0, 1.08, 0]} scale={[0.52, 0.05, 0.3]} material={mat('reflect', () => new THREE.MeshBasicMaterial({ color: '#e8fff4', toneMapped: false }))} />
    {/* group logo + name "ส้มหยุด" on the vest: chest (front = -z) and back */}
    <mesh position={[0, 1.26, -0.142]} rotation={[0, Math.PI, 0]} material={badgeMat()}><planeGeometry args={[0.25, 0.25]} /></mesh>
    <mesh position={[0, 1.26, 0.142]} material={badgeMat()}><planeGeometry args={[0.3, 0.3]} /></mesh>
    {([[armL, -0.33], [armR, 0.33]] as const).map(([r, x]) => <group key={x} ref={r} position={[x, 1.4, 0]}>
      <mesh geometry={g.box} position={[0, -0.28, 0]} scale={[0.13, 0.58, 0.15]} material={vest} castShadow />
      <mesh geometry={g.box} position={[0, -0.6, 0]} scale={[0.11, 0.1, 0.12]} material={skin} />
    </group>)}
    <mesh geometry={g.blob} position={[0, 1.62, 0]} scale={0.17} material={skin} castShadow />
    <mesh position={[0, 1.68, 0]} material={helmet} castShadow><sphereGeometry args={[0.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
    <mesh position={[0, 1.685, -0.12]} scale={[1, 1, 0.6]} material={helmet}><cylinderGeometry args={[0.2, 0.2, 0.02, 10]} /></mesh>
  </group>;
}

function Walker({ person, warp, onMove, onNear, onInteract, onTogglePerson, onAim }: {
  person: Person; warp: Warp; onMove: (x: number, z: number, yaw: number) => void; onNear: (key: NearKey) => void;
  onAim: (hit: Aim) => void;
  onInteract: () => void; onTogglePerson: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const pos = useRef(new THREE.Vector3(warp.x, 0, warp.z));
  const look = useRef({ yaw: warp.yaw, pitch: warp.pitch ?? -0.05 });
  const vy = useRef(0);
  const keys = useRef(new Set<string>());
  const moving = useRef(0); const phase = useRef(0);
  const avatar = useRef<THREE.Group>(null);
  const near = useRef<NearKey>(null);
  const cbs = useRef({ onMove, onNear, onInteract, onTogglePerson, onAim });
  cbs.current = { onMove, onNear, onInteract, onTogglePerson, onAim };
  const scene = useThree((st) => st.scene);
  const colliders = allColliders();
  useEffect(() => { pos.current.set(warp.x, 0, warp.z); look.current = { yaw: warp.yaw, pitch: warp.pitch ?? -0.05 }; vy.current = 0; }, [warp]);
  useEffect(() => {
    const prev = camera.rotation.order;
    camera.rotation.order = 'YXZ';
    // wider lens while walking (the overview uses a narrow 36°)
    const persp = camera as THREE.PerspectiveCamera;
    const prevFov = persp.fov; persp.fov = 62; persp.updateProjectionMatrix();
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.code === 'KeyV' && !e.repeat) cbs.current.onTogglePerson();
      if (e.code === 'KeyE' && !e.repeat) cbs.current.onInteract();
      keys.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    const mouse = (e: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      look.current.yaw -= e.movementX * 0.0022;
      look.current.pitch = THREE.MathUtils.clamp(look.current.pitch - e.movementY * 0.0022, -1.3, 1.2);
    };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    document.addEventListener('mousemove', mouse);
    const ray = new THREE.Raycaster(); ray.far = 9;
    const centre = new THREE.Vector2(0, 0);
    const shoot = (e: MouseEvent) => {
      if (e.button !== 0 || document.pointerLockElement !== gl.domElement) return;
      ray.setFromCamera(centre, camera);
      for (const hit of ray.intersectObjects(scene.children, true)) {
        let o: THREE.Object3D | null = hit.object;
        const keyOf = (u: Record<string, unknown>) => u.pileId || u.tokenId || u.console || u.pet || u.emerg || u.team !== undefined;
        while (o && !keyOf(o.userData)) o = o.parent;
        if (o) { const u = o.userData; cbs.current.onAim({ pileId: u.pileId, tokenId: u.tokenId, console: u.console, pet: u.pet, team: u.team, emerg: u.emerg }); return; }
      }
    };
    document.addEventListener('mousedown', shoot);
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur);
      document.removeEventListener('mousemove', mouse);
      document.removeEventListener('mousedown', shoot);
      camera.rotation.order = prev;
      persp.fov = prevFov; persp.updateProjectionMatrix();
    };
  }, [camera, gl, scene]);
  const fwd = useMemo(() => new THREE.Vector3(), []); const right = useMemo(() => new THREE.Vector3(), []);
  const mv = useMemo(() => new THREE.Vector3(), []); const want = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const k = keys.current; const { yaw, pitch } = look.current; const p = pos.current;
    fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    mv.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s);
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    if (mv.lengthSq() > 0) mv.normalize().multiplyScalar((run ? 6 : 3.2) * dt);
    p.x += mv.x; p.z += mv.z;
    // jump / gravity: belts (0.95) and crates (1.05) can be cleared with a running jump
    if (k.has('Space') && p.y <= 0.001) vy.current = 7;
    vy.current -= 18 * dt; p.y = Math.max(0, p.y + vy.current * dt);
    if (p.y === 0) vy.current = Math.max(0, vy.current);
    for (const c of colliders) {
      if (p.y >= c.h) continue;
      const dx = c.bx - c.ax; const dz = c.bz - c.az; const len = dx * dx + dz * dz;
      const t = len ? clamp01(((p.x - c.ax) * dx + (p.z - c.az) * dz) / len) : 0;
      const cx = c.ax + dx * t; const cz = c.az + dz * t;
      const ox = p.x - cx; const oz = p.z - cz; const d = Math.hypot(ox, oz); const min = c.r + PLAYER_R;
      if (d >= min) continue;
      if (d < 1e-5) { p.x = cx + min; continue; }
      p.x = cx + (ox / d) * min; p.z = cz + (oz / d) * min;
    }
    p.x = THREE.MathUtils.clamp(p.x, -BOUND, BOUND); p.z = THREE.MathUtils.clamp(p.z, -BOUND, BOUND);
    const speed = mv.length() / Math.max(dt, 1e-4);
    moving.current += ((speed > 0.1 && p.y === 0 ? 1 : 0) - moving.current) * Math.min(1, dt * 10);
    phase.current += speed * dt * 2.4;
    if (avatar.current) { avatar.current.position.set(p.x, p.y, p.z); avatar.current.rotation.y = yaw; avatar.current.visible = person === 'third'; }
    if (person === 'first') {
      camera.position.set(p.x, p.y + EYE + Math.sin(phase.current * 2) * 0.03 * moving.current, p.z);
      camera.rotation.set(pitch, yaw, 0);
    } else {
      // behind and above the worker; pitch tilts the boom
      const back = 4.2;
      want.set(p.x + Math.sin(yaw) * back, p.y + Math.max(0.6, 2.0 - pitch * 2.2), p.z + Math.cos(yaw) * back);
      camera.position.lerp(want, Math.min(1, dt * 10));
      camera.lookAt(p.x, p.y + 1.35 + pitch * 1.5, p.z);
    }
    cbs.current.onMove(p.x, p.z, yaw);
    let nk: NearKey = null;
    for (const kind of KINDS) if (Math.hypot(p.x - CRATE[kind].x, p.z - CRATE[kind].z) < 3.3) nk = kind;
    if (Math.hypot(p.x - CONSOLE.x, p.z - CONSOLE.z) < 2.4) nk = 'console';
    if (Math.hypot(p.x - TEST_PANEL.x, p.z - TEST_PANEL.z) < 2.0) nk = 'test';
    TEAM.forEach((m, i) => { if (Math.hypot(p.x - m.x, p.z - m.z) < 1.8) nk = `team${i}`; });
    if (nk !== near.current) { near.current = nk; cbs.current.onNear(nk); }
  });
  return <group ref={avatar} visible={false}><Worker moving={moving} phase={phase} /></group>;
}

// ---- Report boards (canvas textures on real 3D panels) --------------------------------------------
type BoardData = {
  hourly: { h: number; good: number; defect: number }[];
  alerts: { id: number; ts: string | null; level: string; title: string; detail: string | null; device_id: string | null }[];
  alert_counts: { open: number; open_critical: number; today: number } | null;
};
type Draw = (g: CanvasRenderingContext2D, W: number, H: number, font: string) => void;
const BW = 1024; const BH = 520;

function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
function boardFrame(g: CanvasRenderingContext2D, W: number, H: number, font: string, title: string, sub: string, pill?: { text: string; ok: boolean | null }) {
  g.fillStyle = '#06140f'; g.fillRect(0, 0, W, H);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#7ff7e0'; g.font = `900 42px ${font}`; g.fillText(title, 36, 68);
  const tw = g.measureText(title).width;
  g.fillStyle = '#9cc8b8'; g.font = `600 24px ${font}`; g.fillText(fit(g, sub, W - tw - 330), 56 + tw, 66);
  if (pill) {
    g.font = `800 26px ${font}`;
    const pw = g.measureText(pill.text).width + 32;
    g.fillStyle = pill.ok == null ? 'rgba(160,170,170,.25)' : pill.ok ? 'rgba(56,201,131,.3)' : 'rgba(232,66,58,.3)';
    g.beginPath(); g.roundRect(W - 36 - pw, 32, pw, 46, 12); g.fill();
    g.fillStyle = pill.ok == null ? '#cfd8d3' : pill.ok ? '#9ff5c8' : '#ffb3ab'; g.fillText(pill.text, W - 20 - pw, 65);
  }
}

function CanvasBoard({ b, draw, version }: { b: BoardDef; draw: Draw; version: string }) {
  const g3 = geo();
  const { canvas, tex } = useMemo(() => {
    const c = document.createElement('canvas'); c.width = BW; c.height = BH;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return { canvas: c, tex: t };
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  const drawRef = useRef(draw); drawRef.current = draw;
  useEffect(() => {
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const paint = () => { const g = canvas.getContext('2d'); if (!g) return; drawRef.current(g, BW, BH, font); tex.needsUpdate = true; };
    paint();
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) paint(); });
    return () => { alive = false; };
  }, [version, canvas, tex]);
  const sh = (b.w - 0.16) * (BH / BW);
  return <group position={[b.x, 0, b.z]} rotation={[0, b.rot, 0]}>
    <mesh geometry={g3.box} position={[0, b.y, 0]} scale={[b.w, sh + 0.16, 0.1]} material={std('#11171a', { roughness: 0.4 })} />
    <mesh position={[0, b.y, 0.052]}><planeGeometry args={[b.w - 0.16, sh]} /><meshBasicMaterial map={tex} toneMapped={false} /></mesh>
  </group>;
}

// The frame the five screens hang on: back panel, legs, title banner with a light strip, plinth.
function BoardWall({ glow }: { glow: THREE.Material }) {
  const g3 = geo();
  const sh = (WALL.w - 0.16) * (BH / BW);
  const top = WALL.y + sh / 2 + 0.25; const bottom = WALL.y - sh / 2 - 0.25;
  const span = WALL_SPAN + 0.5;
  const banner = useMemo(() => {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 64;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const paint = () => {
      const g = c.getContext('2d'); if (!g) return;
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      g.fillStyle = '#0c1518'; g.fillRect(0, 0, 2048, 64);
      g.fillStyle = '#7ff7e0'; g.font = `900 40px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('CIRA CORE  ·  FRUIT SORTING  ·  LIVE OPERATIONS', 1024, 34);
      t.needsUpdate = true;
    };
    paint(); void document.fonts?.ready.then(paint);
    return t;
  }, []);
  useEffect(() => () => banner.dispose(), [banner]);
  const frame = std('#1a2125', { roughness: 0.5, metalness: 0.2 });
  const legs = WALL_SLOTS + 1;
  return <group position={[0, 0, WALL.z]}>
    <mesh geometry={g3.box} position={[0, (top + 0.12) / 2, -0.12]} scale={[span, top - 0.12, 0.14]} material={frame} castShadow receiveShadow />
    {Array.from({ length: legs }, (_, i) => {
      const x = (i - (legs - 1) / 2) * (WALL.w + WALL.gap);
      return <mesh key={i} geometry={g3.box} position={[x, bottom / 2, -0.12]} scale={[0.22, bottom, 0.22]} material={frame} castShadow />;
    })}
    <mesh geometry={g3.box} position={[0, top + 0.3, -0.08]} scale={[span, 0.6, 0.24]} material={frame} castShadow />
    <mesh position={[0, top + 0.3, 0.045]}><planeGeometry args={[span - 0.3, (span - 0.3) * (64 / 2048)]} /><meshBasicMaterial map={banner} toneMapped={false} /></mesh>
    <mesh geometry={g3.box} position={[0, top + 0.02, 0.0]} scale={[span, 0.035, 0.05]} material={glow} />
    <mesh geometry={g3.box} position={[0, 0.06, -0.1]} scale={[span + 0.6, 0.12, 0.9]} material={std('#2b3236', { roughness: 0.7 })} receiveShadow />
  </group>;
}

function KpiBoard({ kpi }: { kpi: Props['kpi'] }) {
  const draw: Draw = (g, W, H, font) => {
    boardFrame(g, W, H, font, 'KPI · LIVE', `${kpi.device ?? '-'} · ${kpi.model ?? '-'}`, { text: kpi.state, ok: kpi.playing });
    const rate = Number(kpi.defectRate);
    const cells: [string, string, string][] = [
      ['Total', kpi.total.toLocaleString(), '#ffffff'], ['ดี', kpi.good.toLocaleString(), '#6ff2a8'], ['เสีย', kpi.defect.toLocaleString(), '#ffab6b'],
      ['Defect rate', `${kpi.defectRate}%`, rate >= 30 ? '#ff8f7a' : rate >= 15 ? '#ffd27a' : '#ffffff'], ['ผล / นาที', String(kpi.epm), '#ffffff'], ['ช่วงเวลา', kpi.windowLabel, '#ffffff'],
    ];
    const cw = (W - 72 - 2 * 20) / 3; const ch = 170;
    cells.forEach(([label, value, color], i) => {
      const x = 36 + (i % 3) * (cw + 20); const y = 110 + Math.floor(i / 3) * (ch + 20);
      g.fillStyle = 'rgba(127,247,224,.08)'; g.strokeStyle = 'rgba(127,247,224,.25)'; g.lineWidth = 2;
      g.beginPath(); g.roundRect(x, y, cw, ch, 16); g.fill(); g.stroke();
      g.fillStyle = '#9cc8b8'; g.font = `700 26px ${font}`; g.fillText(label, x + 22, y + 44);
      g.fillStyle = color; g.font = `900 ${value.length > 7 ? 54 : 76}px ${font}`; g.fillText(value, x + 22, y + 135);
    });
  };
  return <CanvasBoard b={BOARDS.kpi} draw={draw} version={JSON.stringify(kpi)} />;
}

function HourlyBoard({ data }: { data: BoardData | null }) {
  const hours = data?.hourly ?? [];
  const nowH = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const draw: Draw = (g, W, H, font) => {
    const total = hours.reduce((a, b) => a + b.good + b.defect, 0);
    const bad = hours.reduce((a, b) => a + b.defect, 0);
    boardFrame(g, W, H, font, 'ผลไม้รายชั่วโมง', `วันนี้ ${total.toLocaleString()} ผล · เสีย ${total ? ((bad / total) * 100).toFixed(1) : '0.0'}%`);
    const left = 70; const right = W - 30; const top = 110; const bottom = H - 60;
    const max = Math.max(1, ...hours.map((b) => b.good + b.defect));
    g.strokeStyle = 'rgba(127,247,224,.18)'; g.lineWidth = 2;
    [0, 0.5, 1].forEach((f) => { const y = bottom - (bottom - top) * f; g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke(); });
    g.fillStyle = '#9cc8b8'; g.font = `600 20px ${font}`; g.textAlign = 'right';
    g.fillText(String(max), left - 10, top + 8); g.fillText(String(Math.round(max / 2)), left - 10, (top + bottom) / 2 + 8); g.fillText('0', left - 10, bottom + 8);
    g.textAlign = 'center';
    const slot = (right - left) / 24; const bw = slot * 0.7;
    for (let h = 0; h < 24; h++) {
      const b = hours[h] ?? { good: 0, defect: 0 };
      const x = left + slot * h + (slot - bw) / 2;
      const hg = ((bottom - top) * b.good) / max; const hd = ((bottom - top) * b.defect) / max;
      if (h === nowH) { g.fillStyle = 'rgba(255,225,77,.12)'; g.fillRect(left + slot * h, top - 10, slot, bottom - top + 10); }
      g.fillStyle = '#3dffb0'; g.fillRect(x, bottom - hg, bw, hg);
      g.fillStyle = '#ffa043'; g.fillRect(x, bottom - hg - hd, bw, hd);
      if (h % 3 === 0) { g.fillStyle = h === nowH ? '#ffe14d' : '#9cc8b8'; g.font = `700 20px ${font}`; g.fillText(`${String(h).padStart(2, '0')}:00`, left + slot * h + slot / 2, bottom + 34); }
    }
    g.textAlign = 'left';
    if (!data) { g.fillStyle = '#9cc8b8'; g.font = `700 28px ${font}`; g.fillText('กำลังโหลด...', left + 20, (top + bottom) / 2); }
  };
  return <CanvasBoard b={BOARDS.hourly} draw={draw} version={JSON.stringify([hours, nowH, !!data])} />;
}

function ParetoBoard({ crates }: { crates: Props['crates'] }) {
  const rows = [...crates.byDefect].sort((a, b) => b.n - a.n);
  const draw: Draw = (g, W, H, font) => {
    const total = rows.reduce((a, r) => a + r.n, 0);
    boardFrame(g, W, H, font, 'ชนิดที่เสีย', `ช่วง ${crates.windowLabel} · ${total.toLocaleString()} ผล`);
    if (!rows.length) { g.fillStyle = '#6ff2a8'; g.font = `800 40px ${font}`; g.fillText('ยังไม่มีผลเสียในช่วงนี้', 60, 290); return; }
    const max = Math.max(1, ...rows.map((r) => r.n));
    const rowH = Math.min(92, (H - 140) / rows.length);
    rows.slice(0, 5).forEach((r, i) => {
      const y = 120 + i * rowH;
      const name = DEFECT_TH[r.defect_type] ?? r.defect_type;
      g.fillStyle = '#e6fffb'; g.font = `800 32px ${font}`; g.fillText(name, 40, y + 40);
      g.fillStyle = '#7f9c93'; g.font = `600 20px ${font}`; g.fillText(r.defect_type, 40, y + 66);
      const x0 = 230; const wMax = W - x0 - 210;
      g.fillStyle = 'rgba(255,160,67,.15)'; g.beginPath(); g.roundRect(x0, y + 14, wMax, 44, 10); g.fill();
      g.fillStyle = '#ffa043'; g.beginPath(); g.roundRect(x0, y + 14, Math.max(8, (wMax * r.n) / max), 44, 10); g.fill();
      g.fillStyle = '#ffffff'; g.font = `900 34px ${font}`; g.fillText(r.n.toLocaleString(), W - 190, y + 48);
      g.fillStyle = '#ffd2a8'; g.font = `700 24px ${font}`; g.fillText(`${((r.n / total) * 100).toFixed(0)}%`, W - 90, y + 47);
    });
  };
  return <CanvasBoard b={BOARDS.pareto} draw={draw} version={JSON.stringify([rows, crates.windowLabel])} />;
}

const levelTh = (l: string) => (l === 'critical' ? 'วิกฤต' : l === 'warning' ? 'เตือน' : l);
function AlertBoard({ data }: { data: BoardData | null }) {
  const list = data?.alerts ?? []; const c = data?.alert_counts;
  const draw: Draw = (g, W, H, font) => {
    boardFrame(g, W, H, font, 'ALERT', c ? `ค้าง ${c.open} · วิกฤต ${c.open_critical} · วันนี้ ${c.today}` : 'กำลังโหลด...', c ? { text: c.open ? `ค้าง ${c.open}` : 'ปกติ', ok: c.open === 0 } : undefined);
    if (data && !list.length) {
      g.fillStyle = '#6ff2a8'; g.font = `900 54px ${font}`; g.fillText('ปกติ · ไม่มี alert ค้าง', 50, 280);
      g.fillStyle = '#9cc8b8'; g.font = `600 26px ${font}`; g.fillText(`วันนี้เกิด alert ${c?.today ?? 0} ครั้ง`, 52, 330);
      return;
    }
    list.slice(0, 4).forEach((a, i) => {
      const y = 104 + i * 100;
      const crit = a.level === 'critical';
      g.fillStyle = crit ? 'rgba(255,59,47,.18)' : 'rgba(255,155,47,.15)'; g.beginPath(); g.roundRect(30, y, W - 60, 88, 12); g.fill();
      g.fillStyle = crit ? '#ff6a5f' : '#ffb04f'; g.beginPath(); g.roundRect(30, y, 10, 88, 5); g.fill();
      g.font = `800 22px ${font}`; g.fillText(levelTh(a.level), 58, y + 34);
      g.fillStyle = '#9cc8b8'; g.font = `600 22px ${font}`; g.fillText(a.ts ? pickTime(a.ts) : '-', 58, y + 68);
      g.fillStyle = '#ffffff'; g.font = `800 30px ${font}`; g.fillText(fit(g, a.title, W - 260), 200, y + 38);
      g.fillStyle = '#b9d3c9'; g.font = `600 22px ${font}`; g.fillText(fit(g, `${a.device_id ?? ''} ${a.detail ?? ''}`.trim(), W - 260), 200, y + 70);
    });
  };
  return <CanvasBoard b={BOARDS.alerts} draw={draw} version={JSON.stringify([list, c, !!data])} />;
}

function SystemBoard({ system }: { system: Props['system'] }) {
  const draw: Draw = (g, W, H, font) => {
    const ok = system.db === 'online' && system.mqtt === 'online';
    boardFrame(g, W, H, font, 'สุขภาพระบบ', 'MQTT · DB · ความหน่วง', { text: ok ? 'ปกติ' : 'มีปัญหา', ok });
    const state = (v: string): [string, string] => (v === 'online' ? ['Online', '#6ff2a8'] : v === 'offline' ? ['Offline', '#ff8f7a'] : ['ไม่ทราบ', '#cfd8d3']);
    const sec = (v: number | null, warn: number, bad: number): [string, string] => (v == null ? ['-', '#cfd8d3'] : [`${v.toFixed(1)} วิ`, v <= warn ? '#6ff2a8' : v <= bad ? '#ffd27a' : '#ff8f7a']);
    const rows: [string, [string, string]][] = [
      ['MQTT', state(system.mqtt)], ['Database', state(system.db)], ['Internet', state(system.internet)],
      ['Heartbeat ล่าสุด', system.heartbeatAge == null ? ['-', '#cfd8d3'] : [`${system.heartbeatAge} วิที่แล้ว`, system.heartbeatAge <= 10 ? '#6ff2a8' : system.heartbeatAge <= 60 ? '#ffd27a' : '#ff8f7a']],
      ['CIRA → DB (เฉลี่ย)', sec(system.ingestAvg, 3, 6)], ['DB → จอ', sec(system.dbToScreen, 3, 6)],
      ['event ล่าสุด', system.lastEventAgo == null ? ['-', '#cfd8d3'] : [`${system.lastEventAgo} วิที่แล้ว`, '#e6fffb']],
    ];
    const colW = (W - 90) / 2;
    rows.forEach(([label, [value, color]], i) => {
      const x = 36 + (i % 2) * (colW + 18); const y = 104 + Math.floor(i / 2) * 98;
      g.fillStyle = 'rgba(127,247,224,.07)'; g.beginPath(); g.roundRect(x, y, colW, 84, 12); g.fill();
      g.fillStyle = '#9cc8b8'; g.font = `700 24px ${font}`; g.fillText(label, x + 20, y + 34);
      g.fillStyle = color; g.font = `900 34px ${font}`; g.fillText(value, x + 20, y + 72);
    });
  };
  return <CanvasBoard b={BOARDS.system} draw={draw} version={JSON.stringify(system)} />;
}

// Operator console: shows the machine state and the web pause / resume button (admin only, confirmed).
const MACHINE: Record<Props['control']['machine'], [string, string]> = {
  running: ['กำลังทำงาน', '#38f59a'], paused: ['หยุดจากเว็บ', '#ffd21f'], stopped: ['เครื่องหยุด', '#ff4a3d'], loading: ['กำลังโหลด', '#9aa7a0'],
};
function ControlConsole({ control, onPress }: { control: Props['control']; onPress: () => void }) {
  const g3 = geo();
  const gl = useThree((st) => st.gl);
  const [label, color] = MACHINE[control.machine];
  const lamp = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  const btn = useMemo(() => new THREE.MeshStandardMaterial({ color: '#888', emissive: new THREE.Color('#000'), roughness: 0.35 }), []);
  useEffect(() => () => { lamp.dispose(); btn.dispose(); }, [lamp, btn]);
  const canPress = control.isAdmin && control.known && !control.busy;
  const btnColor = !control.isAdmin || !control.known ? '#7a8580' : control.paused ? '#2fc46f' : '#e5453a';
  useFrame(({ clock }) => {
    btn.color.set(btnColor); btn.emissive.set(btnColor);
    btn.emissiveIntensity = canPress ? 0.35 + 0.25 * Math.sin(clock.elapsedTime * 4) : 0.05;
  });
  const { canvas, tex } = useMemo(() => {
    const c = document.createElement('canvas'); c.width = 768; c.height = 300;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return { canvas: c, tex: t };
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  useEffect(() => {
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const paint = () => {
      const g = canvas.getContext('2d'); if (!g) return;
      g.fillStyle = '#071a14'; g.fillRect(0, 0, 768, 300);
      g.fillStyle = '#7ff7e0'; g.font = `900 34px ${font}`; g.fillText('CONTROL · ' + (control.device ?? '-'), 28, 52);
      g.fillStyle = color; g.font = `900 56px ${font}`; g.fillText(label, 28, 130);
      g.fillStyle = '#b9d3c9'; g.font = `700 26px ${font}`;
      const hint = !control.isAdmin ? 'ปุ่มนี้ใช้ได้เฉพาะ admin' : !control.known ? 'กำลังอ่านคำสั่งล่าสุด...' : control.busy ? 'กำลังส่งคำสั่ง...'
        : control.waiting ? 'รอ CORE รับคำสั่ง...' : control.paused ? 'กดปุ่มเขียว = สั่งทำงานต่อ' : 'กดปุ่มแดง = สั่งหยุดจากเว็บ';
      g.fillText(hint, 28, 190);
      g.fillStyle = '#7f9c93'; g.font = `600 20px ${font}`; g.fillText('หยุดแค่การส่งผลจาก flow · กล้อง/AI ใน CORE ยังเปิดอยู่', 28, 240);
      if (control.err) { g.fillStyle = '#ff8f7a'; g.font = `700 22px ${font}`; g.fillText(control.err, 28, 280); }
      tex.needsUpdate = true;
    };
    paint();
    void document.fonts?.ready.then(paint);
  }, [canvas, tex, control.device, control.isAdmin, control.known, control.busy, control.waiting, control.paused, control.err, label, color]);
  const press = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onPress(); };
  return <group position={[CONSOLE.x, 0, CONSOLE.z]}>
    <mesh geometry={g3.box} position={[0, 0.5, 0]} scale={[2.6, 1.0, 0.9]} material={std('#2b3236', { roughness: 0.5 })} castShadow receiveShadow />
    <group position={[0, 1.08, 0.05]} rotation={[0.55, 0, 0]}>
      <mesh geometry={g3.box} scale={[2.6, 0.06, 1.0]} material={std('#1d2427', { roughness: 0.4 })} castShadow />
      <mesh position={[-0.35, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[1.7, 0.66]} /><meshBasicMaterial map={tex} toneMapped={false} /></mesh>
      <group position={[0.85, 0.06, 0]} userData={{ console: true }} onClick={press}
        onPointerOver={(e) => { e.stopPropagation(); gl.domElement.style.cursor = canPress ? 'pointer' : 'not-allowed'; }} onPointerOut={() => { gl.domElement.style.cursor = ''; }}>
        <mesh position={[0, 0.02, 0]}><cylinderGeometry args={[0.26, 0.3, 0.06, 24]} /><meshStandardMaterial color="#ffd21f" /></mesh>
        <mesh position={[0, 0.1, 0]} material={btn}><cylinderGeometry args={[0.2, 0.22, 0.12, 24]} /></mesh>
      </group>
    </group>
    <mesh position={[1.15, 1.3, -0.35]}><cylinderGeometry args={[0.04, 0.04, 1.0, 8]} /><meshStandardMaterial color="#cfd8d3" /></mesh>
    <mesh position={[1.15, 1.86, -0.35]} material={lamp}><sphereGeometry args={[0.13, 14, 10]} /></mesh>
    <pointLight position={[1.15, 1.9, -0.1]} color={color} intensity={3} distance={3} />
  </group>;
}

function useBoardData() {
  const [data, setData] = useState<BoardData | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetch('/api/live/boards', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json() as BoardData;
        if (active) setData(j);
      } catch { /* keep last */ }
    };
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 20000);
    return () => { active = false; window.clearInterval(id); };
  }, []);
  return data;
}

// Top-down map of the line; the player marker is moved directly (no re-render per frame).
function MiniMap({ markerRef, catRef, dogRef, alert }: { markerRef: React.MutableRefObject<SVGGElement | null>; catRef: React.MutableRefObject<SVGCircleElement | null>; dogRef: React.MutableRefObject<SVGCircleElement | null>; alert: Props['alert'] }) {
  const line = (a: THREE.Vector3, b: THREE.Vector3, cls: string, key: string) => <line key={key} x1={a.x} y1={a.z} x2={b.x} y2={b.z} className={cls} />;
  return <svg className="lv3d-map" viewBox="-24 -15 48 32" aria-hidden="true">
    <rect x={-24} y={-15} width={48} height={32} className="bg" />
    <rect x={SHED.x0} y={SHED.z0} width={SHED.x1 - SHED.x0} height={SHED.z1 - SHED.z0} className="shed" />
    {ORCHARD.map((t, i) => <circle key={`o${i}`} cx={t.x} cy={t.z} r={0.7 * t.s} className="tree" />)}
    <rect x={TRUCK_X - 2.6} y={-0.9} width={5.2} height={1.8} className="truck" />
    <rect x={VIEW.x - 3.5} y={VIEW.z - 2.2} width={7} height={4.4} className="deck" />
    {line(new THREE.Vector3(START.x - 0.6, 0, 0), new THREE.Vector3(FORK.x + 0.4, 0, 0), 'belt', 'm')}
    {KINDS.map((k) => line(FORK, END[k], `belt ${k}`, k))}
    {KINDS.map((k) => <rect key={`c${k}`} x={CRATE[k].x - 1} y={CRATE[k].z - 0.75} width={2} height={1.5} className={`crate ${k}`} transform={`rotate(${-crateAngle(k) * 180 / Math.PI} ${CRATE[k].x} ${CRATE[k].z})`} />)}
    <rect x={CAM.x - 0.3} y={-1.4} width={0.6} height={2.8} className="gantry" />
    {Object.entries(BOARDS).map(([k, b]) => { const e = boardEnds(b); return <line key={k} x1={e.x1} y1={e.z1} x2={e.x2} y2={e.z2} className="board" />; })}
    <rect x={CONSOLE.x - 1.3} y={CONSOLE.z - 0.45} width={2.6} height={0.9} className="console" />
    {alert && <circle cx={SIREN_AT.x} cy={SIREN_AT.z} r={1.6} className={`alert ${alert}`} />}
    {TREES.map((t, i) => <circle key={i} cx={t.x} cy={t.z} r={0.9 * t.s} className="tree" />)}
    <rect x={TEST_PANEL.x - 1.1} y={TEST_PANEL.z - 0.45} width={2.2} height={0.9} className="test" />
    {TEAM.map((m) => <circle key={m.letter} cx={m.x} cy={m.z} r={0.5} fill={m.color} className="member"><title>{m.name}</title></circle>)}
    <circle ref={catRef} cx={0} cy={0} r={0.55} className="cat"><title>แมวส้ม</title></circle>
    <circle ref={dogRef} cx={0} cy={0} r={0.5} className="dog"><title>ชิวาว่า</title></circle>
    <g ref={markerRef}><path d="M0 -1.1 L0.75 0.8 L0 0.35 L-0.75 0.8 Z" className="me" /></g>
  </svg>;
}

function CratePanel({ kind, count, crates, recent, onClose }: { kind: Kind; count: number; crates: Props['crates']; recent: Fruit3D[]; onClose: () => void }) {
  const rows = crates.byFruit.map((f) => ({ fruit: f.fruit_type, n: kind === 'good' ? f.good : f.defect })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
  const sum = rows.reduce((a, r) => a + r.n, 0) || 1;
  const defects = [...crates.byDefect].sort((a, b) => b.n - a.n);
  const dmax = Math.max(1, ...defects.map((d) => d.n));
  return <div className={`lv3d-crate ${kind}`} role="dialog" aria-label={kind === 'good' ? 'ข้อมูลตะกร้าดี' : 'ข้อมูลตะกร้าเสีย'}>
    <div className="lv3d-pick-head">
      <b>{kind === 'good' ? 'ตะกร้าดี' : 'ตะกร้าเสีย'}</b><span>ช่วง {crates.windowLabel} · จาก DB</span>
      <button type="button" title="ปิด (Esc)" onClick={onClose}><X size={13} /></button>
    </div>
    <strong className="big">{count.toLocaleString()} <small>ผล</small></strong>
    <h4>แยกตามผลไม้</h4>
    {rows.length ? rows.map((r) => <div key={r.fruit} className="row"><span>{FRUIT_TH[r.fruit] ?? r.fruit}</span><i><b style={{ width: `${(r.n / sum) * 100}%` }} /></i><em>{r.n}</em></div>) : <p className="none">ยังไม่มีข้อมูล</p>}
    {kind === 'defect' && <>
      <h4>ชนิดที่เสีย</h4>
      {defects.length ? defects.map((d) => <div key={d.defect_type} className="row"><span>{DEFECT_TH[d.defect_type] ?? d.defect_type}</span><i><b style={{ width: `${(d.n / dmax) * 100}%` }} /></i><em>{d.n}</em></div>) : <p className="none">ยังไม่มีข้อมูล</p>}
    </>}
    <h4>ลงล่าสุด (ตั้งแต่เปิดหน้า)</h4>
    {recent.length ? <ul>{recent.map((t) => <li key={t.id}>
      <b>{t.count > 1 ? `×${t.count}` : `#${t.track ?? '-'}`}</b><span>{t.fruit ? (FRUIT_TH[t.fruit] ?? t.fruit) : '?'}{t.kind === 'defect' && t.defectType ? ` · ${DEFECT_TH[t.defectType] ?? t.defectType}` : ''}</span>
      <em>{t.conf == null ? '' : `${Math.round(t.conf <= 1 ? t.conf * 100 : t.conf)}%`}</em><time>{pickTime(t.ts)}</time>
    </li>)}</ul> : <p className="none">ยังไม่มีผลไม้ลงหลังเปิดหน้า</p>}
  </div>;
}

// ---- Camera presets / follow ----------------------------------------------------------------------
type PresetKey = 'overview' | 'gate' | 'fork' | 'top';
const TIME_MODES: ['auto' | number, string][] = [['auto', 'เวลาจริง (ไทย)'], [6.2, 'เช้ามืด 06:12'], [7.5, 'เช้า 07:30'], [10, 'สาย 10:00'], [12, 'เที่ยง 12:00'], [15, 'บ่าย 15:00'], [17.3, 'เย็น 17:18'], [18.8, 'พลบค่ำ 18:48'], [21, 'กลางคืน 21:00'], [2, 'ดึก 02:00']];
const PRESETS: Record<PresetKey, { label: string; pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { label: 'ภาพรวม', pos: [-0.6, 12.6, 19.6], target: [-0.6, 2.2, -3.0] },
  gate: { label: 'ประตูสแกน', pos: [-8.9, 3.7, 5.6], target: [-5, 1.15, 0] },
  fork: { label: 'ทางแยก', pos: [3.6, 4.4, 6.2], target: [1.0, 0.8, -0.1] },
  top: { label: 'มุมบน', pos: [0.4, 22, 0.9], target: [0.4, 0, 0] },
};
const FOLLOW_OFFSET = new THREE.Vector3(2.2, 2.4, 3.6);
type Controls = { target: THREE.Vector3; addEventListener: (type: string, fn: () => void) => void; removeEventListener: (type: string, fn: () => void) => void };

function CameraRig({ preset, nonce, followId, registry, reduced, onUserMove }: {
  preset: PresetKey; nonce: number; followId: string | null; registry: React.MutableRefObject<Map<string, THREE.Vector3>>; reduced: boolean; onUserMove: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const userMove = useRef(onUserMove); userMove.current = onUserMove;
  useEffect(() => {
    if (!nonce) return;
    const p = PRESETS[preset];
    goal.current = { pos: new THREE.Vector3(...p.pos), target: new THREE.Vector3(...p.target) };
  }, [nonce, preset]);
  useEffect(() => {
    if (!controls) return;
    const stop = () => { goal.current = null; userMove.current(); };
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const target = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    if (!controls) return;
    const fruit = followId ? registry.current.get(followId) : undefined;
    let rate: number;
    if (fruit) { target.copy(fruit); pos.copy(fruit).add(FOLLOW_OFFSET); rate = 4.5; }
    else if (goal.current) { target.copy(goal.current.target); pos.copy(goal.current.pos); rate = 2.6; }
    else return;
    const k = reduced ? 1 : 1 - Math.exp(-dt * rate);
    camera.position.lerp(pos, k);
    controls.target.lerp(target, k);
    if (!fruit && camera.position.distanceToSquared(pos) < 1e-4 && controls.target.distanceToSquared(target) < 1e-4) goal.current = null;
  });
  return null;
}

type Pick = { token: Fruit3D; landed: boolean; follow: boolean };
const pickTime = (ts: string | null | undefined) => ts ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts)) : '-';

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return;
    const on = () => setReduced(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

export default function LiveScene3D(props: Props) {
  const reduced = useReducedMotion();
  const [quality, setQuality] = useState<Quality>('mid');
  // FPS too low: drop shadows / bloom for this visit
  const decline = () => setQuality('low');
  const autoDown = quality === 'low';
  const q = QUALITY[quality];

  const [clockHour, setHour] = useState(bangkokHour);
  useEffect(() => { const id = window.setInterval(() => setHour(bangkokHour()), 30000); return () => window.clearInterval(id); }, []);
  // time of day: Thai clock by default, or a fixed time picked from the menu (only the lighting changes)
  const [timeMode, setTimeMode] = useState<'auto' | number>('auto');
  const hour = timeMode === 'auto' ? clockHour : timeMode;
  const env = useMemo(() => envAt(hour, props.tv), [hour, props.tv]);

  const [cam, setCam] = useState<{ key: PresetKey | null; nonce: number }>({ key: 'overview', nonce: 0 });
  const registry = useRef(new Map<string, THREE.Vector3>());
  const [pick, setPick] = useState<Pick | null>(null);
  const onPick = (token: Fruit3D) => { setPick({ token, landed: false, follow: true }); setCam((c) => ({ ...c, key: null })); };
  const picked = pick?.token.id ?? null;
  const landedNow = !!pick && !pick.landed && !props.tokens.some((t) => t.id === pick.token.id);
  useEffect(() => { if (landedNow) setPick((p) => (p ? { ...p, landed: true, follow: false } : p)); }, [landedNow]);

  // ---- walk mode state
  const [walk, setWalk] = useState(false);
  const [person, setPerson] = useState<Person>('first');
  const [warp, setWarp] = useState<Warp>({ ...WARPS[0], n: 0 });
  const [locked, setLocked] = useState(false);
  const [near, setNear] = useState<NearKey>(null);
  const boardData = useBoardData();
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(''), 3500); return () => window.clearTimeout(id); }, [toast]);
  const nearRef = useRef(near); nearRef.current = near;
  const [crateOpen, setCrateOpen] = useState<Kind | null>(null);
  const [meowKey, setMeowKey] = useState(0);
  const [barkKey, setBarkKey] = useState(0);
  const onPet = (p: 'cat' | 'dog') => (p === 'cat' ? setMeowKey : setBarkKey)((k) => k + 1);
  const [teamOpen, setTeamOpen] = useState<number | null>(null);
  const onTeam = (i: number) => { unlockMouse(); setCrateOpen(null); setTeamOpen(i); };
  // emergency drills (visual only, ends by itself after EMERG_SEC)
  const [emerg, setEmerg] = useState<{ kind: Emerg; until: number } | null>(null);
  const [testMenu, setTestMenu] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!emerg) return;
    const id = window.setInterval(() => { if (Date.now() >= emerg.until) setEmerg(null); else tick((n) => n + 1); }, 1000);
    return () => window.clearInterval(id);
  }, [emerg]);
  const onEmerg = (k: Emerg) => { setTestMenu(false); setEmerg((cur) => (cur?.kind === k ? null : { kind: k, until: Date.now() + EMERG_SEC * 1000 })); };
  const dogMarker = useRef<SVGCircleElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const marker = useRef<SVGGElement | null>(null);
  const catMarker = useRef<SVGCircleElement | null>(null);
  const canvasEl = () => rootRef.current?.querySelector('canvas') ?? null;
  useEffect(() => {
    const on = () => setLocked(!!document.pointerLockElement && document.pointerLockElement === canvasEl());
    document.addEventListener('pointerlockchange', on);
    return () => { document.removeEventListener('pointerlockchange', on); if (document.pointerLockElement && document.pointerLockElement === canvasEl()) document.exitPointerLock(); };
  }, []);
  const lockMouse = () => {
    try { const r = canvasEl()?.requestPointerLock() as unknown as Promise<void> | undefined; r?.catch?.(() => undefined); } catch { /* not allowed */ }
  };
  const unlockMouse = () => { if (document.pointerLockElement) document.exitPointerLock(); };
  // Alt in walk mode is a toggle: press once to free the mouse cursor (e.g. to click a crate), press again to hide it
  // and lock the pointer again. If the browser refuses the re-lock, the "click to walk" help comes back.
  const [altFree, setAltFree] = useState(false);
  useEffect(() => { if (locked) setAltFree(false); }, [locked]);
  const crateOpenRef = useRef<Kind | null>(null); crateOpenRef.current = crateOpen;
  useEffect(() => {
    if (!walk) { setAltFree(false); return; }
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      e.preventDefault();
      if (e.repeat) return;
      if (document.pointerLockElement && document.pointerLockElement === canvasEl()) { setAltFree(true); unlockMouse(); return; }
      setAltFree(false);
      if (!crateOpenRef.current) lockMouse();
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'Alt') e.preventDefault(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walk]);
  const enterWalk = () => { setPick(null); setCrateOpen(null); setWalk(true); setWarp((w) => ({ ...WARPS[0], n: w.n + 1 })); };
  const exitWalk = () => { unlockMouse(); setWalk(false); setNear(null); setCam((c) => ({ key: 'overview', nonce: c.nonce + 1 })); };
  // console button: same pause / resume as the header (admin + confirm dialog in SimulateView)
  const pressConsole = () => {
    const c = props.control;
    if (!c.isAdmin) { setToast('ปุ่มหยุด/ทำงานต่อใช้ได้เฉพาะ admin'); return; }
    if (!c.known || c.busy) return;
    unlockMouse();
    c.send(c.paused);
  };
  const interact = () => {
    const k = nearRef.current; if (!k) return;
    if (k === 'console') { pressConsole(); return; }
    if (k === 'test') { unlockMouse(); setTestMenu(true); return; }
    if (k.startsWith('team')) { onTeam(Number(k.slice(4))); return; }
    unlockMouse(); setCrateOpen(k as Kind);
  };
  const pileIndex = useRef(new Map<string, Piled>());
  const onPile = (p: Piled) => setPick({ token: p.token ?? { id: p.id, kind: p.kind, fruit: p.fruit, count: 1, conf: null, defectType: p.defectType, track: null, spawnedAt: 0, seed: true }, landed: true, follow: false });
  const onAim = (hit: Aim) => {
    if (hit.console) { pressConsole(); return; }
    if (hit.pet) { onPet(hit.pet); return; }
    if (hit.team !== undefined) { onTeam(hit.team); return; }
    if (hit.emerg) { onEmerg(hit.emerg); return; }
    const p = hit.pileId ? pileIndex.current.get(hit.pileId) : undefined;
    if (p) { onPile(p); return; }
    const t = hit.tokenId ? props.tokens.find((x) => x.id === hit.tokenId) : undefined;
    if (t) setPick({ token: t, landed: false, follow: false });
  };
  const onMove = (x: number, z: number, yaw: number) => marker.current?.setAttribute('transform', `translate(${x.toFixed(2)} ${z.toFixed(2)}) rotate(${(-yaw * 180 / Math.PI).toFixed(1)})`);

  // Fruit that landed since the page opened, newest first (crate panel)
  const [recent, setRecent] = useState<Record<Kind, Fruit3D[]>>({ good: [], defect: [] });
  const prevTokens = useRef(new Map<string, Fruit3D>());
  useEffect(() => {
    const now = new Map(props.tokens.map((t) => [t.id, t]));
    const landed: Fruit3D[] = [];
    prevTokens.current.forEach((t, id) => { if (!now.has(id) && Date.now() - t.spawnedAt >= props.travelMs * 0.9) landed.push(t); });
    prevTokens.current = now;
    if (!landed.length) return;
    setRecent((r) => ({
      good: [...landed.filter((t) => t.kind === 'good').reverse(), ...r.good].slice(0, 8),
      defect: [...landed.filter((t) => t.kind === 'defect').reverse(), ...r.defect].slice(0, 8),
    }));
  }, [props.tokens, props.travelMs]);

  // Esc: close the crate panel, then release a followed fruit, then leave walk mode (mouse already free)
  useEffect(() => {
    if (!crateOpen && !picked && teamOpen == null && !testMenu && !(walk && !locked)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (testMenu) setTestMenu(false);
      else if (teamOpen != null) setTeamOpen(null);
      else if (crateOpen) setCrateOpen(null);
      else if (picked) setPick(null);
      else exitWalk();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crateOpen, picked, walk, locked, teamOpen, testMenu]);
  const goPreset = (key: PresetKey) => { setPick((p) => (p ? { ...p, follow: false } : p)); setCam((c) => ({ key, nonce: c.nonce + 1 })); };
  const pt = pick?.token;
  const live = pt ? props.tokens.find((t) => t.id === pt.id) : undefined;
  const stage = !pt ? '' : pick?.landed ? `ลงตะกร้า${pt.kind === 'good' ? 'ดี' : 'เสีย'}แล้ว` : live && (Date.now() - live.spawnedAt) / props.travelMs < SCAN[1] ? 'กำลังสแกน' : `กำลังไปตะกร้า${pt.kind === 'good' ? 'ดี' : 'เสีย'}`;
  const DayIcon = env.icon === 'sun' ? Sun : env.icon === 'rise' ? Sunrise : env.icon === 'set' ? Sunset : Moon;

  return <div ref={rootRef} className={`lv3d-root ${walk ? 'walking' : ''}`}
    onClick={(e) => { if (walk && !locked && !crateOpen && e.target instanceof HTMLCanvasElement) lockMouse(); }}>
    <Canvas className="lv3d-canvas" shadows dpr={[1, q.dpr]} camera={{ position: PRESETS.overview.pos, fov: 36 }} gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerMissed={() => { if (!walk) setPick(null); }}>
      <PerformanceMonitor onDecline={decline} flipflops={3} />
      <Line {...props} fun={{ meowKey, barkKey, onPet, marks: { cat: catMarker, dog: dogMarker }, talk: teamOpen, onTeam, emerg: emerg?.kind ?? null, onEmerg: (k) => { unlockMouse(); onEmerg(k); } }} boardData={boardData} onConsole={pressConsole} env={env} q={q} reduced={reduced} pickId={picked} onPick={walk ? () => undefined : onPick} onCrate={(k) => { unlockMouse(); setCrateOpen(k); }} onPile={onPile} pileIndex={pileIndex} registry={registry} />
      {walk
        ? <Walker person={person} warp={warp} onMove={onMove} onNear={setNear} onInteract={interact} onTogglePerson={() => setPerson((p) => (p === 'first' ? 'third' : 'first'))} onAim={onAim} />
        : <>
          <OrbitControls makeDefault target={PRESETS.overview.target} enablePan={false} enableZoom={props.tv} enableDamping minDistance={3} maxDistance={30}
            minPolarAngle={0.02} maxPolarAngle={1.3} />
          <CameraRig preset={cam.key ?? 'overview'} nonce={cam.nonce} followId={pick?.follow ? picked : null} registry={registry} reduced={reduced}
            onUserMove={() => { setCam((c) => (c.key ? { ...c, key: null } : c)); setPick((p) => (p?.follow ? { ...p, follow: false } : p)); }} />
        </>}
      {q.bloom && !reduced && <EffectComposer>
        <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={(props.tv ? 1.1 : 0.7) * (1 + env.night * 0.4)} />
        <Vignette eskil={false} offset={0.25} darkness={props.tv ? 0.7 : 0.35} />
      </EffectComposer>}
    </Canvas>

    {!walk && <div className="lv3d-cams" role="group" aria-label="มุมกล้อง">
      {(Object.keys(PRESETS) as PresetKey[]).map((key) => <button key={key} type="button" className={cam.key === key ? 'on' : ''} onClick={() => goPreset(key)}>{PRESETS[key].label}</button>)}
      <button type="button" className="walk" onClick={enterWalk}>เดินสำรวจ</button>
      <button type="button" className={`drill ${emerg ? 'on' : ''}`} onClick={() => setTestMenu((v) => !v)}>จำลองเหตุฉุกเฉิน</button>
      <span>คลิกผลไม้ (บนสายพานหรือในลัง) / ตะกร้าเพื่อดูข้อมูล</span>
    </div>}
    {walk && <>
      <div className="lv3d-cams" role="group" aria-label="วาร์ป">
        <select aria-label="วาร์ปไป" value="" onChange={(e) => { const w = WARPS.find((x) => x.key === e.target.value); if (w) setWarp((cur) => ({ ...w, n: cur.n + 1 })); e.currentTarget.blur(); }}>
          <option value="">วาร์ปไป...</option>
          {WARPS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
        <button type="button" onClick={() => setPerson((p) => (p === 'first' ? 'third' : 'first'))}>{person === 'first' ? 'มุมบุคคลที่ 3' : 'มุมบุคคลที่ 1'}</button>
        <button type="button" className="exit" onClick={exitWalk}>ออกจากโหมดเดิน</button>
      </div>
      <MiniMap markerRef={marker} catRef={catMarker} dogRef={dogMarker} alert={props.alert} />
      {locked && person === 'first' && <div className="lv3d-cross" />}
      {!locked && !crateOpen && altFree && <div className="lv3d-free">เมาส์อิสระ · กด <kbd>Alt</kbd> อีกครั้ง (หรือคลิกที่ฉาก) เพื่อซ่อนเมาส์และเดินต่อ</div>}
      {!locked && !crateOpen && !altFree && <div className="lv3d-walk-help">
        <b>โหมดเดินสำรวจ</b>
        <button type="button" onClick={lockMouse}>คลิกเพื่อเริ่มเดิน</button>
        <ul>
          <li>คลิกซ้ายที่ผลไม้ (เล็งด้วยกากบาท) ดูข้อมูลลูกนั้น</li>
          <li><kbd>W A S D</kbd> เดิน · <kbd>Shift</kbd> วิ่ง · <kbd>Space</kbd> กระโดด</li>
          <li>เมาส์ หันมอง · <kbd>V</kbd> สลับมุมบุคคลที่ 1 / 3</li>
          <li><kbd>E</kbd> ดูข้อมูลตะกร้าเมื่ออยู่ใกล้ · <kbd>Alt</kbd> สลับเมาส์โผล่ / ซ่อน · <kbd>Esc</kbd> ปล่อยเมาส์</li>
          <li>เดินไปหาทีมงาน (A-D) แล้วกด <kbd>E</kbd> ดูชื่อและหน้าที่ · คลิกแมว/หมาเพื่อทักทาย</li>
          <li>แผงเหลืองข้างโต๊ะควบคุม = จำลองเหตุฉุกเฉิน (แค่ภาพ ไม่กระทบระบบ)</li>
        </ul>
      </div>}
      {near && !crateOpen && teamOpen == null && !testMenu && <div className="lv3d-prompt">{near === 'console'
        ? (props.control.isAdmin ? <>กด <kbd>E</kbd> {props.control.paused ? 'สั่งทำงานต่อ' : 'สั่งหยุดจากเว็บ'} (มีหน้ายืนยัน)</> : 'ห้องควบคุม · ปุ่มใช้ได้เฉพาะ admin')
        : near === 'test' ? <>กด <kbd>E</kbd> เปิดเมนูจำลองเหตุฉุกเฉิน</>
        : near.startsWith('team') ? <>กด <kbd>E</kbd> คุยกับ {TEAM[Number(near.slice(4))].nick}</>
        : <>กด <kbd>E</kbd> ดูข้อมูล{near === 'good' ? 'ตะกร้าดี' : 'ตะกร้าเสีย'}</>}</div>}
    </>}

    <div className="lv3d-opts">
      <span className="lv3d-clock" title="แสงในฉากเปลี่ยนตามเวลาไทย"><DayIcon size={12} />{env.label} {env.clock}</span>
      <select className="lv3d-time" aria-label="เวลาในฉาก" value={String(timeMode)} onChange={(e) => { setTimeMode(e.target.value === 'auto' ? 'auto' : Number(e.target.value)); e.currentTarget.blur(); }}>
        {TIME_MODES.map(([v, label]) => <option key={String(v)} value={String(v)}>{label}</option>)}
      </select>
      {autoDown && <em className="lv3d-auto" title="เครื่องกระตุก ปิดเงาและแสงเรืองชั่วคราว">กราฟิกลดอัตโนมัติ</em>}
    </div>
    {toast && <div className="lv3d-toast">{toast}</div>}
    {emerg && <div className="lv3d-emerg" role="status" style={{ ['--c' as string]: EMERG[emerg.kind].color }}>
      <b>จำลองเหตุ: {EMERG[emerg.kind].label}</b>
      <span>{EMERG[emerg.kind].desc} · โหมดทดสอบ แค่ภาพในฉาก ไม่ส่งคำสั่งและไม่กระทบระบบจริง · เหลือ {Math.max(0, Math.ceil((emerg.until - Date.now()) / 1000))} วิ</span>
      <button type="button" onClick={() => setEmerg(null)}>ยกเลิก</button>
    </div>}
    {testMenu && <div className="lv3d-test" role="dialog" aria-label="จำลองเหตุฉุกเฉิน">
      <div className="lv3d-pick-head"><b>จำลองเหตุฉุกเฉิน</b><span>ทดสอบเท่านั้น · ไม่กระทบระบบ</span>
        <button type="button" title="ปิด (Esc)" onClick={() => setTestMenu(false)}><X size={13} /></button></div>
      {EMERG_KEYS.map((k) => <button key={k} type="button" className={emerg?.kind === k ? 'on' : ''} style={{ ['--c' as string]: EMERG[k].color }} onClick={() => onEmerg(k)}>
        <b>{EMERG[k].label}</b><span>{EMERG[k].desc}</span>
      </button>)}
      {emerg && <button type="button" className="stop" onClick={() => { setEmerg(null); setTestMenu(false); }}>หยุดการจำลอง</button>}
    </div>}
    {teamOpen != null && <TeamCard i={teamOpen} onClose={() => setTeamOpen(null)} />}
    {crateOpen && <CratePanel kind={crateOpen} count={props.bins[crateOpen]} crates={props.crates} recent={recent[crateOpen]} onClose={() => setCrateOpen(null)} />}

    {pt && <div className={`lv3d-pick ${pt.kind}`}>
      <div className="lv3d-pick-head">
        <b>{pt.seed ? 'ในลัง' : pt.count > 1 ? `กลุ่ม ×${pt.count}` : `#${pt.track ?? '-'}`}</b>
        <span>{stage}</span>
        <button type="button" title="เลิกติดตาม (Esc)" onClick={() => setPick(null)}><X size={13} /></button>
      </div>
      <dl>
        <dt>ผลไม้</dt><dd>{pt.fruit ? (FRUIT_TH[pt.fruit] ?? pt.fruit) : 'ไม่ทราบ'}</dd>
        <dt>ผล</dt><dd className={pt.kind}>{pt.kind === 'good' ? 'ดี' : 'เสีย'}</dd>
        <dt>ชนิดเสีย</dt><dd>{pt.kind === 'defect' ? (pt.defectType ? `${DEFECT_TH[pt.defectType] ?? pt.defectType} (${pt.defectType})` : '-') : '-'}</dd>
        <dt>ความมั่นใจ</dt><dd>{pt.conf == null ? '-' : `${(pt.conf <= 1 ? pt.conf * 100 : pt.conf).toFixed(1)}%`}</dd>
        <dt>โมเดล</dt><dd>{pt.model ?? '-'}</dd>
        <dt>track_id</dt><dd>{pt.track ?? '-'}</dd>
        <dt>เวลา (CORE)</dt><dd>{pickTime(pt.ts)}</dd>
      </dl>
      {pt.seed && <p className="lv3d-pick-note">ลูกตั้งต้นในลัง วาดจากยอดรวมตอนเปิดหน้า ไม่มีข้อมูลรายลูก</p>}
      {!pick?.follow && !pick?.landed && <button type="button" className="lv3d-pick-follow" onClick={() => setPick((p) => (p ? { ...p, follow: true } : p))}>ติดตามต่อ</button>}
    </div>}
  </div>;
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
