'use client';

// 3D view of the Live sorting line (react-three-fiber). It only draws: which fruit is on the belt, when it
// started and when it lands all come from SimulateView's replay engine (DB events), same as the 2D scene.
// Every model here (fruit, crates, AGV, trees, siren) is built procedurally in code: no external assets.
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid, Html, OrbitControls, PerformanceMonitor, RoundedBox, Stars } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Moon, Sun, Sunrise, Sunset, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

type Kind = 'good' | 'defect';
export type Fruit3D = {
  id: string; kind: Kind; fruit: string | null; count: number; conf: number | null;
  defectType: string | null; track: number | null; spawnedAt: number;
  model?: string | null; ts?: string | null;
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
};

// ---- Graphics quality ---------------------------------------------------------------------------
export type Quality = 'low' | 'mid' | 'high';
const QUALITY: Record<Quality, { label: string; shadows: boolean; shadowSize: number; bloom: boolean; dpr: number; smoke: number; burst: number; stars: number; waveLight: boolean }> = {
  low: { label: 'ต่ำ', shadows: false, shadowSize: 512, bloom: false, dpr: 1, smoke: 0, burst: 5, stars: 0, waveLight: false },
  mid: { label: 'กลาง', shadows: true, shadowSize: 1024, bloom: true, dpr: 1.25, smoke: 3, burst: 9, stars: 500, waveLight: true },
  high: { label: 'สูง', shadows: true, shadowSize: 2048, bloom: true, dpr: 1.75, smoke: 6, burst: 14, stars: 1400, waveLight: true },
};
const QUALITY_KEY = 'cira-live-3d-quality';
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
const CRATE_FLOOR = 0.12;
const PILE_MAX = 40;
const KINDS: Kind[] = ['good', 'defect'];

// Timeline of one fruit, as a share of travelMs: 0-.16 to the gantry, .16-.36 slowly through it (scanned in
// the middle, SCAN), .36-.5 to the fork, .5-.9 along its branch, .9-1 drops into the crate. Fruit never stop,
// so several on the line do not pile up under the camera. The paddle kicks at .47 (SimulateView).
const SCAN = [0.22, 0.3] as const;
const VERDICT = [0.46, 0.6] as const;
const GATE_IN = new THREE.Vector3(CAM.x - 1, FRUIT_Y, 0);
const GATE_OUT = new THREE.Vector3(CAM.x + 1, FRUIT_Y, 0);
function fruitPos(p: number, kind: Kind, target: THREE.Vector3, out: THREE.Vector3) {
  if (p < 0.16) return out.lerpVectors(START, GATE_IN, p / 0.16);
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
  const perLayer = 10;
  const layer = Math.floor(index / perLayer);
  const i = index % perLayer;
  const col = i % 5; const row = Math.floor(i / 5);
  const base = CRATE[kind];
  const dir = dirOf(kind); const side = new THREE.Vector3(-dir.z, 0, dir.x);
  const jitter = (hash(id) - 0.5) * 0.12;
  return base.clone()
    .add(side.multiplyScalar((col - 2) * 0.36 + jitter + (layer % 2) * 0.16))
    .add(dir.clone().multiplyScalar((row - 0.5) * 0.42 + jitter))
    .setY(CRATE_FLOOR + FRUIT_R + layer * 0.3);
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
  [16.5, '#e7f1eb', '#ffffff', '#cfe3d6', 1.1, '#fff6e8', 2.6, 0],
  [18, '#f6b98c', '#ffc893', '#9a7a66', 0.8, '#ff9446', 1.9, 0.25],
  [19.5, '#2b2442', '#8a7ab0', '#19142a', 0.45, '#ff8a5a', 0.65, 0.75],
  [21, '#0b1724', '#6a80b4', '#101a2a', 0.6, '#a9bbff', 0.75, 1],
  [24, '#0b1724', '#6a80b4', '#101a2a', 0.6, '#a9bbff', 0.75, 1],
];
type Env = { sky: string; hemiSky: string; hemiGround: string; hemiI: number; sun: string; sunI: number; night: number;
  ground: string; cell: string; section: string; sunPos: [number, number, number]; label: string; icon: 'sun' | 'rise' | 'set' | 'moon'; clock: string };
const mix = (a: string, b: string, t: number) => `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;
function envAt(hour: number, tv: boolean): Env {
  let i = 0;
  while (i < DAY_KEYS.length - 2 && hour >= DAY_KEYS[i + 1][0]) i++;
  const a = DAY_KEYS[i]; const b = DAY_KEYS[i + 1];
  const t = clamp01((hour - a[0]) / (b[0] - a[0]));
  let night = THREE.MathUtils.lerp(a[7], b[7], t);
  let sky = mix(a[1], b[1], t);
  let ground = mix('#eef5f0', '#111c22', night);
  let hemiI = THREE.MathUtils.lerp(a[4], b[4], t);
  if (tv) { sky = mix(sky, '#07130f', 0.6); ground = mix(ground, '#0b1914', 0.6); night = Math.max(night, 0.4); hemiI *= 0.75; }
  const dayT = clamp01((hour - 6) / 12);
  const isDay = hour >= 6 && hour <= 18.5;
  const ang = dayT * Math.PI;
  const sunPos: [number, number, number] = isDay ? [-Math.cos(ang) * 13, Math.max(3, Math.sin(ang) * 13), 7] : [6, 12, -5];
  const label = hour < 5 ? 'กลางคืน' : hour < 6.5 ? 'เช้ามืด' : hour < 8 ? 'เช้า' : hour < 16.5 ? 'กลางวัน' : hour < 18.5 ? 'เย็น' : hour < 19.5 ? 'พลบค่ำ' : 'กลางคืน';
  const icon = hour < 5 || hour >= 19.5 ? 'moon' : hour < 8 ? 'rise' : hour < 16.5 ? 'sun' : 'set';
  const hh = Math.floor(hour); const mm = Math.floor((hour - hh) * 60);
  return {
    sky, hemiSky: mix(a[2], b[2], t), hemiGround: mix(a[3], b[3], t), hemiI,
    sun: mix(a[5], b[5], t), sunI: THREE.MathUtils.lerp(a[6], b[6], t), night, ground,
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
  return <group ref={ref}>
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

type Piled = { id: string; fruit: string | null; defectType: string | null; pos: THREE.Vector3 };

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

function Belt({ from, to, width, strip, speed }: { from: THREE.Vector3; to: THREE.Vector3; width: number; strip: THREE.Material; speed: React.MutableRefObject<number> }) {
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
    <mesh position={[0, BELT_Y + 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[len, width]} />
      <meshStandardMaterial map={tex} roughness={0.85} />
    </mesh>
    {[-1, 1].map((s) => <group key={s}>
      <mesh position={[0, BELT_Y + 0.08, s * (width / 2 + 0.1)]} castShadow>
        <boxGeometry args={[len, 0.16, 0.12]} />
        <meshStandardMaterial color="#f7faf8" roughness={0.3} />
      </mesh>
      <mesh position={[0, BELT_Y + 0.02, s * (width / 2 + 0.165)]} material={strip}>
        <boxGeometry args={[len * 0.96, 0.04, 0.012]} />
      </mesh>
    </group>)}
    {legs.map((i) => {
      const x = -len / 2 + 0.6 + (i * (len - 1.2)) / Math.max(1, legs.length - 1);
      return [-1, 1].map((s) => <mesh key={`${i}${s}`} position={[x, (BELT_Y - 0.24) / 2, s * (width / 2 + 0.05)]} castShadow>
        <boxGeometry args={[0.16, BELT_Y - 0.24, 0.16]} />
        <meshStandardMaterial color="#cfd8d3" />
      </mesh>);
    })}
  </group>;
}

function Gantry({ beam, cone, head, scan, reduced }: { beam: THREE.Material; cone: THREE.MeshBasicMaterial; head: THREE.MeshStandardMaterial; scan: React.MutableRefObject<ScanState>; reduced: boolean }) {
  const laser = useRef<THREE.Group>(null);
  const lineMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#4dffe0', toneMapped: false, transparent: true, opacity: 0.95 }), []);
  const fanMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#4dffe0', toneMapped: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }), []);
  const fan = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 2.42, 0, 0, BELT_Y + 0.03, -0.72, 0, BELT_Y + 0.03, 0.72], 3));
    return g;
  }, []);
  useEffect(() => () => { lineMat.dispose(); fanMat.dispose(); fan.dispose(); }, [lineMat, fanMat, fan]);
  const red = useMemo(() => new THREE.Color('#ff2a22'), []);
  const teal = useMemo(() => new THREE.Color('#4dffe0'), []);
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
  });
  return <group position={[CAM.x, 0, 0]}>
    {[-1, 1].map((s) => <RoundedBox key={s} args={[0.32, 2.9, 0.32]} radius={0.06} position={[0, 1.45, s * 1.2]} castShadow>
      <meshStandardMaterial color="#f4f7f5" roughness={0.3} />
    </RoundedBox>)}
    {[-1, 1].map((s) => <mesh key={`b${s}`} position={[0.17, 1.4, s * 1.2]} material={beam}><boxGeometry args={[0.012, 1.6, 0.08]} /></mesh>)}
    <RoundedBox args={[0.7, 0.4, 2.75]} radius={0.08} position={[0, 2.95, 0]} castShadow>
      <meshStandardMaterial color="#f4f7f5" roughness={0.3} />
    </RoundedBox>
    <RoundedBox args={[0.55, 0.3, 0.75]} radius={0.06} position={[0, 2.62, 0]} material={head} castShadow />
    <mesh position={[0, 2.45, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[0.12, 0.14, 0.08, 20]} />
      <meshBasicMaterial color="#7ff7e0" toneMapped={false} />
    </mesh>
    <mesh position={[0, 1.6, 0]} material={cone}>
      <coneGeometry args={[0.95, 1.7, 32, 1, true]} />
    </mesh>
    <group ref={laser}>
      <mesh position={[0, BELT_Y + 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]} material={lineMat}>
        <planeGeometry args={[0.03, 1.44]} />
      </mesh>
      <mesh geometry={fan} material={fanMat} />
    </group>
    <spotLight position={[0, 2.4, 0]} target-position={[CAM.x, 0, 0]} angle={0.5} penumbra={0.6} intensity={6} color="#6ff2dc" distance={4} />
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

function StationCrate({ kind, rim, swap, glow }: { kind: Kind; rim: THREE.Material; swap: Swap | null; glow: number }) {
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
    <group ref={ref}><CrateModel kind={kind} rim={rim} /></group>
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
  const far = station.clone().add(dir.clone().multiplyScalar(11));
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
  return <group position={[-2.4, 0, -1.6]}>
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
const HOLO = { pos: [-1.6, 2.75, -4.3] as [number, number, number], w: 3.6, h: 2.0 };
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
    <group position={HOLO.pos} rotation={[-0.08, 0.08, 0]}>
      <mesh material={glass}><planeGeometry args={[HOLO.w, HOLO.h]} /></mesh>
      <lineSegments geometry={frame} material={edge} />
      {bars.map((_, i) => {
        const x = -HOLO.w / 2 + 0.15 + bw * (i + 0.5);
        return <group key={i}>
          <mesh ref={(el) => { goodRefs.current[i] = el; }} geometry={barGeo} material={gm} position={[x, base, 0.01]} scale={[bw * 0.7, 0.002, 0.02]} />
          <mesh ref={(el) => { badRefs.current[i] = el; }} geometry={barGeo} material={dm} position={[x, base, 0.012]} scale={[bw * 0.7, 0.002, 0.02]} />
        </group>;
      })}
      <Html position={[0, HOLO.h / 2 - 0.32, 0]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
        <div className="lv3d-holo">
          <div><b>{stats.epm.toLocaleString()}</b><span>ผล/นาที</span></div>
          <div className={Number(stats.defectRate) >= 30 ? 'bad' : Number(stats.defectRate) >= 15 ? 'warn' : ''}><b>{stats.defectRate}%</b><span>defect</span></div>
          <em>5 นาทีล่าสุด</em>
        </div>
      </Html>
    </group>
    {/* projector on the floor */}
    <group position={[HOLO.pos[0], 0, HOLO.pos[2]]}>
      <mesh position={[0, 0.1, 0]} castShadow><cylinderGeometry args={[0.38, 0.45, 0.2, 12]} /><meshStandardMaterial color="#2b3236" /></mesh>
      <mesh position={[0, 0.21, 0]}><cylinderGeometry args={[0.28, 0.28, 0.02, 16]} /><meshBasicMaterial color="#6ff7e4" toneMapped={false} /></mesh>
      <mesh position={[0, (HOLO.pos[1] - HOLO.h / 2 + 0.2) / 2 + 0.1, 0]} material={beam}>
        <cylinderGeometry args={[1.0, 0.28, HOLO.pos[1] - HOLO.h / 2 - 0.1, 16, 1, true]} />
      </mesh>
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
type LineProps = Props & { env: Env; q: Q; reduced: boolean; pickId: string | null; onPick: (t: Fruit3D) => void; registry: React.MutableRefObject<Map<string, THREE.Vector3>> };

function Line({ tokens, travelMs, playing, paddleKey, modelKey, powerKey, alert, seed, bins, stats, env, q, reduced, pickId, onPick, registry }: LineProps) {
  const speed = useRef(0);
  const power = useRef(0);
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
    const make = (kind: Kind, n: number) => Array.from({ length: Math.min(n, kind === 'good' ? 28 : 18) }, (_, i) => {
      const id = `seed-${kind}-${i}`;
      const fruit = seed.fruits.length ? seed.fruits[Math.floor(hash(id) * seed.fruits.length)] : 'apple';
      return { id, fruit, defectType: kind === 'defect' ? ['rot', 'bruise', 'crack'][i % 3] : null, pos: pileSlot(kind, i, id) };
    });
    return { good: make('good', seed.good), defect: make('defect', seed.defect) };
  });
  const pileRef = useRef(pile); pileRef.current = pile;
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
        list.push({ id: t.id, fruit: t.fruit, defectType: t.kind === 'defect' ? (t.count === 1 ? t.defectType ?? 'rot' : null) : null, pos: pos.clone() });
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
    if (keyLight.current) keyLight.current.intensity = env.sunI * (0.5 + 0.5 * Math.min(1, pw));
  });

  return <>
    <color attach="background" args={[env.sky]} />
    <fog attach="fog" args={[env.sky, 22, 46]} />
    <hemisphereLight color={env.hemiSky} groundColor={env.hemiGround} intensity={env.hemiI} />
    <directionalLight ref={keyLight} position={env.sunPos} color={env.sun} intensity={env.sunI} castShadow={q.shadows}
      shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={9} shadow-camera-bottom={-9} shadow-bias={-0.0004} />
    {q.stars > 0 && env.night > 0.5 && <Stars radius={70} depth={25} count={q.stars} factor={3} saturation={0} fade speed={reduced ? 0 : 0.4} />}

    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[90, 90]} />
      <meshStandardMaterial color={env.ground} roughness={0.9} />
    </mesh>
    <Grid position={[0, 0.002, 0]} args={[60, 60]} cellSize={1} cellThickness={0.5} sectionSize={5} sectionThickness={1}
      cellColor={env.cell} sectionColor={env.section} fadeDistance={34} fadeStrength={1.4} infiniteGrid />

    <Belt from={new THREE.Vector3(START.x - 0.6, 0, 0)} to={new THREE.Vector3(FORK.x + 0.4, 0, 0)} width={1.4} strip={mats.green} speed={speed} />
    <Belt from={new THREE.Vector3(FORK.x, 0, -0.1)} to={END.good.clone().add(dirOf('good').multiplyScalar(0.35))} width={1.3} strip={mats.green} speed={speed} />
    <Belt from={new THREE.Vector3(FORK.x, 0, 0.1)} to={END.defect.clone().add(dirOf('defect').multiplyScalar(0.35))} width={1.3} strip={mats.orange} speed={speed} />
    <Gantry beam={mats.teal} cone={mats.cone} head={mats.head} scan={scan} reduced={reduced} />
    <Diverter paddleKey={paddleKey} mat={mats.paddle} />
    {KINDS.map((kind) => <StationCrate key={kind} kind={kind} rim={kind === 'good' ? mats.green : mats.orange} swap={swap[kind]} glow={1 + env.night * 1.5} />)}
    {KINDS.map((kind) => swap[kind] && <Agv key={`agv-${kind}`} kind={kind} swap={swap[kind]!} rim={kind === 'good' ? mats.green : mats.orange} />)}
    <CrateLabel kind="good" count={bins.good} last={bins.lastGood} hit={bins.hitGood} fill={pile.good.length} swapping={!!swap.good} />
    <CrateLabel kind="defect" count={bins.defect} last={bins.lastDefect} hit={bins.hitDefect} fill={pile.defect.length} swapping={!!swap.defect} />
    <Siren alert={alert} reduced={reduced} />
    <ModelWave modelKey={modelKey} reduced={reduced} withLight={q.waveLight} />
    <HoloPanel stats={stats} reduced={reduced} />

    <Tree x={-9} z={-6.5} fruit="orange" />
    <Tree x={-3} z={-7.5} s={1.2} fruit="apple" />
    <Tree x={3.5} z={-8} fruit="orange" />
    <Tree x={11.5} z={-7} s={1.1} fruit="apple" />
    <Tree x={-12} z={5} s={0.9} fruit="apple" />
    <Tree x={-14} z={1.5} s={0.95} fruit="orange" />

    {tokens.map((t) => <MovingFruit key={t.id} token={t} travelMs={travelMs} pileTarget={targets.current.get(t.id) ?? CRATE[t.kind]}
      selected={pickId === t.id} onPick={onPick} registry={registry} q={q} reduced={reduced} />)}
    {KINDS.flatMap((kind) => pile[kind].map((p) => <group key={`pile-${p.id}`} position={p.pos}>
      <FruitBody fruit={p.fruit} defectType={p.defectType} seed={p.id} />
    </group>))}
    {bursts.map((b) => <Burst key={b.key} at={b.at} color={b.color} count={q.burst} onDone={() => setBursts((cur) => cur.filter((x) => x.key !== b.key))} />)}
  </>;
}

// ---- Camera presets / follow ----------------------------------------------------------------------
type PresetKey = 'overview' | 'gate' | 'fork' | 'top';
const PRESETS: Record<PresetKey, { label: string; pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { label: 'ภาพรวม', pos: [-0.6, 9.2, 15.2], target: [-0.6, 0.6, 0] },
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
  const [quality, setQuality] = useState<Quality>('high');
  const [autoDown, setAutoDown] = useState(false);
  const qualityRef = useRef(quality); qualityRef.current = quality;
  useEffect(() => {
    try { const s = window.localStorage.getItem(QUALITY_KEY); if (s === 'low' || s === 'mid' || s === 'high') setQuality(s); } catch { /* storage blocked */ }
  }, []);
  const chooseQuality = (q: Quality) => {
    setQuality(q); setAutoDown(false);
    try { window.localStorage.setItem(QUALITY_KEY, q); } catch { /* storage blocked */ }
  };
  // FPS too low: step down one level for this visit (the saved choice stays as it is)
  const decline = () => {
    const cur = qualityRef.current;
    if (cur === 'low') return;
    setQuality(cur === 'high' ? 'mid' : 'low'); setAutoDown(true);
  };
  const q = QUALITY[quality];

  const [hour, setHour] = useState(bangkokHour);
  useEffect(() => { const id = window.setInterval(() => setHour(bangkokHour()), 30000); return () => window.clearInterval(id); }, []);
  const env = useMemo(() => envAt(hour, props.tv), [hour, props.tv]);

  const [cam, setCam] = useState<{ key: PresetKey | null; nonce: number }>({ key: 'overview', nonce: 0 });
  const registry = useRef(new Map<string, THREE.Vector3>());
  const [pick, setPick] = useState<Pick | null>(null);
  const onPick = (token: Fruit3D) => { setPick({ token, landed: false, follow: true }); setCam((c) => ({ ...c, key: null })); };
  const picked = pick?.token.id ?? null;
  const landedNow = !!pick && !pick.landed && !props.tokens.some((t) => t.id === pick.token.id);
  useEffect(() => { if (landedNow) setPick((p) => (p ? { ...p, landed: true, follow: false } : p)); }, [landedNow]);
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPick(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picked]);
  const goPreset = (key: PresetKey) => { setPick((p) => (p ? { ...p, follow: false } : p)); setCam((c) => ({ key, nonce: c.nonce + 1 })); };
  const pt = pick?.token;
  const live = pt ? props.tokens.find((t) => t.id === pt.id) : undefined;
  const stage = !pt ? '' : pick?.landed ? `ลงตะกร้า${pt.kind === 'good' ? 'ดี' : 'เสีย'}แล้ว` : live && (Date.now() - live.spawnedAt) / props.travelMs < SCAN[1] ? 'กำลังสแกน' : `กำลังไปตะกร้า${pt.kind === 'good' ? 'ดี' : 'เสีย'}`;
  const DayIcon = env.icon === 'sun' ? Sun : env.icon === 'rise' ? Sunrise : env.icon === 'set' ? Sunset : Moon;

  return <div className="lv3d-root">
    <Canvas className="lv3d-canvas" shadows dpr={[1, q.dpr]} camera={{ position: PRESETS.overview.pos, fov: 36 }} gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerMissed={() => setPick(null)}>
      <PerformanceMonitor onDecline={decline} flipflops={3} />
      <Line {...props} env={env} q={q} reduced={reduced} pickId={picked} onPick={onPick} registry={registry} />
      <OrbitControls makeDefault target={PRESETS.overview.target} enablePan={false} enableZoom={props.tv} enableDamping minDistance={3} maxDistance={30}
        minPolarAngle={0.02} maxPolarAngle={1.3} />
      <CameraRig preset={cam.key ?? 'overview'} nonce={cam.nonce} followId={pick?.follow ? picked : null} registry={registry} reduced={reduced}
        onUserMove={() => { setCam((c) => (c.key ? { ...c, key: null } : c)); setPick((p) => (p?.follow ? { ...p, follow: false } : p)); }} />
      {q.bloom && !reduced && <EffectComposer>
        <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={(props.tv ? 1.1 : 0.7) * (1 + env.night * 0.4)} />
        <Vignette eskil={false} offset={0.25} darkness={props.tv ? 0.7 : 0.35} />
      </EffectComposer>}
    </Canvas>

    <div className="lv3d-cams" role="group" aria-label="มุมกล้อง">
      {(Object.keys(PRESETS) as PresetKey[]).map((key) => <button key={key} type="button" className={cam.key === key ? 'on' : ''} onClick={() => goPreset(key)}>{PRESETS[key].label}</button>)}
      <span>คลิกผลไม้เพื่อติดตาม</span>
    </div>

    <div className="lv3d-opts">
      <span className="lv3d-clock" title="แสงในฉากเปลี่ยนตามเวลาไทย"><DayIcon size={12} />{env.label} {env.clock}</span>
      <span className="lv3d-quality" role="group" aria-label="คุณภาพกราฟิก" title={autoDown ? 'ลดคุณภาพอัตโนมัติเพราะ FPS ต่ำ' : 'คุณภาพกราฟิก (จำไว้ในเบราว์เซอร์นี้)'}>
        กราฟิก
        {(['low', 'mid', 'high'] as Quality[]).map((k) => <button key={k} type="button" className={quality === k ? 'on' : ''} aria-pressed={quality === k} onClick={() => chooseQuality(k)}>{QUALITY[k].label}</button>)}
        {autoDown && <em>ลดอัตโนมัติ</em>}
      </span>
    </div>

    {pt && <div className={`lv3d-pick ${pt.kind}`}>
      <div className="lv3d-pick-head">
        <b>{pt.count > 1 ? `กลุ่ม ×${pt.count}` : `#${pt.track ?? '-'}`}</b>
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
