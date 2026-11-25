'use client';

// 3D view of the Live sorting line (react-three-fiber). It only draws: which fruit is on the belt, when it
// started and when it lands all come from SimulateView's replay engine (DB events), same as the 2D scene.
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, Html, OrbitControls, RoundedBox } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

export type Fruit3D = {
  id: string; kind: 'good' | 'defect'; fruit: string | null; count: number; conf: number | null;
  defectType: string | null; track: number | null; spawnedAt: number;
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
};

// ---- Line layout (world units) -------------------------------------------------------------
const BELT_Y = 0.75;
const FRUIT_R = 0.22;
const FRUIT_Y = BELT_Y + FRUIT_R + 0.02;
const START = new THREE.Vector3(-11, FRUIT_Y, 0);
const CAM = new THREE.Vector3(-5, FRUIT_Y, 0);
const FORK = new THREE.Vector3(0, FRUIT_Y, 0);
const END = { good: new THREE.Vector3(7.2, FRUIT_Y, -3.4), defect: new THREE.Vector3(7.2, FRUIT_Y, 3.4) };
const dirOf = (kind: 'good' | 'defect') => END[kind].clone().sub(FORK).setY(0).normalize();
const CRATE = {
  good: END.good.clone().add(dirOf('good').multiplyScalar(1.35)).setY(0),
  defect: END.defect.clone().add(dirOf('defect').multiplyScalar(1.35)).setY(0),
};
const CRATE_FLOOR = 0.12;
const PILE_MAX = 40;

// Timeline of one fruit, as a share of travelMs: 0-.16 to the gantry, .16-.36 slowly through it (scanned in
// the middle, SCAN), .36-.5 to the fork, .5-.9 along its branch, .9-1 drops into the crate. Fruit never stop,
// so several on the line do not pile up under the camera. The paddle kicks at .47 (SimulateView).
const SCAN = [0.22, 0.3] as const;
const VERDICT = [0.46, 0.6] as const;
const GATE_IN = new THREE.Vector3(CAM.x - 1, FRUIT_Y, 0);
const GATE_OUT = new THREE.Vector3(CAM.x + 1, FRUIT_Y, 0);
function fruitPos(p: number, kind: 'good' | 'defect', target: THREE.Vector3, out: THREE.Vector3) {
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

const FRUIT_COLOR: Record<string, string> = { apple: '#d22f27', orange: '#f59a1c', banana: '#f2d23c' };
const DEFECT_COLOR: Record<string, string> = { rot: '#3a2414', bruise: '#5a2f4d', crack: '#1c1a18' };

// Stable pseudo-random from a string (pile layout must not jump between renders).
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function pileSlot(kind: 'good' | 'defect', index: number, id: string) {
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

// ---- Fruit ----------------------------------------------------------------------------------
function FruitBody({ fruit, defectType, seed }: { fruit: string | null; defectType: string | null; seed: string }) {
  const color = (fruit && FRUIT_COLOR[fruit]) || '#9cc24a';
  const apple = fruit === 'apple';
  const spot = defectType ? DEFECT_COLOR[defectType] ?? '#2b2018' : null;
  const tilt = hash(seed) * Math.PI * 2;
  return <group rotation={[0, tilt, 0]}>
    <mesh castShadow scale={apple ? [1, 0.9, 1] : [1, 0.96, 1]}>
      <sphereGeometry args={[FRUIT_R, 24, 18]} />
      <meshStandardMaterial color={color} roughness={apple ? 0.35 : 0.7} metalness={0.02} />
    </mesh>
    <mesh position={[0, FRUIT_R * 0.92, 0]}>
      <cylinderGeometry args={[0.014, 0.018, 0.08, 6]} />
      <meshStandardMaterial color="#5b3a1e" />
    </mesh>
    <mesh position={[0.05, FRUIT_R * 0.97, 0]} rotation={[0, 0, -0.9]} scale={[1, 0.3, 0.6]}>
      <sphereGeometry args={[0.05, 8, 6]} />
      <meshStandardMaterial color="#3e9b3a" />
    </mesh>
    {spot && defectType === 'crack' && <mesh position={[0, 0.02, FRUIT_R * 0.98]} rotation={[0, 0, 0.6]}>
      <boxGeometry args={[0.22, 0.025, 0.02]} />
      <meshStandardMaterial color={spot} />
    </mesh>}
    {spot && defectType !== 'crack' && <mesh position={[0.06, 0.04, FRUIT_R * 0.86]} scale={[1, 0.85, 0.35]}>
      <sphereGeometry args={[defectType === 'rot' ? 0.11 : 0.085, 12, 10]} />
      <meshStandardMaterial color={spot} roughness={0.95} />
    </mesh>}
  </group>;
}

function MovingFruit({ token, travelMs, pileTarget }: { token: Fruit3D; travelMs: number; pileTarget: THREE.Vector3 }) {
  const ref = useRef<THREE.Group>(null);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const [stage, setStage] = useState<'move' | 'scan' | 'verdict' | 'go'>('move');
  const stageRef = useRef(stage);
  useFrame(() => {
    const p = Math.min(1, (Date.now() - token.spawnedAt) / travelMs);
    fruitPos(p, token.kind, pileTarget, pos);
    const g = ref.current;
    if (g) {
      g.position.copy(pos);
      g.rotation.z = -pos.x / FRUIT_R * 0.5;
      g.rotation.x = pos.z / FRUIT_R * 0.5;
      g.visible = p > 0.005;
    }
    const next = p < SCAN[0] ? 'move' : p < SCAN[1] ? 'scan' : p < VERDICT[0] ? 'move' : p < VERDICT[1] ? 'verdict' : 'go';
    if (next !== stageRef.current) { stageRef.current = next; setStage(next); }
  });
  const extra = Math.min(token.count, 3);
  const verdict = token.kind === 'defect' ? (token.defectType ?? 'defect') : 'good';
  return <group ref={ref}>
    <FruitBody fruit={token.fruit} defectType={token.kind === 'defect' && token.count === 1 ? token.defectType : null} seed={token.id} />
    {extra > 1 && <group position={[-0.32, 0, 0.18]}><FruitBody fruit={token.fruit} defectType={null} seed={`${token.id}b`} /></group>}
    {extra > 2 && <group position={[-0.3, 0, -0.22]}><FruitBody fruit={token.fruit} defectType={null} seed={`${token.id}c`} /></group>}
    {stage === 'scan' && <mesh>
      <boxGeometry args={[FRUIT_R * 2.6 + (extra - 1) * 0.3, FRUIT_R * 2.6, FRUIT_R * 2.6 + (extra - 1) * 0.3]} />
      <meshBasicMaterial color="#33f0d0" wireframe transparent opacity={0.9} toneMapped={false} />
    </mesh>}
    {(stage === 'scan' || stage === 'verdict') && <Html center position={[0, 0.62, 0]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
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

function Burst({ at, color, onDone }: { at: THREE.Vector3; color: string; onDone: () => void }) {
  const group = useRef<THREE.Group>(null);
  const born = useRef(performance.now());
  const dirs = useMemo(() => Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a), 1.2 + (i % 3) * 0.5, Math.sin(a)).multiplyScalar(1.4);
  }), []);
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
    {dirs.map((_, i) => <mesh key={i}><sphereGeometry args={[0.05, 6, 5]} /><meshBasicMaterial color={color} toneMapped={false} /></mesh>)}
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

function Gantry({ beam, cone, head, scanning }: { beam: THREE.Material; cone: THREE.MeshBasicMaterial; head: THREE.MeshStandardMaterial; scanning: React.MutableRefObject<number> }) {
  const laser = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (laser.current) laser.current.position.x = Math.sin(clock.elapsedTime * 3.2) * 0.45;
    cone.opacity = 0.1 + scanning.current * 0.22;
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
    <mesh ref={laser} position={[0, BELT_Y + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[0.035, 1.5]} />
      <meshBasicMaterial color="#4dffe0" toneMapped={false} transparent opacity={0.95} />
    </mesh>
    <spotLight position={[0, 2.4, 0]} target-position={[CAM.x, 0, 0]} angle={0.5} penumbra={0.6} intensity={6} color="#6ff2dc" distance={4} />
  </group>;
}

function Diverter({ paddleKey, mat }: { paddleKey: number; mat: THREE.MeshStandardMaterial }) {
  const pivot = useRef<THREE.Group>(null);
  const kickAt = useRef(-1e9);
  useEffect(() => { if (paddleKey) kickAt.current = performance.now(); }, [paddleKey]);
  const rest = 0.38; const kick = -0.42;
  useFrame(() => {
    const t = (performance.now() - kickAt.current) / 850;
    const env = t < 0 || t > 1 ? 0 : t < 0.22 ? t / 0.22 : t < 0.62 ? 1 : 1 - (t - 0.62) / 0.38;
    if (pivot.current) pivot.current.rotation.y = rest + (kick - rest) * env;
    mat.emissive.set(env > 0.05 ? '#ff8a2a' : '#2fe0b4');
  });
  return <group position={[FORK.x - 0.2, BELT_Y + 0.2, -0.85]}>
    <mesh position={[0, -0.1, 0]} castShadow><cylinderGeometry args={[0.12, 0.14, 0.4, 16]} /><meshStandardMaterial color="#e9efeb" /></mesh>
    <group ref={pivot}>
      <RoundedBox args={[1.45, 0.16, 0.1]} radius={0.04} position={[0.72, 0, 0]} material={mat} castShadow />
    </group>
  </group>;
}

function Crate({ kind, rim }: { kind: 'good' | 'defect'; rim: THREE.Material }) {
  const c = CRATE[kind];
  const dir = dirOf(kind);
  const angle = -Math.atan2(dir.z, dir.x);
  const W = 2.1; const D = 1.5; const H = 0.95; const T = 0.08;
  return <group position={[c.x, 0, c.z]} rotation={[0, angle, 0]}>
    <mesh position={[0, T / 2, 0]} receiveShadow><boxGeometry args={[W, T, D]} /><meshStandardMaterial color="#f2f5f3" /></mesh>
    {[[0, D / 2, W, T], [0, -D / 2, W, T]].map(([x, z, w, d], i) => <mesh key={`a${i}`} position={[x, H / 2, z]} castShadow receiveShadow>
      <boxGeometry args={[w, H, d]} /><meshStandardMaterial color="#f7f9f8" roughness={0.5} />
    </mesh>)}
    {[[W / 2, 0], [-W / 2, 0]].map(([x, z], i) => <mesh key={`b${i}`} position={[x, H / 2, z]} castShadow receiveShadow>
      <boxGeometry args={[T, H, D]} /><meshStandardMaterial color="#f7f9f8" roughness={0.5} />
    </mesh>)}
    {[[0, D / 2, W + T, 0.05], [0, -D / 2, W + T, 0.05]].map(([x, z, w, d], i) => <mesh key={`r${i}`} position={[x, H + 0.02, z]} material={rim}><boxGeometry args={[w, 0.05, d + 0.04]} /></mesh>)}
    {[[W / 2, 0], [-W / 2, 0]].map(([x, z], i) => <mesh key={`s${i}`} position={[x, H + 0.02, z]} material={rim}><boxGeometry args={[0.09, 0.05, D]} /></mesh>)}
    <pointLight position={[0, H + 0.6, 0]} intensity={2.2} distance={3.2} color={kind === 'good' ? '#5dffa4' : '#ffae55'} />
  </group>;
}

function Tree({ x, z, s = 1, fruit }: { x: number; z: number; s?: number; fruit: string }) {
  const balls = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const a = i * 2.3; const r = 0.75 + (i % 2) * 0.2;
    return [Math.cos(a) * r, 2.1 + (i % 3) * 0.35, Math.sin(a) * r] as [number, number, number];
  }), []);
  return <group position={[x, 0, z]} scale={s}>
    <mesh position={[0, 0.25, 0]} castShadow><cylinderGeometry args={[0.7, 0.6, 0.5, 20]} /><meshStandardMaterial color="#eef3f0" /></mesh>
    <mesh position={[0, 1.1, 0]} castShadow><cylinderGeometry args={[0.1, 0.14, 1.4, 8]} /><meshStandardMaterial color="#7a5636" /></mesh>
    <mesh position={[0, 2.3, 0]} castShadow><icosahedronGeometry args={[1.05, 1]} /><meshStandardMaterial color="#4fae55" flatShading /></mesh>
    {balls.map((p, i) => <mesh key={i} position={p} castShadow><sphereGeometry args={[0.13, 10, 8]} /><meshStandardMaterial color={FRUIT_COLOR[fruit]} /></mesh>)}
  </group>;
}

// ---- Scene --------------------------------------------------------------------------------------
function Line({ tokens, travelMs, playing, paddleKey, modelKey, powerKey, alert, seed, tv }: Props) {
  const speed = useRef(0);
  const power = useRef(0);
  const scanning = useRef(0);
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
  const base = useMemo(() => ({ green: mats.green.color.clone(), orange: mats.orange.color.clone(), teal: mats.teal.color.clone() }), [mats]);
  const alertLight = useRef<THREE.PointLight>(null);
  const keyLight = useRef<THREE.DirectionalLight>(null);

  // Crate piles: seeded from the window totals so crates are not empty on open, then grow as fruit land.
  const [pile, setPile] = useState<{ good: Piled[]; defect: Piled[] }>(() => {
    const make = (kind: 'good' | 'defect', n: number) => Array.from({ length: Math.min(n, kind === 'good' ? 40 : 24) }, (_, i) => {
      const id = `seed-${kind}-${i}`;
      const fruit = seed.fruits.length ? seed.fruits[Math.floor(hash(id) * seed.fruits.length)] : 'apple';
      return { id, fruit, defectType: kind === 'defect' ? ['rot', 'bruise', 'crack'][i % 3] : null, pos: pileSlot(kind, i, id) };
    });
    return { good: make('good', seed.good), defect: make('defect', seed.defect) };
  });
  const pileCount = useRef({ good: pile.good.length, defect: pile.defect.length });
  const [bursts, setBursts] = useState<{ key: string; at: THREE.Vector3; color: string }[]>([]);

  // Where each fruit on the belt will land, fixed when it first appears.
  const targets = useRef(new Map<string, THREE.Vector3>());
  const prev = useRef(new Map<string, Fruit3D>());
  for (const t of tokens) {
    if (!targets.current.has(t.id)) {
      const index = pileCount.current[t.kind] % PILE_MAX;
      pileCount.current[t.kind] += 1;
      targets.current.set(t.id, pileSlot(t.kind, index, t.id));
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
        // reuse the slot this fruit aimed at (oldest fruit there leaves once the crate is full)
        const clash = list.findIndex((p) => p.pos.distanceToSquared(pos) < 0.01);
        if (clash >= 0) list.splice(clash, 1);
        list.push({ id: t.id, fruit: t.fruit, defectType: t.kind === 'defect' ? t.defectType : null, pos });
        if (list.length > PILE_MAX) list.shift();
      }
      return next;
    });
    setBursts((cur) => [...cur.slice(-6), ...landed.map((t) => ({ key: `${t.id}-b`, at: (targets.current.get(t.id) ?? CRATE[t.kind]).clone().setY(1.1), color: t.kind === 'good' ? '#43ff9a' : '#ffa043' }))]);
    landed.forEach((t) => targets.current.delete(t.id));
  }, [tokens, travelMs]);

  useFrame(({ clock }, dt) => {
    const k = 1 - Math.exp(-dt * 1.6);
    speed.current += ((playing ? 3.6 : 0) - speed.current) * k;
    power.current += ((playing ? 1 : 0.12) - power.current) * (1 - Math.exp(-dt * 2.2));
    const sincePower = (performance.now() - powerKick.current) / 1000;
    const flash = sincePower < 1.2 ? Math.sin(Math.min(1, sincePower / 1.2) * Math.PI) * 1.6 : 0;
    const pw = power.current + flash;
    mats.green.color.copy(base.green).multiplyScalar(0.25 + 1.6 * pw);
    mats.orange.color.copy(base.orange).multiplyScalar(0.25 + 1.6 * pw);
    mats.teal.color.copy(base.teal).multiplyScalar(0.25 + 1.6 * pw);
    const sinceModel = (performance.now() - modelKick.current) / 1000;
    const modelPulse = sinceModel < 2.4 ? (1 - sinceModel / 2.4) * (0.5 + 0.5 * Math.sin(sinceModel * 14)) : 0;
    mats.head.emissive.set(modelPulse > 0.05 ? '#4f7dff' : '#2fe0b4');
    mats.head.emissiveIntensity = 0.25 * pw + modelPulse * 3;
    mats.paddle.emissiveIntensity = 0.3 + 0.8 * pw;
    const scanNow = tokens.some((t) => { const p = (Date.now() - t.spawnedAt) / travelMs; return p > SCAN[0] && p < SCAN[1]; });
    scanning.current += ((scanNow ? 1 : 0) - scanning.current) * (1 - Math.exp(-dt * 10));
    if (alertLight.current) alertLight.current.intensity = alert ? (alert === 'critical' ? 40 : 25) * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 4)) : 0;
    if (keyLight.current) keyLight.current.intensity = 1.2 + 1.4 * Math.min(1, pw);
  });

  const bg = tv ? '#07130f' : '#e7f1eb';
  return <>
    <color attach="background" args={[bg]} />
    <fog attach="fog" args={[bg, 22, 46]} />
    <hemisphereLight args={[tv ? '#9fd8c4' : '#ffffff', tv ? '#0c1a15' : '#cfe3d6', tv ? 0.5 : 1.1]} />
    <directionalLight ref={keyLight} position={[-6, 12, 7]} intensity={2.4} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-14} shadow-camera-right={14} shadow-camera-top={9} shadow-camera-bottom={-9} />
    <pointLight ref={alertLight} position={[0, 5, 0]} distance={26} color={alert === 'critical' ? '#ff3b2f' : '#ff9b2f'} intensity={0} />

    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[90, 90]} />
      <meshStandardMaterial color={tv ? '#0b1914' : '#eef5f0'} roughness={0.9} />
    </mesh>
    <Grid position={[0, 0.002, 0]} args={[60, 60]} cellSize={1} cellThickness={0.5} sectionSize={5} sectionThickness={1}
      cellColor={tv ? '#1d3a30' : '#d3e4d9'} sectionColor={tv ? '#2c6b55' : '#b7d6c3'} fadeDistance={34} fadeStrength={1.4} infiniteGrid />

    <Belt from={new THREE.Vector3(START.x - 0.6, 0, 0)} to={new THREE.Vector3(FORK.x + 0.4, 0, 0)} width={1.4} strip={mats.green} speed={speed} />
    <Belt from={new THREE.Vector3(FORK.x, 0, -0.1)} to={END.good.clone().add(dirOf('good').multiplyScalar(0.35))} width={1.3} strip={mats.green} speed={speed} />
    <Belt from={new THREE.Vector3(FORK.x, 0, 0.1)} to={END.defect.clone().add(dirOf('defect').multiplyScalar(0.35))} width={1.3} strip={mats.orange} speed={speed} />
    <Gantry beam={mats.teal} cone={mats.cone} head={mats.head} scanning={scanning} />
    <Diverter paddleKey={paddleKey} mat={mats.paddle} />
    <Crate kind="good" rim={mats.green} />
    <Crate kind="defect" rim={mats.orange} />

    <Tree x={-9} z={-6} fruit="orange" />
    <Tree x={-3} z={-7.5} s={1.2} fruit="apple" />
    <Tree x={3.5} z={-8} fruit="orange" />
    <Tree x={11.5} z={-7} s={1.1} fruit="apple" />
    <Tree x={-12} z={5} s={0.9} fruit="apple" />
    <Tree x={-14} z={1.5} s={0.95} fruit="orange" />

    {tokens.map((t) => <MovingFruit key={t.id} token={t} travelMs={travelMs} pileTarget={targets.current.get(t.id) ?? CRATE[t.kind]} />)}
    {(['good', 'defect'] as const).flatMap((kind) => pile[kind].map((p) => <group key={`pile-${p.id}`} position={p.pos}>
      <FruitBody fruit={p.fruit} defectType={p.defectType} seed={p.id} />
    </group>))}
    {bursts.map((b) => <Burst key={b.key} at={b.at} color={b.color} onDone={() => setBursts((cur) => cur.filter((x) => x.key !== b.key))} />)}
  </>;
}

export default function LiveScene3D(props: Props) {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return <Canvas className="lv3d-canvas" shadows dpr={[1, 1.75]} camera={{ position: [0.5, 7.4, 12.6], fov: 36 }} gl={{ antialias: true, powerPreference: 'high-performance' }}>
    <Line {...props} />
    <OrbitControls target={[0.3, 0.4, 0.4]} enablePan={false} enableZoom={props.tv} enableDamping minDistance={8} maxDistance={26}
      minPolarAngle={0.35} maxPolarAngle={1.25} />
    {!reduced && <EffectComposer>
      <Bloom mipmapBlur luminanceThreshold={0.85} luminanceSmoothing={0.2} intensity={props.tv ? 1.1 : 0.7} />
      <Vignette eskil={false} offset={0.25} darkness={props.tv ? 0.7 : 0.35} />
    </EffectComposer>}
  </Canvas>;
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
