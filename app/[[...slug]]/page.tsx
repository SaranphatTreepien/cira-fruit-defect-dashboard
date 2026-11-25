'use client';

import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  Activity, AlertTriangle, BarChart3, Bell, Bot, Boxes, Camera, Check, ChevronRight, CloudOff,
  Download, FileText, Gauge, History, Info, Leaf, LineChart, LogIn, LogOut, MessageCircle, MoreHorizontal,
  PackageCheck, Power, Radio, RefreshCcw, Search, Save, Settings2, SlidersHorizontal,
  Sparkles, Square, Tag, Timer, Trash2, TrendingDown, TrendingUp, UserCircle2, Users, Wifi, WifiOff,
  Zap, CircleDot, Monitor, X, Volume2, VolumeX, PanelLeftClose, PanelLeftOpen, Maximize2, Minimize2, Repeat,
} from 'lucide-react';
// 3D sorting scene: loaded only when the 3D view is shown (three.js is large).
const LiveScene3D = dynamic(() => import('@/components/LiveScene3D'), { ssr: false, loading: () => <div className="lv3d-loading">กำลังโหลดฉาก 3D...</div> });
const hasWebGL = () => {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
};
type AuthUser = { id: number; email: string; name: string; role: 'admin' | 'viewer' };
const AuthContext = createContext<{ user: AuthUser | null; logout: () => void }>({ user: null, logout: () => undefined });
const useAuth = () => useContext(AuthContext);
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
const roleLabel = (role: AuthUser['role']) => role === 'admin' ? 'Admin' : 'Viewer';

type ShellStatus = { state: string | null; deviceId: string | null; epm: number | null; model: string | null; mqtt: string; db: string; internet: string };
const emptyShellStatus: ShellStatus = { state: null, deviceId: null, epm: null, model: null, mqtt: 'unknown', db: 'unknown', internet: 'unknown' };
// Pages that already poll /api/live (Live) report into the shell instead of the shell polling too.
const ShellContext = createContext<{ status: ShellStatus; report: (patch: Partial<ShellStatus>) => void }>({ status: emptyShellStatus, report: () => undefined });

// Polls real machine + health status once for the whole shell (Topbar / Sidebar).
// Live and System Status poll the same data faster themselves and report() it, so the shell skips them.
function useShellStatus(skipLive: boolean, skipHealth: boolean) {
  const [status, setStatus] = useState<ShellStatus>(emptyShellStatus);
  const skipRef = useRef(skipLive);
  skipRef.current = skipLive;
  const skipHealthRef = useRef(skipHealth);
  skipHealthRef.current = skipHealth;
  useEffect(() => {
    let active = true;
    const loadLive = async () => {
      if (skipRef.current) return;
      try {
        const response = await fetch('/api/live?lite=1', { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const payload = await response.json() as { device: { device_id: string; state: string | null } | null; events_last_minute: number; recent: { model_version: string | null }[] };
        if (active) setStatus((current) => ({ ...current, state: payload.device?.state ?? 'offline', deviceId: payload.device?.device_id ?? null, epm: payload.events_last_minute, model: payload.recent[0]?.model_version ?? null }));
      } catch { if (active) setStatus((current) => ({ ...current, state: null, epm: null })); }
    };
    const loadHealth = async () => {
      if (skipHealthRef.current) return;
      try {
        const response = await fetch('/api/system-health', { cache: 'no-store' });
        const payload = await response.json() as { mqtt: string; db: string; internet: string };
        if (active) setStatus((current) => ({ ...current, mqtt: payload.mqtt, db: payload.db, internet: payload.internet }));
      } catch { if (active) setStatus((current) => ({ ...current, mqtt: 'unknown', db: 'unknown', internet: 'unknown' })); }
    };
    void loadLive(); void loadHealth();
    const a = window.setInterval(() => { if (!document.hidden) void loadLive(); }, 5000);
    const b = window.setInterval(() => { if (!document.hidden) void loadHealth(); }, 8000);
    return () => { active = false; window.clearInterval(a); window.clearInterval(b); };
  }, []);
  const report = useMemo(() => (patch: Partial<ShellStatus>) => setStatus((current) => ({ ...current, ...patch })), []);
  return { status, report };
}
const shellPlaying = (state: string | null) => state === 'playing' || state === 'started';

type PageKey = 'simulate' | 'logs' | 'runs' | 'alerts' | 'system' | 'profiles' | 'users' | 'myteam' | 'login';

const navItems: { href: string; key: PageKey; label: string; sub: string; icon: typeof Activity; adminOnly?: boolean }[] = [
  { href: '/simulate', key: 'simulate', label: 'Live', sub: 'Real-time', icon: Activity },
  { href: '/logs', key: 'logs', label: 'Dashboard Log', sub: 'Traceability', icon: History },
  { href: '/runs', key: 'runs', label: 'Runs & Models', sub: 'Shifts', icon: Timer },
  { href: '/alerts', key: 'alerts', label: 'Alert & Reports', sub: 'Operations', icon: Bell },
  { href: '/system', key: 'system', label: 'System Status', sub: 'Device health', icon: Wifi },
  { href: '/profiles', key: 'profiles', label: 'Fruit Profiles', sub: 'Reference', icon: Tag },
  { href: '/users', key: 'users', label: 'Users', sub: 'Access control', icon: Users, adminOnly: true },
  { href: '/myteam', key: 'myteam', label: 'My Team', sub: 'Project members', icon: UserCircle2 },
];

const pageMeta: Record<PageKey, { eyebrow: string; title: string; subtitle: string }> = {
  simulate: { eyebrow: '01 • LIVE', title: 'Live', subtitle: 'สถานะเครื่องและผลคัดแยกแบบ real-time จากฐานข้อมูล' },
  logs: { eyebrow: '02 • TRACEABILITY', title: 'Dashboard Log', subtitle: 'ย้อนดูเหตุการณ์ทุกผลผลิตตั้งแต่ Camera, NIR จนถึงจุดคัดแยก' },
  runs: { eyebrow: '03 • SHIFTS', title: 'Runs & Models', subtitle: 'รอบการทำงานตัดอัตโนมัติจากสถานะเครื่อง และเทียบผลของแต่ละโมเดล' },
  alerts: { eyebrow: '04 • OPERATIONS', title: 'Alert, รายงาน + AI', subtitle: 'ติดตามเหตุการณ์ รายงานรายวัน และให้ AI สรุป (เมนูเดียวกับ Telegram bot)' },
  system: { eyebrow: '05 • CONNECTIVITY', title: 'System Status', subtitle: 'สุขภาพของอุปกรณ์และระบบรับข้อมูล รวมถึงข้อมูลที่ถูกปฏิเสธ' },
  profiles: { eyebrow: '06 • REFERENCE', title: 'Fruit Profiles', subtitle: 'ชนิดผลไม้ ตำหนิ และโมเดลที่ระบบรู้จัก (อ่านอย่างเดียว · ค่าตรวจจับตั้งใน CIRA CORE)' },
  users: { eyebrow: '07 • ACCESS', title: 'Users & Roles', subtitle: 'จัดการบัญชีผู้ใช้และสิทธิ์ Admin / Viewer' },
  myteam: { eyebrow: '08 • PROJECT TEAM', title: 'My Team', subtitle: 'ทีมผู้อยู่เบื้องหลัง Fruit Defect Detection Engine by CIRA CORE' },
  login: { eyebrow: 'CIRA CORE • SECURE ACCESS', title: 'เข้าสู่ระบบ', subtitle: 'เข้าสู่ Control Room เพื่อดูสถานะไลน์คัดแยก' },
};

function Logo({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><img className="brand-mark" src="/images/cira-core-logo.png" alt="CIRA CORE logo" />{!compact && <div className="brand-copy"><div className="brand-name">Fruit Defect Detection</div><span className="brand-sub">ENGINE BY CIRA CORE</span></div>}</div>;
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (value: boolean) => void; label?: string; hint?: string }) {
  return <div className="switch-row"><div className="switch-copy">{label && <strong>{label}</strong>}{hint && <span>{hint}</span>}</div><button type="button" aria-label={label || 'toggle'} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}><span className="switch-knob" /></button></div>;
}

function StatusPill({ tone = 'good', children }: { tone?: 'good' | 'warn' | 'bad' | 'neutral'; children: React.ReactNode }) {
  return <span className={`tag ${tone}`}>{tone !== 'neutral' && <span className={`dot ${tone}`} style={{ width: 5, height: 5, marginRight: 5 }} />}{children}</span>;
}

function PageHeader({ page, actions }: { page: PageKey; actions?: React.ReactNode }) {
  const meta = pageMeta[page];
  return <div className="page-heading"><div><div className="eyebrow">{meta.eyebrow}</div><h1 className="page-title">{meta.title}</h1><p className="page-subtitle">{meta.subtitle}</p></div>{actions && <div className="header-actions">{actions}</div>}</div>;
}

function Sidebar({ current, mobileOpen, onClose, status }: { current: PageKey; mobileOpen: boolean; onClose: () => void; status: ShellStatus }) {
  const lineTone = status.state == null ? 'neutral' : shellPlaying(status.state) ? 'good' : 'bad';
  const linkTone = status.mqtt === 'online' && status.db === 'online' ? 'good' : status.mqtt === 'unknown' && status.db === 'unknown' ? 'neutral' : 'bad';
  const { user } = useAuth();
  return <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}><div style={{ display: 'flex', alignItems: 'center' }}><Logo /><button className="mobile-close" aria-label="ปิดเมนู" onClick={onClose}><X size={17} /></button></div><div className="nav-label">Workspace</div><nav className="nav-list">{navItems.filter((item) => !item.adminOnly || user?.role === 'admin').map(({ href, key, label, icon: Icon }) => <a key={key} href={href} onClick={onClose} aria-label={label} title={label} className={`nav-item ${current === key ? 'active' : ''}`}><Icon className="nav-icon" /><span>{label}</span></a>)}</nav><div className="sidebar-bottom"><div className="system-mini"><div className="system-mini-row"><span><i className={`dot ${lineTone}`} />{status.deviceId ?? 'Camera'}</span><strong>{status.state == null ? 'ไม่ทราบ' : shellPlaying(status.state) ? 'ทำงาน' : 'หยุด'}</strong></div><div className="system-mini-row"><span><i className={`dot ${linkTone}`} />MQTT / DB</span><strong>{status.mqtt === 'online' ? 'on' : status.mqtt === 'offline' ? 'off' : '?'} / {status.db === 'online' ? 'on' : status.db === 'offline' ? 'off' : '?'}</strong></div></div></div></aside>;
}

function Topbar({ status, onOpenMenu, unacked, sound, onToggleSound, collapsed, onToggleSidebar }: { status: ShellStatus; onOpenMenu: () => void; unacked: number; sound: boolean; onToggleSound: () => void; collapsed: boolean; onToggleSidebar: () => void }) {
  const running = shellPlaying(status.state);
  const router = useRouter();
  const { user, logout } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);
  return <header className="topbar"><div className="topbar-left"><button className="mobile-menu" aria-label="เปิดเมนู" onClick={onOpenMenu}><SlidersHorizontal size={16} /></button><button type="button" className="topbar-icon sidebar-toggle" onClick={onToggleSidebar} aria-pressed={collapsed} aria-label={collapsed ? 'ขยายแถบเมนู' : 'ย่อแถบเมนู'} title={collapsed ? 'ขยายแถบเมนู' : 'ย่อแถบเมนู'}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button><span className={`status-chip ${running ? 'running' : ''}`}><i className={`dot ${running ? 'good' : 'neutral'}`} />{status.state == null ? 'ไม่ทราบสถานะเครื่อง' : running ? 'เครื่องกำลังทำงาน' : 'เครื่องหยุดอยู่'}</span>{status.model && <span className="status-chip" title="model_version ของ event ล่าสุด">Model · {status.model}</span>}</div><div className="topbar-right"><div className="status-cluster"><Activity size={14} color="#1aa55c" /><span style={{ color: '#6e8579', fontSize: 11 }}>Throughput <strong style={{ color: '#10352a' }}>{status.epm == null ? '-' : `${status.epm} ผล/นาที`}</strong></span></div><div className="topbar-separator" /><button type="button" className="topbar-icon" onClick={onToggleSound} aria-pressed={sound} title={sound ? 'ปิดเสียง / desktop notification' : 'เปิดเสียง + desktop notification เมื่อมี alert'}>{sound ? <Volume2 size={16} /> : <VolumeX size={16} />}</button><a href="/alerts" className="topbar-icon bell" title={`${unacked} alert ยังไม่รับทราบ`} aria-label={`Alert ยังไม่รับทราบ ${unacked} รายการ`}><Bell size={16} />{unacked > 0 && <span className="bell-badge">{unacked > 99 ? '99+' : unacked}</span>}</a><div className="topbar-separator" /><div className="profile-menu"><button type="button" className="user-pill profile-trigger" aria-expanded={profileOpen} onClick={() => setProfileOpen((open) => !open)}><div className="avatar">{user ? initialsOf(user.name) : '?'}</div><div className="user-copy"><strong>{user?.name ?? '-'}</strong><span>{user ? roleLabel(user.role) : ''}</span></div><ChevronRight className={profileOpen ? 'profile-chevron open' : 'profile-chevron'} size={15} /></button>{profileOpen && <div className="profile-dropdown"><div className="profile-dropdown-head"><strong>{user?.name ?? '-'}</strong><span>{user?.email ?? ''} · {user ? roleLabel(user.role) : ''}</span></div>{user?.role === 'admin' && <button type="button" onClick={() => { setProfileOpen(false); router.push('/users'); }}><UserCircle2 size={15} />จัดการผู้ใช้</button>}<button type="button" className="profile-logout" onClick={() => { setProfileOpen(false); logout(); }}><LogOut size={15} />Logout</button></div>}</div></div></header>;
}


const AlertFeedContext = createContext<FeedAlert[]>([]);
type FeedAlert = { id: number; ts: string | null; rule: string; level: 'info' | 'warning' | 'critical'; device_id: string | null; title: string; detail: string | null; resolved_at: string | null };

// Polls /api/alerts/feed on every page: pop-up toasts, optional sound + desktop notification.
function useAlertFeed() {
  const [unacked, setUnacked] = useState(0);
  const [toasts, setToasts] = useState<FeedAlert[]>([]);
  const [sound, setSound] = useState(false);
  const lastId = useRef<number | null>(null);
  const soundRef = useRef(false);

  useEffect(() => { const stored = window.localStorage.getItem('cira-core-alert-sound') === 'true'; setSound(stored); soundRef.current = stored; }, []);
  const toggleSound = () => {
    const next = !soundRef.current;
    soundRef.current = next; setSound(next); window.localStorage.setItem('cira-core-alert-sound', String(next));
    if (next && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    if (next) beep('info');
  };
  const dismiss = (id: number) => setToasts((current) => current.filter((t) => t.id !== id));

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const query = lastId.current == null ? '' : `?after=${lastId.current}`;
        const response = await fetch(`/api/alerts/feed${query}`, { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json() as { latest_id: number; unacked: number; items: FeedAlert[] };
        if (!active) return;
        setUnacked(payload.unacked);
        if (lastId.current != null && payload.items.length) {
          setToasts((current) => [...current, ...payload.items].slice(-5));
          payload.items.forEach((item) => {
            window.setTimeout(() => dismiss(item.id), item.level === 'info' ? 8000 : 20000);
            if (soundRef.current) {
              beep(item.level);
              if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
                new Notification(`CIRA CORE · ${item.title}`, { body: item.detail ?? '', tag: `cira-alert-${item.id}` });
              }
            }
          });
        }
        lastId.current = Math.max(lastId.current ?? 0, payload.latest_id, ...payload.items.map((i) => i.id));
      } catch { /* feed is best-effort; the Alerts page shows errors */ }
    };
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 4000);
    return () => { active = false; window.clearInterval(id); };
  }, []);
  return { unacked, toasts, dismiss, sound, toggleSound };
}

function beep(level: FeedAlert['level']) {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const tones = level === 'critical' ? [880, 660, 880] : level === 'warning' ? [740, 560] : [620];
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      osc.connect(gain).connect(ctx.destination); osc.start(ctx.currentTime + i * 0.18); osc.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
    window.setTimeout(() => { void ctx.close(); }, 1200);
  } catch { /* audio not available */ }
}

function AlertToasts({ toasts, dismiss }: { toasts: FeedAlert[]; dismiss: (id: number) => void }) {
  const router = useRouter();
  if (!toasts.length) return null;
  return <div className="alert-toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`alert-toast ${t.level}`}>
    <div className="alert-toast-icon">{t.level === 'info' ? <Info size={15} /> : <AlertTriangle size={15} />}</div>
    <button type="button" className="alert-toast-body" onClick={() => { dismiss(t.id); router.push('/alerts'); }}>
      <strong>{t.title}</strong>{t.detail && <span>{t.detail}</span>}
      <em>{t.ts ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t.ts)) : ''}{t.level !== 'info' && t.resolved_at ? ' · หายแล้ว' : ''}</em>
    </button>
    <button type="button" className="alert-toast-close" aria-label="ปิด" onClick={() => dismiss(t.id)}><X size={13} /></button>
  </div>)}</div>;
}

function Shell({ current, children, mobileOpen, setMobileOpen }: { current: PageKey; children: React.ReactNode; mobileOpen: boolean; setMobileOpen: (value: boolean) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(window.localStorage.getItem('cira-core-sidebar') === 'collapsed'); }, []);
  const toggleSidebar = () => setCollapsed((value) => { window.localStorage.setItem('cira-core-sidebar', value ? 'open' : 'collapsed'); return !value; });
  const shell = useShellStatus(current === 'simulate', current === 'system');
  const status = shell.status;
  const feed = useAlertFeed();
  return <ShellContext.Provider value={shell}><div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}><Sidebar current={current} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} status={status} /><div className="main-shell"><Topbar status={status} onOpenMenu={() => setMobileOpen(true)} unacked={feed.unacked} sound={feed.sound} onToggleSound={feed.toggleSound} collapsed={collapsed} onToggleSidebar={toggleSidebar} /><AlertToasts toasts={feed.toasts} dismiss={feed.dismiss} /><AlertFeedContext.Provider value={feed.toasts}>{children}</AlertFeedContext.Provider></div></div></ShellContext.Provider>;
}

function MetricCard({ label, value, foot, tone, icon }: { label: string; value: string | number; foot?: string; tone?: 'green' | 'orange'; icon?: React.ReactNode }) {
  return <div className={`card metric ${tone || ''}`}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span className="metric-label">{label}</span>{icon && <span style={{ color: tone === 'orange' ? '#bf7438' : '#5c9670' }}>{icon}</span>}</div><div className="metric-value">{value}</div>{foot && <div className="metric-foot up">{foot}</div>}</div>;
}

function SectionHeader({ title, kicker, action }: { title: string; kicker?: string; action?: React.ReactNode }) {
  return <div className="card-header"><div><h2 className="card-title">{title}</h2>{kicker && <div className="card-kicker">{kicker}</div>}</div>{action}</div>;
}

type LiveEvent = { event_id: string; ts: string | null; fruit_type: string | null; external_result: string | null; defect_type: string | null; confidence: number | null; track_id: number | null; camera_view: string | null; model_version: string | null; created_at: string | null };
type LiveData = {
  now: string; window_min: number;
  device: { device_id: string; source_type: string | null; state: string | null; last_seen: string | null; age_sec: number | null } | null;
  last_event_at: string | null;
  totals: { total: number; good: number; defect: number };
  by_fruit: { fruit_type: string; total: number; good: number; defect: number }[];
  by_defect: { defect_type: string; n: number }[];
  events_last_minute: number;
  recent: LiveEvent[];
  ingest_latency: { avg_s: number | null; max_s: number | null; n: number };
  batch_config: { size: number; flush_sec: number };
  batches: LiveBatch[];
  // events written after ?since= (one row per fruit, oldest first); null when since was not sent
  new_events: LiveEvent[] | null;
  // 5-second buckets (epoch seconds) of the last 5 minutes
  spark: { t: number; n: number; defect: number }[];
};
// One DB write by mqtt_to_db.py: all its rows share created_at.
type LiveBatch = { created_at: string | null; n: number; defect: number; first_ts: string | null; last_ts: string | null };
type LiveHealth = { db: string; mqtt: string; internet: string };
// One fruit on the belt (or a bundle of same-result fruit when the line is faster than the belt can show).
// Each event is replayed at its CORE timestamp + a playback offset, so fruit flow one by one instead of
// arriving as one pile per DB batch.
type LiveToken = { id: string; batch: string; kind: 'good' | 'defect'; fruit: string | null; count: number; conf: number | null; defectType: string | null; track: number | null; model: string | null; ts: string | null; modelSwitch: { from: string; to: string } | null; spawnedAt: number };
type LivePending = LiveToken & { at: number };

const liveWindows = [{ v: 5, label: '5 นาที' }, { v: 15, label: '15 นาที' }, { v: 60, label: '1 ชม.' }, { v: 480, label: '8 ชม.' }, { v: 1440, label: '24 ชม.' }];
const fruitEmoji: Record<string, string> = { orange: '🍊', apple: '🍎', banana: '🍌' };
const LIVE_MIN_GAP_MS = 170; // between two fruit on the belt
const LIVE_BACKLOG_MERGE = 10; // more due fruit than this: bundle them so the belt keeps up
const LIVE_PLAYBACK_MARGIN_MS = 350;
const LIVE_TRAVEL_MS = 3400; // 2D: must match .lv-token animation-duration in globals.css
const LIVE_TRAVEL_3D_MS = 6000; // 3D: longer belts, slower fruit
const liveTime = (value: string | null) => value ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '-';
const liveTimeTenth = (value: string | null) => {
  if (!value) return '-';
  const date = new Date(value);
  return `${liveTime(value)}.${Math.floor(date.getMilliseconds() / 100)}`;
};
const liveConf = (value: number | null) => value == null ? '-' : `${(value <= 1 ? value * 100 : value).toFixed(0)}%`;
const liveEmoji = (fruit: string | null) => (fruit && fruitEmoji[fruit]) || '🍈';
const liveKind = (event: LiveEvent): 'good' | 'defect' => event.external_result === 'defect' ? 'defect' : 'good';

const stripAt = ({ at: _at, ...token }: LivePending): LiveToken => token;

// Optional scene sounds (off by default, remembered per browser): a soft blip per good fruit, a low thud per
// defect, a chime on model switch. Throttled so a busy line does not turn into noise.
function useLiveSfx() {
  const [on, setOn] = useState(false);
  const onRef = useRef(false);
  const ctx = useRef<AudioContext | null>(null);
  const last = useRef(0);
  useEffect(() => {
    try { const stored = window.localStorage.getItem('cira-live-sfx') === 'true'; setOn(stored); onRef.current = stored; } catch { /* storage blocked */ }
  }, []);
  const audio = () => {
    try {
      if (!ctx.current) ctx.current = new AudioContext();
      if (ctx.current.state === 'suspended') void ctx.current.resume();
      return ctx.current;
    } catch { return null; }
  };
  const toggle = () => {
    const next = !onRef.current;
    onRef.current = next; setOn(next);
    try { window.localStorage.setItem('cira-live-sfx', String(next)); } catch { /* storage blocked */ }
    if (next) audio();
  };
  const play = (kind: 'good' | 'defect' | 'switch') => {
    if (!onRef.current || document.hidden) return;
    const now = performance.now();
    if (kind !== 'switch' && now - last.current < 90) return;
    last.current = now;
    const c = audio();
    if (!c) return;
    const tones: [number, number][] = kind === 'good' ? [[880, 0.07]] : kind === 'defect' ? [[220, 0.12], [160, 0.12]] : [[523, 0.09], [659, 0.09], [784, 0.16]];
    let t = c.currentTime;
    tones.forEach(([freq, dur]) => {
      const osc = c.createOscillator(); const gain = c.createGain();
      osc.type = kind === 'defect' ? 'triangle' : 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(kind === 'good' ? 0.06 : 0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(c.destination); osc.start(t); osc.stop(t + dur + 0.02);
      t += dur;
    });
  };
  return { on, toggle, play };
}

function SimulateView() {
  const [windowMin, setWindowMin] = useState(15);
  const [live, setLive] = useState<LiveData | null>(null);
  const shell = useContext(ShellContext);
  const health: LiveHealth = { db: shell.status.db, mqtt: shell.status.mqtt, internet: shell.status.internet };
  const [error, setError] = useState('');
  const [tokens, setTokens] = useState<LiveToken[]>([]);
  // Fruit waiting for their playback time. A ref (not state) so the 80 ms tick does not re-render;
  // queueVer bumps when it changes so the in-flight counts stay right.
  const pending = useRef<LivePending[]>([]);
  const queuedIds = useRef(new Set<string>());
  const [, setQueueVer] = useState(0);
  const playbackOffset = useRef<number | null>(null);
  const [playbackLag, setPlaybackLag] = useState<number | null>(null);
  const [hit, setHit] = useState({ good: 0, defect: 0 });
  const [lastIn, setLastIn] = useState<{ good?: string; defect?: string }>({});
  const [bursts, setBursts] = useState<{ key: string; kind: 'good' | 'defect'; count: number }[]>([]);
  const [paddleKey, setPaddleKey] = useState(0);
  const [streak, setStreak] = useState({ now: 0, best: 0 });
  const [modelBanner, setModelBanner] = useState<{ key: number; from: string; to: string } | null>(null);
  const lastModel = useRef<string | null>(null);
  const [winding, setWinding] = useState(false);
  const [powerKey, setPowerKey] = useState(0);
  const wasPlaying = useRef<boolean | null>(null);
  const [tv, setTv] = useState(false);
  // 2D (image + CSS) or 3D (three.js) scene; 3D by default when WebGL works, choice remembered per browser.
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const travel = useRef(LIVE_TRAVEL_MS);
  travel.current = view === '3d' ? LIVE_TRAVEL_3D_MS : LIVE_TRAVEL_MS;
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem('cira-live-view'); } catch { /* storage blocked */ }
    if (stored !== '2d' && hasWebGL()) setView('3d');
  }, []);
  const toggleView = () => setView((v) => {
    const next = v === '3d' ? '2d' : '3d';
    try { window.localStorage.setItem('cira-live-view', next); } catch { /* storage blocked */ }
    return next;
  });
  const stageCardRef = useRef<HTMLDivElement | null>(null);
  const sfx = useLiveSfx();
  const alertFeed = useContext(AlertFeedContext);
  // created_at (ms) of the newest batch already on screen; null until the first load (no replay of old batches)
  const seenBatch = useRef<number | null>(null);
  // Measured when a new event first reaches this browser: CIRA timestamp -> screen, DB write -> screen.
  const [arrival, setArrival] = useState<{ e2e: number; dbToScreen: number; at: number } | null>(null);
  const lastSpawn = useRef(0);
  const landTimers = useRef<number[]>([]);
  const later = (ms: number, fn: () => void) => { landTimers.current.push(window.setTimeout(fn, ms)); };
  // Live feed shows one row per DB batch; clicking a row loads that batch's events.
  const [openBatches, setOpenBatches] = useState<Record<string, LiveEvent[] | 'loading' | 'error'>>({});
  const toggleBatch = async (createdAt: string) => {
    if (openBatches[createdAt]) {
      setOpenBatches((current) => { const next = { ...current }; delete next[createdAt]; return next; });
      return;
    }
    setOpenBatches((current) => ({ ...current, [createdAt]: 'loading' }));
    try {
      const response = await fetch(`/api/live/batch?created_at=${encodeURIComponent(createdAt)}`, { cache: 'no-store' });
      const payload = await response.json() as { events?: LiveEvent[]; error?: string };
      if (!response.ok || !payload.events) throw new Error(payload.error);
      const events = payload.events;
      setOpenBatches((current) => (createdAt in current ? { ...current, [createdAt]: events } : current));
    } catch {
      setOpenBatches((current) => (createdAt in current ? { ...current, [createdAt]: 'error' } : current));
    }
  };
  useEffect(() => () => { landTimers.current.forEach((t) => window.clearTimeout(t)); }, []);

  const state = live?.device?.state ?? (live ? 'offline' : null);
  const playing = state === 'playing' || state === 'started';

  // Queue new events for replay: each fruit starts at its CORE timestamp + one playback offset. The offset
  // is the age of the oldest new fruit (so none is already late) and only shrinks slowly, so the flow stays even.
  const enqueue = (events: LiveEvent[], received: number) => {
    const times = events.map((e) => Date.parse(e.ts ?? '')).filter((t) => !Number.isNaN(t));
    if (!times.length) return;
    const want = received - Math.min(...times) + LIVE_PLAYBACK_MARGIN_MS;
    playbackOffset.current = playbackOffset.current == null ? want : Math.max(want, playbackOffset.current - 250);
    const offset = playbackOffset.current;
    setPlaybackLag(offset / 1000);
    const items = events.map((e): LivePending => {
      const ts = Date.parse(e.ts ?? '');
      let modelSwitch: LiveToken['modelSwitch'] = null;
      if (e.model_version) {
        if (lastModel.current && lastModel.current !== e.model_version) modelSwitch = { from: lastModel.current, to: e.model_version };
        lastModel.current = e.model_version;
      }
      return {
        id: e.event_id, batch: e.created_at ?? '', kind: liveKind(e), fruit: e.fruit_type, count: 1, conf: e.confidence,
        defectType: e.defect_type, track: e.track_id, model: e.model_version, ts: e.ts, modelSwitch, spawnedAt: 0,
        at: Number.isNaN(ts) ? received : ts + offset,
      };
    });
    // an event can come back in a later poll (same created_at millisecond): queue each event_id once
    const known = new Set([...pending.current.map((t) => t.id), ...queuedIds.current]);
    const fresh = items.filter((t) => !known.has(t.id));
    fresh.forEach((t) => { queuedIds.current.add(t.id); });
    if (queuedIds.current.size > 2000) queuedIds.current = new Set([...queuedIds.current].slice(-1000));
    pending.current = [...pending.current, ...fresh].sort((a, b) => a.at - b.at);
    setQueueVer((v) => v + 1);
  };

  useEffect(() => {
    let active = true;
    seenBatch.current = null;
    pending.current = []; setQueueVer((v) => v + 1); setTokens([]);
    const load = async () => {
      try {
        const since = seenBatch.current != null ? `&since=${encodeURIComponent(new Date(seenBatch.current).toISOString())}` : '';
        const response = await fetch(`/api/live?window=${windowMin}${since}`, { cache: 'no-store' });
        const payload = await response.json() as LiveData & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'โหลดข้อมูล Live ไม่สำเร็จ');
        if (!active) return;
        const nowState = payload.device?.state ?? 'offline';
        const nowPlaying = nowState === 'playing' || nowState === 'started';
        shell.report({ state: nowState, deviceId: payload.device?.device_id ?? null, epm: payload.events_last_minute, model: payload.recent[0]?.model_version ?? null });
        const batchMs = (b: { created_at: string | null }) => Date.parse(b.created_at ?? '') || 0;
        if (seenBatch.current === null) lastModel.current = payload.recent[0]?.model_version ?? null;
        if (seenBatch.current !== null && nowPlaying && payload.new_events?.length) {
          const received = Date.now();
          const newest = payload.new_events.reduce((a, b) => (batchMs(b) > batchMs(a) ? b : a));
          const newestTs = Math.max(...payload.new_events.map((e) => Date.parse(e.ts ?? '') || 0));
          setArrival({ e2e: (received - newestTs) / 1000, dbToScreen: (received - batchMs(newest)) / 1000, at: received });
          enqueue(payload.new_events, received);
        }
        seenBatch.current = Math.max(seenBatch.current ?? 0, ...payload.batches.map(batchMs), ...(payload.new_events ?? []).map(batchMs));
        setLive(payload);
        setError('');
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'โหลดข้อมูล Live ไม่สำเร็จ');
      }
    };
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => { active = false; window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowMin]);

  // Power down (belt winds down) / power up (light sweep) when the machine state changes.
  const loaded = !!live;
  useEffect(() => {
    if (!loaded) return;
    if (wasPlaying.current === true && !playing) { setWinding(true); later(2600, () => setWinding(false)); }
    if (wasPlaying.current === false && playing) { setWinding(false); setPowerKey((k) => k + 1); }
    wasPlaying.current = playing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, loaded]);

  // Release due fruit onto the belt. When more are due than the belt can show, bundle them (one good + one
  // defect bundle) so the belt catches up without losing count.
  useEffect(() => {
    if (!playing) { if (pending.current.length) { pending.current = []; setQueueVer((v) => v + 1); } return; }
    const id = window.setInterval(() => {
      const now = Date.now();
      const queue = pending.current;
      if (!queue.length || queue[0].at > now || now - lastSpawn.current < LIVE_MIN_GAP_MS) return;
      let due = 0;
      while (due < queue.length && queue[due].at <= now) due++;
      let out: LiveToken[];
      if (due > LIVE_BACKLOG_MERGE) {
        const take = Math.max(2, Math.ceil(due / 6));
        const group = queue.slice(0, take);
        pending.current = queue.slice(take);
        out = (['good', 'defect'] as const).flatMap((kind): LiveToken[] => {
          const part = group.filter((t) => t.kind === kind);
          if (!part.length) return [];
          const fruitCount = new Map<string | null, number>();
          part.forEach((t) => fruitCount.set(t.fruit, (fruitCount.get(t.fruit) ?? 0) + 1));
          const fruit = [...fruitCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
          const first = stripAt(part[part.length - 1]);
          return [{ ...first, id: `${first.id}-x${part.length}`, fruit, count: part.length, defectType: part.length > 1 ? null : first.defectType, modelSwitch: part.find((t) => t.modelSwitch)?.modelSwitch ?? null }];
        });
      } else {
        out = [stripAt(queue[0])];
        pending.current = queue.slice(1);
      }
      lastSpawn.current = now;
      out = out.map((t) => ({ ...t, spawnedAt: now }));
      const travelMs = travel.current;
      setQueueVer((v) => v + 1);
      setTokens((current) => [...current, ...out.filter((t) => !current.some((c) => c.id === t.id))]);
      out.forEach((token) => {
        if (token.modelSwitch) {
          const sw = token.modelSwitch;
          later(travelMs * 0.25, () => { setModelBanner({ key: Date.now(), ...sw }); sfx.play('switch'); });
          later(travelMs * 0.25 + 6000, () => setModelBanner((b) => (b && b.to === sw.to ? null : b)));
        }
        if (token.kind === 'defect') later(travelMs * 0.47, () => setPaddleKey((k) => k + 1));
        // Timer (not animationend) so baskets stay correct even if the tab is hidden.
        later(travelMs, () => land(token));
      });
    }, 80);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const land = (token: LiveToken) => {
    setTokens((current) => current.filter((item) => item.id !== token.id));
    setHit((current) => ({ ...current, [token.kind]: current[token.kind] + token.count }));
    setLastIn((current) => ({ ...current, [token.kind]: `${liveEmoji(token.fruit)} ${token.count > 1 ? `×${token.count}` : `#${token.track ?? '-'}`}` }));
    setStreak((current) => token.kind === 'good' ? { now: current.now + token.count, best: Math.max(current.best, current.now + token.count) } : { ...current, now: 0 });
    sfx.play(token.kind);
    const key = `${token.id}-burst`;
    setBursts((current) => [...current.slice(-5), { key, kind: token.kind, count: token.count }]);
    later(900, () => setBursts((current) => current.filter((b) => b.key !== key)));
  };

  // TV mode: the Sorting card fills the screen (true fullscreen when the browser allows it). ?tv=1 opens in it.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tv') === '1') setTv(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTv(false); };
    const onFs = () => { if (!document.fullscreenElement) setTv(false); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onFs); };
  }, []);
  const toggleTv = () => {
    if (tv) {
      setTv(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } else {
      setTv(true);
      void stageCardRef.current?.requestFullscreen?.().catch(() => undefined);
    }
  };

  const totals = live?.totals ?? { total: 0, good: 0, defect: 0 };
  const inFlight: LiveToken[] = [...pending.current, ...tokens];
  const inFlightCount = (kind: 'good' | 'defect') => inFlight.filter((t) => t.kind === kind).reduce((acc, t) => acc + t.count, 0);
  const shown = {
    good: Math.max(0, totals.good - inFlightCount('good')),
    defect: Math.max(0, totals.defect - inFlightCount('defect')),
  };
  const shownSum = shown.good + shown.defect;
  const sceneAlert = alertFeed.filter((t) => t.level !== 'info' && !t.resolved_at).slice(-1)[0];
  const beltDur = `${Math.max(0.35, 1.4 - (live?.events_last_minute ?? 0) / 250).toFixed(2)}s`;
  const spark = (() => {
    if (!live) return [];
    const end = Math.floor(Date.parse(live.now) / 5000) * 5;
    const map = new Map(live.spark.map((b) => [b.t, b]));
    return Array.from({ length: 60 }, (_, i) => { const t = end - (59 - i) * 5; const b = map.get(t); return { t, n: b?.n ?? 0, defect: b?.defect ?? 0 }; });
  })();
  const sparkMax = Math.max(1, ...spark.map((b) => b.n));
  const defectRate = totals.total ? ((totals.defect / totals.total) * 100).toFixed(1) : '0.0';
  const windowLabel = liveWindows.find((w) => w.v === windowMin)?.label ?? '';
  const tone = (value: string): 'good' | 'bad' | 'neutral' => value === 'online' ? 'good' : value === 'offline' ? 'bad' : 'neutral';
  const label = (value: string) => value === 'online' ? 'Online' : value === 'offline' ? 'Offline' : 'ไม่ทราบ';
  const internetState = health.internet;
  const activeBatches = new Set(tokens.map((t) => t.batch));
  const lastEventAgo = live?.last_event_at ? Math.max(0, Math.round((Date.parse(live.now) - Date.parse(live.last_event_at)) / 1000)) : null;
  const latest = live?.recent[0];
  const ingest = live?.ingest_latency;
  const latencyTone = (sec: number | null | undefined): 'good' | 'warn' | 'bad' | 'neutral' => sec == null ? 'neutral' : sec <= 3 ? 'good' : sec <= 6 ? 'warn' : 'bad';
  const sec = (value: number | null | undefined) => value == null || Number.isNaN(value) ? '-' : `${value.toFixed(1)} วิ`;
  const arrivalAge = arrival && live ? Math.round((Date.parse(live.now) - arrival.at) / 1000) : null;

  // Batches: the writer flushes when BATCH_SIZE rows are buffered ("เต็ม") or FLUSH_SEC has passed ("ครบเวลา").
  const batchCfg = live?.batch_config;
  const batchReason = (n: number) => batchCfg && n >= batchCfg.size ? `เต็ม ${batchCfg.size}` : `ครบเวลา ${batchCfg?.flush_sec ?? '-'} วิ`;
  const batchWait = (b: { created_at: string | null; first_ts: string | null }) =>
    b.created_at && b.first_ts ? Math.max(0, (Date.parse(b.created_at) - Date.parse(b.first_ts)) / 1000) : null;
  // Batches of the last 10 minutes; when the line has been idle longer, rebuild them from the latest events.
  let feedBatches: LiveBatch[] = live?.batches ?? [];
  if (!feedBatches.length && live?.recent.length) {
    const groups = new Map<string, LiveEvent[]>();
    for (const event of live.recent) {
      if (!event.created_at) continue;
      groups.set(event.created_at, [...(groups.get(event.created_at) ?? []), event]);
    }
    feedBatches = [...groups.entries()].map(([createdAt, events]) => {
      const times = events.map((e) => e.ts).filter((t): t is string => !!t).sort();
      return { created_at: createdAt, n: events.length, defect: events.filter((e) => liveKind(e) === 'defect').length, first_ts: times[0] ?? null, last_ts: times[times.length - 1] ?? null };
    });
  }
  const lastBatch = live?.batches[0];
  const lastBatchAgo = lastBatch?.created_at && live ? Math.max(0, Math.round((Date.parse(live.now) - Date.parse(lastBatch.created_at)) / 1000)) : null;
  const batchAvg = live?.batches.length ? live.batches.reduce((acc, b) => acc + b.n, 0) / live.batches.length : null;

  return <div className="live-page">
    <div className="card live-head">
      <div className="live-head-title"><h1>Live</h1><span>ข้อมูลจริงจาก DB · อัปเดตทุก 2 วินาที</span></div>
      <div className="live-head-machine">
        <StatusPill tone={!live ? 'neutral' : playing ? 'good' : state === 'paused' ? 'warn' : 'bad'}>{!live ? 'กำลังโหลด...' : playing ? (state === 'started' ? 'เริ่มทำงาน' : 'กำลังทำงาน') : state === 'paused' ? 'หยุดชั่วคราว' : 'เครื่องหยุด'}</StatusPill>
        <div><strong>{live?.device?.device_id ?? 'ไม่พบอุปกรณ์'}</strong><span>{live?.device?.source_type ?? '-'} · heartbeat {live?.device?.age_sec == null ? '-' : `${live.device.age_sec} วิ`}</span></div>
        <div><strong>{live?.last_event_at ? liveTime(live.last_event_at) : '-'}</strong><span>event ล่าสุด{lastEventAgo != null ? ` · ${lastEventAgo} วิที่แล้ว` : ''}</span></div>
      </div>
      <div className="live-head-health">
        <span>MQTT</span><StatusPill tone={tone(health.mqtt)}>{label(health.mqtt)}</StatusPill>
        <span>DB</span><StatusPill tone={tone(health.db)}>{label(health.db)}</StatusPill>
        <span>Internet</span><StatusPill tone={tone(internetState)}>{label(internetState)}</StatusPill>
      </div>
      <select className="select live-window" aria-label="ช่วงเวลา" value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>{liveWindows.map((w) => <option key={w.v} value={w.v}>ช่วง {w.label}</option>)}</select>
    </div>

    <div className="live-rt">
      <strong>Realtime check</strong>
      <span title="เวลาจาก timestamp ที่ CIRA ใส่ใน event จนเขียนลง DB (เฉลี่ย 50 event ล่าสุด)">CIRA → DB <StatusPill tone={latencyTone(ingest?.avg_s)}>เฉลี่ย {sec(ingest?.avg_s)}</StatusPill> <em>max {sec(ingest?.max_s)}</em></span>
      <span title="เวลาจาก DB เขียนเสร็จจนหน้าเว็บเห็น event (poll ทุก 2 วินาที)">DB → จอ <StatusPill tone={latencyTone(arrival?.dbToScreen)}>{sec(arrival?.dbToScreen)}</StatusPill></span>
      <span title="รวมทั้งหมด: timestamp ของ CIRA จนถึงหน้าเว็บ (ก่อน animation)">รวม CIRA → จอ <StatusPill tone={latencyTone(arrival?.e2e)}>{sec(arrival?.e2e)}</StatusPill></span>
      <span title={`mqtt_to_db.py เขียนลง DB เป็นชุด: ครบ ${batchCfg?.size ?? '-'} แถว (เต็ม) หรือทุก ${batchCfg?.flush_sec ?? '-'} วิ (ครบเวลา) · เฉลี่ยจาก batch ใน 10 นาทีล่าสุด`}>Batch ล่าสุด {lastBatch
        ? <><StatusPill tone="neutral">{lastBatch.n} แถว · {batchReason(lastBatch.n)}</StatusPill><em>{lastBatchAgo} วิที่แล้ว · เฉลี่ย {batchAvg?.toFixed(0)} แถว/batch ({live?.batches.length} batch)</em></>
        : <em>ยังไม่มีใน 10 นาที</em>}</span>
      <em>{arrival ? `วัดจาก event ใหม่ล่าสุด · ${arrivalAge ?? 0} วิที่แล้ว` : 'รอ event ใหม่หลังเปิดหน้าเพื่อวัด DB → จอ'} · poll ทุก 2 วิ · animation +2.4 วิ</em>
    </div>
    {error && <div className="live-banner error">{error}</div>}

    <div className="live-metrics">
      <div className="live-metric"><span>Total · {windowLabel}</span><strong>{totals.total.toLocaleString()}</strong></div>
      <div className="live-metric good"><span>Good</span><strong>{totals.good.toLocaleString()}</strong></div>
      <div className="live-metric bad"><span>Defect</span><strong>{totals.defect.toLocaleString()}</strong></div>
      <div className="live-metric"><span>Defect rate</span><strong>{defectRate}%</strong></div>
      <div className="live-metric"><span>Events / นาที (60 วิล่าสุด)</span><strong>{live?.events_last_minute ?? 0}</strong></div>
    </div>

    <div className="live-main">
      <div className="live-left">
        <div ref={stageCardRef} className={`card live-stage-card ${tv ? 'tv' : ''}`}>
          <div className="live-card-head">
            <h2>Sorting</h2>
            <span>{!live ? 'กำลังโหลด...' : playing ? (inFlight.length ? `● กำลังคัด ${inFlightCount('good') + inFlightCount('defect')} ผล` : '● รอผลไม้') : 'เครื่องหยุด'}{playbackLag != null && playing ? ` · ภาพหน่วง ~${playbackLag.toFixed(1)} วิ` : ''}</span>
            <div className="live-stage-tools">
              <button type="button" className="lv-tool lv-tool-text" title={view === '3d' ? 'สลับเป็นฉาก 2D' : 'สลับเป็นฉาก 3D'} onClick={toggleView}>{view === '3d' ? '2D' : '3D'}</button>
              <button type="button" className="lv-tool" title={sfx.on ? 'ปิดเสียงฉาก' : 'เปิดเสียงฉาก'} aria-pressed={sfx.on} onClick={sfx.toggle}>{sfx.on ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
              <button type="button" className="lv-tool" title={tv ? 'ออกจากจอใหญ่ (Esc)' : 'โหมดจอใหญ่'} onClick={toggleTv}>{tv ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
            </div>
          </div>
          {tv && <div className="lv-tv-kpis">
            <div><span>Total · {windowLabel}</span><strong>{totals.total.toLocaleString()}</strong></div>
            <div className="good"><span>Good</span><strong>{totals.good.toLocaleString()}</strong></div>
            <div className="bad"><span>Defect</span><strong>{totals.defect.toLocaleString()}</strong></div>
            <div><span>Defect rate</span><strong>{defectRate}%</strong></div>
            <div><span>ผล / นาที</span><strong>{live?.events_last_minute ?? 0}</strong></div>
            <div><span>{live?.device?.device_id ?? '-'}</span><strong className="small">{latest?.model_version ?? '-'}</strong></div>
          </div>}
          <div className={`live-stage ${live && !playing ? 'stopped' : ''} ${sceneAlert ? `alerting ${sceneAlert.level}` : ''}`} style={{ ['--belt-dur' as string]: beltDur } as React.CSSProperties}>
            <div className={`lv-scene ${view === '3d' ? 'lv3d' : ''}`}>
              {view === '3d' && <LiveScene3D tokens={tokens} travelMs={LIVE_TRAVEL_3D_MS} playing={playing} paddleKey={paddleKey} modelKey={modelBanner?.key ?? 0} powerKey={powerKey}
                alert={sceneAlert ? (sceneAlert.level === 'critical' ? 'critical' : 'warning') : null} tv={tv}
                seed={{ good: shown.good, defect: shown.defect, fruits: live?.by_fruit.map((f) => f.fruit_type).filter((f) => f !== 'unknown') ?? [] }}
                bins={{ good: shown.good, defect: shown.defect, lastGood: lastIn.good ?? null, lastDefect: lastIn.defect ?? null, hitGood: hit.good, hitDefect: hit.defect }}
                stats={{ epm: live?.events_last_minute ?? 0, defectRate, spark }}
                crates={{ windowLabel, byFruit: live?.by_fruit ?? [], byDefect: live?.by_defect ?? [] }}
                kpi={{ total: totals.total, good: totals.good, defect: totals.defect, defectRate, epm: live?.events_last_minute ?? 0, model: latest?.model_version ?? null,
                  device: live?.device?.device_id ?? null, playing, windowLabel,
                  state: !live ? 'กำลังโหลด' : playing ? 'กำลังทำงาน' : state === 'paused' ? 'หยุดชั่วคราว' : 'เครื่องหยุด' }}
                system={{ db: health.db, mqtt: health.mqtt, internet: health.internet, heartbeatAge: live?.device?.age_sec ?? null, ingestAvg: ingest?.avg_s ?? null,
                  ingestMax: ingest?.max_s ?? null, dbToScreen: arrival?.dbToScreen ?? null, lastEventAgo }}
                control={{ device: live?.device?.device_id ?? null, machine: !live ? 'loading' : playing ? 'running' : state === 'paused' ? 'paused' : 'stopped' }} />}
              {view === '2d' && <>
              <svg className="lv-belts" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polyline className={`lv-belt ${playing ? 'run' : winding ? 'wind' : ''}`} points="0,48 46,48 54,43 60,38 70,35.5 80,33 84,30" />
                <polyline className={`lv-belt bad ${playing ? 'run' : winding ? 'wind' : ''}`} points="46,48 51,55 60,60 70,64.5 80,69 87,70" />
              </svg>
              <div className={`lv-scan ${playing ? 'on' : ''}`} />
              <div className={`lv-gate-ring ${playing ? 'on' : ''}`} />
              <div key={`p${paddleKey}`} className={`lv-paddle ${paddleKey ? 'kick' : ''} ${playing ? 'on' : ''}`}><i /></div>
              </>}
              <div className="lv-hud lv-hud-live"><i className={playing ? 'on' : ''} />{playing ? 'LIVE' : 'STOP'}<span>{live?.device?.device_id ?? '-'} · {live?.events_last_minute ?? 0} ผล/นาที</span></div>
              <div className="lv-hud lv-hud-cam"><Camera size={12} />AI VISION<span>{latest?.model_version ?? '-'} · {latest?.camera_view ?? '-'}</span></div>
              {view === '2d' && <div className="lv-hud lv-hud-fork">AI DECISION</div>}
              {streak.now >= 5 && <div key={`s${Math.floor(streak.now / 10)}`} className={`lv-hud lv-streak ${streak.now >= 25 ? 'hot' : ''}`}>ดีติดกัน <b>{streak.now}</b><span>สูงสุด {streak.best}</span></div>}
              {view === '2d' && tokens.map((token) => {
                const pile = Array.from({ length: Math.min(token.count, 5) }, (_, i) => <span key={i}>{liveEmoji(token.fruit)}</span>);
                const verdict = token.kind === 'defect' ? (token.defectType ?? 'เสีย') : 'ดี';
                return <Fragment key={token.id}>
                  <div className={`lv-flash ${token.kind}`} />
                  <div className={`lv-token ${token.kind} ${token.count > 1 ? 'bundle' : ''}`}>
                    <div className="lv-bbox"><span>{token.fruit ?? '?'} {liveConf(token.conf)}</span></div>
                    <div className="lv-pile">{pile}</div>
                    <div className="lv-id">{token.count > 1 ? `×${token.count}` : `#${token.track ?? '-'}`}</div>
                    <div className="lv-result">{verdict}{token.count > 1 ? ` +${token.count}` : ''}</div>
                  </div>
                </Fragment>;
              })}
              {view === '2d' && <>
              <div className="lv-hud lv-bin good">
                <span>ตะกร้าดี</span><strong key={`g${hit.good}`} className={hit.good ? 'pop' : ''}>{shown.good.toLocaleString()}</strong>
                <div className="lv-fill" title="สัดส่วนของผลที่ลงตะกร้าแล้วในช่วงนี้"><i style={{ width: `${shownSum ? (shown.good / shownSum) * 100 : 0}%` }} /></div>
                <em>{lastIn.good ? `ล่าสุด ${lastIn.good}` : ' '}</em>
              </div>
              <div className="lv-hud lv-bin bad">
                <span>ตะกร้าเสีย</span><strong key={`d${hit.defect}`} className={hit.defect ? 'pop' : ''}>{shown.defect.toLocaleString()}</strong>
                <div className="lv-fill" title="สัดส่วนของผลที่ลงตะกร้าแล้วในช่วงนี้"><i style={{ width: `${shownSum ? (shown.defect / shownSum) * 100 : 0}%` }} /></div>
                <em>{lastIn.defect ? `ล่าสุด ${lastIn.defect}` : ' '}</em>
              </div>
              </>}
              {view === '2d' && bursts.map((burst) => <div key={burst.key} className={`lv-burst ${burst.kind}`}>
                <b>+{burst.count}</b><i className="ring" />
                {Array.from({ length: 9 }, (_, i) => <i key={i} className="spark" style={{ ['--a' as string]: `${i * 40 + 10}deg`, ['--d' as string]: `${3 + (i % 3)}cqw` } as React.CSSProperties} />)}
              </div>)}
              <div className="lv-hud lv-stats">
                <div className="lv-gauge" title={`Defect rate ช่วง ${windowLabel}`}>
                  <svg viewBox="0 0 100 56" aria-hidden="true">
                    <path d="M8 50 A42 42 0 0 1 92 50" className="track" pathLength={100} />
                    <path d="M8 50 A42 42 0 0 1 92 50" className={`val ${Number(defectRate) >= 30 ? 'bad' : Number(defectRate) >= 15 ? 'warn' : 'good'}`} pathLength={100} style={{ strokeDasharray: `${Math.min(100, Number(defectRate))} 100` }} />
                  </svg>
                  <strong>{defectRate}%</strong><span>defect rate</span>
                </div>
                <div className="lv-spark" title="ผลต่อ 5 วินาที · 5 นาทีล่าสุด (เขียว = ดี, ส้ม = เสีย)">
                  <svg viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">
                    {spark.map((b, i) => {
                      const h = (b.n / sparkMax) * 28; const hd = (b.defect / sparkMax) * 28;
                      return <g key={b.t}><rect x={i * 2} y={30 - h} width={1.5} height={h - hd} className="g" /><rect x={i * 2} y={30 - hd} width={1.5} height={hd} className="d" /></g>;
                    })}
                  </svg>
                  <span>5 นาทีล่าสุด · {live?.events_last_minute ?? 0} ผล/นาที</span>
                </div>
              </div>
              {modelBanner && <div key={modelBanner.key} className="lv-model-banner"><Repeat size={14} /><span>MODEL SWITCH</span><b>{modelBanner.from}</b><i>→</i><b>{modelBanner.to}</b></div>}
              {sceneAlert && <div className={`lv-alert-banner ${sceneAlert.level}`}><AlertTriangle size={14} /><b>{sceneAlert.title}</b>{sceneAlert.detail && <span>{sceneAlert.detail}</span>}</div>}
              {powerKey > 0 && <div key={`pw${powerKey}`} className="lv-powerup" />}
              {live && !playing && <div className={`lv-power-off ${winding ? 'winding' : ''}`} />}
              {live && !playing && !winding && <div className="lv-stopped"><Power size={20} /><strong>เครื่องหยุด</strong><span>heartbeat ล่าสุด {live.device?.age_sec == null ? '-' : `${live.device.age_sec} วินาทีที่แล้ว`}</span></div>}
            </div>
          </div>
        </div>
        <div className="card live-fruit-card">
          <div className="live-card-head"><h2>By fruit type</h2><span>ช่วง {windowLabel}</span></div>
          {live?.by_fruit.length ? live.by_fruit.map((row) => <div key={row.fruit_type} className="live-fruit-row">
            <span className="live-fruit-name">{liveEmoji(row.fruit_type)} {row.fruit_type}</span>
            <div className="live-fruit-bar" title={`ดี ${row.good} / เสีย ${row.defect}`}><i className="good" style={{ width: `${row.total ? (row.good / row.total) * 100 : 0}%` }} /><i className="bad" style={{ width: `${row.total ? (row.defect / row.total) * 100 : 0}%` }} /></div>
            <span className="live-fruit-num"><b className="g">{row.good}</b> / <b className="d">{row.defect}</b> · {row.total}</span>
          </div>) : <div className="empty">ไม่มีข้อมูลในช่วงนี้</div>}
          {live && live.by_defect.length > 0 && <div className="live-defects">ประเภทเสีย: {live.by_defect.map((d) => <span key={d.defect_type} className="tag warn">{d.defect_type} {d.n}</span>)}</div>}
        </div>
      </div>

      <div className="card live-feed">
        <div className="live-card-head"><h2>Live feed</h2><span>{feedBatches.length} batch ล่าสุดที่เขียนลง DB · กดเพื่อดู #</span></div>
        <div className="live-feed-list">
          {feedBatches.length ? feedBatches.map((batch, index) => {
            const key = batch.created_at ?? String(index);
            const open = batch.created_at ? openBatches[batch.created_at] : undefined;
            const fresh = index === 0 && batch.created_at && live ? Date.parse(live.now) - Date.parse(batch.created_at) < 4000 : false;
            return <Fragment key={key}>
              <button type="button" className={`live-batch-head ${open ? 'open' : ''} ${fresh ? 'fresh' : ''} ${batch.created_at && activeBatches.has(batch.created_at) ? 'onbelt' : ''}`} aria-expanded={!!open}
                title="ทุก event ใน batch นี้ถูกเขียนลง DB พร้อมกันใน transaction เดียว · กดเพื่อดู event"
                onClick={() => { if (batch.created_at) void toggleBatch(batch.created_at); }}>
                <span className="live-batch-line">
                  <ChevronRight size={13} className="live-batch-chev" />
                  <b>batch {liveTime(batch.created_at)}</b>
                  <span>{batch.n} event</span>
                  <span className="live-batch-split"><i className="g">ดี {batch.n - batch.defect}</i> · <i className="d">เสีย {batch.defect}</i></span>
                </span>
                <span className="live-batch-line sub">
                  <span>CORE {liveTimeTenth(batch.first_ts)}–{liveTimeTenth(batch.last_ts).slice(-4)}</span>
                  <span>รอ {sec(batchWait(batch))}</span>
                  <em className={batchCfg && batch.n >= batchCfg.size ? 'full' : ''}>{batchReason(batch.n)}</em>
                </span>
              </button>
              {open === 'loading' && <div className="live-batch-note">กำลังโหลด...</div>}
              {open === 'error' && <div className="live-batch-note">โหลด event ของ batch นี้ไม่สำเร็จ</div>}
              {Array.isArray(open) && open.map((event) => <div key={event.event_id} className="live-feed-row in-batch">
                <span className="live-feed-time">{liveTime(event.ts)}</span>
                <span className="live-feed-fruit">{liveEmoji(event.fruit_type)} <b>#{event.track_id ?? '-'}</b></span>
                <span className="live-feed-detail">{event.external_result === 'defect' ? (event.defect_type ?? 'defect') : 'ผ่าน'} · {liveConf(event.confidence)}<em>{event.camera_view ?? '-'} · {event.model_version ?? '-'}</em></span>
                <StatusPill tone={liveKind(event) === 'defect' ? 'warn' : 'good'}>{liveKind(event) === 'defect' ? 'เสีย' : 'ดี'}</StatusPill>
              </div>)}
            </Fragment>;
          }) : <div className="empty">ยังไม่มี event</div>}
        </div>
      </div>
    </div>
  </div>;
}

type LogRow = { event_id: string; ts: string | null; fruit_type: string | null; external_result: string | null; defect_type: string | null; nir_result: string | null; confidence: number | null; track_id: number | null; camera_view: string | null; model_version: string | null; model_source: string | null; synced: boolean };
type LogData = {
  range: { from: string; to: string };
  summary: { total: number; good: number; defect: number; avg_conf: number | null; nir_coverage: number | null; first_ts: string | null; last_ts: string | null };
  peak_hour: { hour: string; total: number } | null;
  trend: { bucket: string; points: { t: string | null; good: number; defect: number; total: number }[] };
  by_fruit: { key: string; total: number; defect: number }[];
  by_defect: { key: string; total: number }[];
  by_model: { key: string; total: number; defect: number; avg_conf: number | null }[];
  options: { fruit: string[]; defect: string[]; model: string[]; camera: string[] };
  page: { page: number; page_size: number; total_rows: number; page_count: number };
  rows: LogRow[];
};
type LogPreset = '1h' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';

const LOG_GOOD = '#17804a';
const LOG_DEFECT = '#f0a040';
const logPresets: { v: LogPreset; label: string }[] = [{ v: '1h', label: '1 ชั่วโมงล่าสุด' }, { v: 'today', label: 'วันนี้' }, { v: 'yesterday', label: 'เมื่อวาน' }, { v: '7d', label: '7 วันล่าสุด' }, { v: '30d', label: '30 วันล่าสุด' }, { v: 'custom', label: 'กำหนดเอง' }];
const logDateTime = (value: string | null) => value ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '-';
const logBucketLabel = (value: string | null, bucket: string) => value ? new Intl.DateTimeFormat('th-TH', bucket === '1 วัน' ? { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short' } : { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
const toLocalInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function presetRange(preset: LogPreset, customFrom: string, customTo: string): { from: Date; to: Date } {
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  if (preset === '1h') return { from: new Date(now.getTime() - 3600_000), to: now };
  if (preset === 'today') return { from: startOfDay, to: now };
  if (preset === 'yesterday') return { from: new Date(startOfDay.getTime() - 86400_000), to: startOfDay };
  if (preset === '7d') return { from: new Date(now.getTime() - 7 * 86400_000), to: now };
  if (preset === '30d') return { from: new Date(now.getTime() - 30 * 86400_000), to: now };
  const from = new Date(customFrom); const to = new Date(customTo);
  return { from: Number.isNaN(from.getTime()) ? startOfDay : from, to: Number.isNaN(to.getTime()) ? now : to };
}

function LogsView() {
  const [preset, setPreset] = useState<LogPreset>('today');
  const [customFrom, setCustomFrom] = useState(() => toLocalInput(new Date(Date.now() - 86400_000)));
  const [customTo, setCustomTo] = useState(() => toLocalInput(new Date()));
  const [fruit, setFruit] = useState('all'); const [result, setResult] = useState('all'); const [defect, setDefect] = useState('all');
  const [model, setModel] = useState('all'); const [camera, setCamera] = useState('all');
  const [query, setQuery] = useState(''); const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sort, setSort] = useState<'desc' | 'asc'>('desc');
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(25);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [data, setData] = useState<LogData | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => { const id = window.setTimeout(() => setDebouncedQuery(query.trim()), 300); return () => window.clearTimeout(id); }, [query]);
  useEffect(() => setPage(1), [preset, customFrom, customTo, fruit, result, defect, model, camera, debouncedQuery, pageSize, sort]);

  const buildParams = (withPage: boolean) => {
    const { from, to } = presetRange(preset, customFrom, customTo);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), fruit, result, defect, model, camera, sort });
    if (debouncedQuery) params.set('q', debouncedQuery);
    if (withPage) { params.set('page', String(page)); params.set('page_size', String(pageSize)); }
    return params;
  };
  const paramKey = buildParams(true).toString().replace(/(from|to)=[^&]*&?/g, '');
  const relative = preset === '1h' || preset === 'today' || preset === '7d' || preset === '30d';

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(`/api/logs?${buildParams(true).toString()}`, { cache: 'no-store' });
        const payload = await response.json() as LogData & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'โหลด log ไม่สำเร็จ');
        if (active) { setData(payload); setError(''); }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'โหลด log ไม่สำเร็จ');
      } finally { if (active) setLoading(false); }
    };
    setLoading(true);
    void load();
    const id = autoRefresh && relative ? window.setInterval(() => { if (!document.hidden) void load(); }, 10000) : undefined;
    return () => { active = false; if (id) window.clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramKey, preset, customFrom, customTo, autoRefresh]);

  const exportCsv = () => { window.location.href = `/api/logs/export?${buildParams(false).toString()}`; };
  const clearFilters = () => { setFruit('all'); setResult('all'); setDefect('all'); setModel('all'); setCamera('all'); setQuery(''); };

  const s = data?.summary;
  const defectRate = s?.total ? (s.defect / s.total) * 100 : null;
  const points = data?.trend.points ?? [];
  const maxBar = Math.max(1, ...points.map((p) => p.total));
  const peak = data?.peak_hour;
  const pct = (value: number | null | undefined, digits = 1) => value == null ? '-' : `${value.toFixed(digits)}%`;
  const conf = (value: number | null) => value == null ? '-' : `${(value <= 1 ? value * 100 : value).toFixed(0)}%`;
  const pages = data ? Array.from(new Set([1, page - 1, page, page + 1, data.page.page_count].filter((item) => item >= 1 && item <= data.page.page_count))).sort((a, b) => a - b) : [1];
  const hovered = hover == null ? null : points[hover];
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return <>
    <PageHeader page="logs" actions={<>
      <button type="button" className={`btn btn-ghost ${autoRefresh && relative ? '' : 'muted'}`} onClick={() => setAutoRefresh((v) => !v)} disabled={!relative} title={relative ? 'รีเฟรชทุก 10 วินาที' : 'ช่วงเวลาที่ปิดแล้วไม่ต้องรีเฟรช'}><RefreshCcw size={14} /> {autoRefresh && relative ? 'Auto 10 วิ' : 'Auto ปิด'}</button>
      <button type="button" className="btn btn-primary" onClick={exportCsv} disabled={!s?.total}><Download size={14} /> Export CSV ({(s?.total ?? 0).toLocaleString()})</button>
    </>} />

    <div className="card pad log-filters-card">
      <div className="filters" style={{ marginBottom: 0 }}>
        <select className="select" style={{ width: 150 }} aria-label="ช่วงเวลา" value={preset} onChange={(e) => setPreset(e.target.value as LogPreset)}>{logPresets.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}</select>
        {preset === 'custom' && <><input className="input" style={{ width: 190 }} type="datetime-local" aria-label="ตั้งแต่" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /><span style={{ color: '#8a9d94' }}>ถึง</span><input className="input" style={{ width: 190 }} type="datetime-local" aria-label="ถึง" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></>}
        <select className="select" style={{ width: 120 }} aria-label="ชนิดผลไม้" value={fruit} onChange={(e) => setFruit(e.target.value)}><option value="all">ทุกชนิด</option>{data?.options.fruit.map((v) => <option key={v} value={v}>{liveEmoji(v)} {v}</option>)}</select>
        <select className="select" style={{ width: 110 }} aria-label="ผลภายนอก" value={result} onChange={(e) => setResult(e.target.value)}><option value="all">ทุกผล</option><option value="good">ดี</option><option value="defect">เสีย</option></select>
        <select className="select" style={{ width: 130 }} aria-label="ประเภทตำหนิ" value={defect} onChange={(e) => setDefect(e.target.value)}><option value="all">ทุกตำหนิ</option><option value="none">ไม่ระบุ</option>{data?.options.defect.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        <select className="select" style={{ width: 130 }} aria-label="โมเดล" value={model} onChange={(e) => setModel(e.target.value)}><option value="all">ทุกโมเดล</option>{data?.options.model.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        <select className="select" style={{ width: 110 }} aria-label="กล้อง" value={camera} onChange={(e) => setCamera(e.target.value)}><option value="all">ทุกกล้อง</option>{data?.options.camera.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        <div className="search-wrap" style={{ flex: 1, minWidth: 200 }}><Search className="search-icon" /><input className="input" placeholder="ค้นหา event_id หรือ track_id" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <button type="button" className="btn btn-ghost" onClick={clearFilters}><X size={14} /> ล้าง</button>
      </div>
      <div className="log-range">{data ? `${logDateTime(data.range.from)} – ${logDateTime(data.range.to)}` : '-'}{loading && ' · กำลังโหลด...'}{error && <span style={{ color: '#c4564d' }}> · {error}</span>}</div>
    </div>

    <div className="metric-grid">
      <MetricCard label="Records" value={(s?.total ?? 0).toLocaleString()} foot={s?.last_ts ? `ล่าสุด ${logDateTime(s.last_ts)}` : 'ไม่มีข้อมูล'} icon={<Boxes size={15} />} />
      <MetricCard label="Good" value={(s?.good ?? 0).toLocaleString()} foot={s?.total ? `${pct((s.good / s.total) * 100)} pass rate` : undefined} tone="green" icon={<Check size={15} />} />
      <MetricCard label="Defect" value={(s?.defect ?? 0).toLocaleString()} foot={defectRate == null ? undefined : `${pct(defectRate)} defect rate`} tone="orange" icon={<AlertTriangle size={15} />} />
      <MetricCard label="Avg confidence" value={pct(s?.avg_conf)} foot={data?.by_model.length ? `${data.by_model.length} โมเดล` : undefined} icon={<Gauge size={15} />} />
      <MetricCard label="NIR coverage" value={s?.nir_coverage ? pct(s.nir_coverage) : 'ยังไม่มี'} foot={s?.nir_coverage ? 'มีผล NIR จริง' : 'nir_result ว่าง / not_supported'} icon={<Radio size={15} />} />
      <MetricCard label="Peak hour" value={peak ? `${peak.hour.slice(11, 16)}` : '-'} foot={peak ? `${peak.hour.slice(0, 10)} · ${peak.total.toLocaleString()} ผล` : 'ไม่มีข้อมูล'} icon={<Timer size={15} />} />
    </div>

    <div className="chart-row" style={{ marginTop: 0, marginBottom: 18 }}>
      <div className="card pad">
        <SectionHeader title="Trend ตามเวลา" kicker={`จำนวนผลไม้ต่อ ${data?.trend.bucket ?? '-'} · good / defect ซ้อนกัน`} />
        <div className="log-chart" onMouseLeave={() => setHover(null)}>
          {points.length && s?.total ? <>
            <svg viewBox={`0 0 ${points.length * 10} 100`} preserveAspectRatio="none" className="log-chart-svg" role="img" aria-label="กราฟจำนวน good และ defect ตามเวลา">
              {[25, 50, 75].map((y) => <line key={y} x1="0" x2={points.length * 10} y1={y} y2={y} className="log-grid" />)}
              {points.map((p, i) => { const gH = (p.good / maxBar) * 96; const dH = (p.defect / maxBar) * 96; const gap = p.good && p.defect ? 0.8 : 0; return <g key={p.t ?? i}>
                <rect x={i * 10 + 1.5} y={100 - gH} width={7} height={gH} fill={LOG_GOOD} rx={0.8} />
                <rect x={i * 10 + 1.5} y={100 - gH - dH} width={7} height={Math.max(0, dH - gap)} fill={LOG_DEFECT} rx={0.8} />
                <rect x={i * 10} y={0} width={10} height={100} fill={hover === i ? 'rgba(16,53,42,.06)' : 'transparent'} onMouseEnter={() => setHover(i)} />
              </g>; })}
            </svg>
            <div className="log-chart-axis">{points.map((p, i) => <span key={p.t ?? i} style={{ visibility: i % labelEvery === 0 ? 'visible' : 'hidden' }}>{logBucketLabel(p.t, data?.trend.bucket ?? '')}</span>)}</div>
            <div className="log-chart-max">{maxBar.toLocaleString()}</div>
            {hovered && <div className="log-tooltip" style={{ left: `${((hover ?? 0) + 0.5) / points.length * 100}%`, transform: `translateX(${(hover ?? 0) / points.length > 0.65 ? '-100%' : (hover ?? 0) / points.length < 0.2 ? '0' : '-50%'})` }}><strong>{logDateTime(hovered.t)}</strong><span><i style={{ background: LOG_GOOD }} />Good {hovered.good.toLocaleString()}</span><span><i style={{ background: LOG_DEFECT }} />Defect {hovered.defect.toLocaleString()}</span><span>รวม {hovered.total.toLocaleString()} · defect {hovered.total ? pct((hovered.defect / hovered.total) * 100) : '-'}</span></div>}
          </> : <div className="empty">ไม่มีข้อมูลในช่วงนี้</div>}
        </div>
        <div className="legend"><span className="legend-item"><i className="legend-dot" style={{ background: LOG_GOOD }} />Good {(s?.good ?? 0).toLocaleString()}</span><span className="legend-item"><i className="legend-dot" style={{ background: LOG_DEFECT }} />Defect {(s?.defect ?? 0).toLocaleString()}</span></div>
      </div>
      <div className="card pad">
        <SectionHeader title="Breakdown" kicker="ตามตัวกรองปัจจุบัน" />
        <div className="log-break">
          <div className="log-break-title">ประเภทตำหนิ (เฉพาะ defect)</div>
          {data?.by_defect.length ? data.by_defect.map((row) => <div key={row.key} className="log-break-row"><span>{row.key}</span><div className="log-break-bar"><i style={{ width: `${s?.defect ? (row.total / s.defect) * 100 : 0}%`, background: LOG_DEFECT }} /></div><strong>{row.total.toLocaleString()}</strong></div>) : <div className="log-break-empty">ไม่มี defect</div>}
          <div className="log-break-title">ชนิดผลไม้ · defect rate</div>
          {data?.by_fruit.map((row) => <div key={row.key} className="log-break-row"><span>{liveEmoji(row.key)} {row.key}</span><div className="log-break-bar"><i style={{ width: `${row.total ? (row.defect / row.total) * 100 : 0}%`, background: LOG_DEFECT }} /></div><strong>{row.total ? pct((row.defect / row.total) * 100, 0) : '-'} <em>/ {row.total.toLocaleString()}</em></strong></div>)}
          <div className="log-break-title">โมเดล · avg confidence</div>
          {data?.by_model.map((row) => <div key={row.key} className="log-break-row"><span>{row.key}</span><div className="log-break-bar"><i style={{ width: `${row.avg_conf ?? 0}%`, background: LOG_GOOD }} /></div><strong>{pct(row.avg_conf, 0)} <em>/ {row.total.toLocaleString()}</em></strong></div>)}
        </div>
      </div>
    </div>

    <div className="card pad">
      <SectionHeader title="Detailed event log" kicker={`${(data?.page.total_rows ?? 0).toLocaleString()} รายการจาก fruit_events`} action={<select className="select" style={{ width: 110 }} aria-label="จำนวนต่อหน้า" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>{[25, 50, 100].map((n) => <option key={n} value={n}>{n} / หน้า</option>)}</select>} />
      <div className="table-wrap"><table className="data-table"><thead><tr>
        <th><button type="button" className="log-sort" onClick={() => setSort((v) => v === 'desc' ? 'asc' : 'desc')}>เวลา {sort === 'desc' ? '↓' : '↑'}</button></th>
        <th>Event ID</th><th>Track</th><th>ชนิด</th><th>ผลภายนอก</th><th>ตำหนิ</th><th>NIR</th><th>Confidence</th><th>กล้อง</th><th>โมเดล</th><th>Sync</th>
      </tr></thead><tbody>{data?.rows.map((row) => <tr key={row.event_id}>
        <td>{logDateTime(row.ts)}</td>
        <td><strong style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{row.event_id}</strong></td>
        <td>{row.track_id ?? '-'}</td>
        <td>{liveEmoji(row.fruit_type)} {row.fruit_type ?? '-'}</td>
        <td><StatusPill tone={row.external_result === 'good' ? 'good' : row.external_result === 'defect' ? 'warn' : 'neutral'}>{row.external_result === 'good' ? 'ดี' : row.external_result === 'defect' ? 'เสีย' : row.external_result ?? '-'}</StatusPill></td>
        <td>{row.defect_type ?? <span style={{ color: '#b1bdb6' }}>—</span>}</td>
        <td>{row.nir_result ?? <span style={{ color: '#b1bdb6' }}>—</span>}</td>
        <td><strong>{conf(row.confidence)}</strong></td>
        <td>{row.camera_view ?? '-'}</td>
        <td>{row.model_version ?? '-'}</td>
        <td>{row.synced ? <StatusPill tone="good">synced</StatusPill> : <span style={{ color: '#9cada4' }}>local</span>}</td>
      </tr>)}</tbody></table>{!loading && !data?.rows.length && <div className="empty">ไม่พบ log ตามตัวกรองนี้</div>}</div>
      <div className="pagination"><span>แสดง {data?.rows.length ?? 0} จาก {(data?.page.total_rows ?? 0).toLocaleString()} รายการ · หน้า {page}/{data?.page.page_count ?? 1}</span><div className="page-btns"><button className="page-number" aria-label="หน้าก่อนหน้า" onClick={() => setPage((current) => Math.max(1, current - 1))}>‹</button>{pages.map((item, index) => <span key={item}>{index > 0 && item > pages[index - 1] + 1 && <span className="page-ellipsis">…</span>}<button className={`page-number ${page === item ? 'active' : ''}`} onClick={() => setPage(item)}>{item}</button></span>)}<button className="page-number" aria-label="หน้าถัดไป" onClick={() => setPage((current) => Math.min(data?.page.page_count ?? 1, current + 1))}>›</button></div></div>
    </div>
  </>;
}
function Bar({ label, value, width, color }: { label: string; value: string; width: string; color: string }) { return <div><div className="bar-item-head"><span>{label}</span><strong>{value}</strong></div><div className="bar-track"><div className={`bar-fill ${color === 'orange' ? '' : ''}`} style={{ width, background: color === 'green' ? '#1aa55c' : color === 'red' ? '#e26d60' : color === 'gray' ? '#9aaca2' : '#ff8a24' }} /></div></div>; }

type DbAlert = { id: number; ts: string | null; rule: string; level: 'info' | 'warning' | 'critical'; device_id: string | null; title: string; detail: string | null; status: 'new' | 'ack'; acked_at: string | null; acked_by: string | null; resolved_at: string | null; notify_status: string };
type AlertData = {
  alerts: DbAlert[];
  counts: { open: number; open_critical: number; unacked: number; today: number; notify_pending: number };
  history: { id: number; ts: string | null; device_id: string; from_state: string | null; to_state: string; age_sec: number | null; duration_sec: number | null }[];
  watcher: { running: boolean; last_seen: string | null; age_sec: number | null };
};
type AlertRules = {
  defect_rate: { enabled: boolean; threshold_pct: number; window_min: number; min_events: number };
  no_events: { enabled: boolean; after_sec: number };
  latency: { enabled: boolean; avg_sec: number };
  device: { enabled: boolean; notify_online: boolean };
  mqtt: { enabled: boolean };
  internet: { enabled: boolean };
  writer: { enabled: boolean };
  telegram: { enabled: boolean; min_level: 'info' | 'warning' | 'critical' };
  model_change: { enabled: boolean };
  daily_report: { enabled: boolean; hour: number; minute: number };
};
const defaultAlertRules: AlertRules = {
  defect_rate: { enabled: true, threshold_pct: 70, window_min: 10, min_events: 30 },
  no_events: { enabled: true, after_sec: 60 },
  latency: { enabled: true, avg_sec: 10 },
  device: { enabled: true, notify_online: true },
  mqtt: { enabled: true },
  internet: { enabled: true },
  writer: { enabled: true },
  telegram: { enabled: true, min_level: 'info' },
  model_change: { enabled: true },
  daily_report: { enabled: true, hour: 18, minute: 0 },
};
type DailyRow = { day: string; total: number; good: number; defect: number; defect_rate: number | null; avg_conf: number | null; last_at: string | null; run_min: number; alerts: number };

const alertLevelLabel: Record<DbAlert['level'], string> = { critical: 'วิกฤต', warning: 'เตือน', info: 'ข้อมูล' };
const alertTime = (value: string | null) => value ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '-';
const alertDuration = (sec: number | null) => sec == null ? 'ปัจจุบัน' : sec < 60 ? `${Math.round(sec)} วิ` : sec < 3600 ? `${Math.round(sec / 60)} นาที` : `${(sec / 3600).toFixed(1)} ชม.`;
const csvDownload = (name: string, header: string[], rows: (string | number | null)[][]) => {
  const cell = (v: string | number | null) => { const t = v == null ? '' : String(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const blob = new Blob([`﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); URL.revokeObjectURL(link.href);
};

function AlertsView() {
  const isAdmin = useAuth().user?.role === 'admin';
  const [range, setRange] = useState('7d'); const [status, setStatus] = useState('all'); const [level, setLevel] = useState('all');
  const [data, setData] = useState<AlertData | null>(null); const [error, setError] = useState('');
  const [rules, setRules] = useState<AlertRules | null>(null); const [rulesDirty, setRulesDirty] = useState(false); const [rulesMsg, setRulesMsg] = useState('');
  const [daily, setDaily] = useState<DailyRow[]>([]); const [runSince, setRunSince] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2200); };
  const [ai, setAi] = useState<{ scope: 'today' | 'week'; text: string; at: string; model: string } | null>(null);
  const [aiLoading, setAiLoading] = useState<'today' | 'week' | null>(null); const [aiError, setAiError] = useState('');
  const runAi = async (scope: 'today' | 'week') => {
    setAiLoading(scope); setAiError('');
    try {
      const response = await fetch('/api/ai/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope }) });
      const payload = await response.json() as { text?: string; generated_at?: string; model?: string; error?: string };
      if (!response.ok || !payload.text) throw new Error(payload.error || 'AI สรุปไม่สำเร็จ');
      setAi({ scope, text: payload.text, at: payload.generated_at ?? new Date().toISOString(), model: payload.model ?? '' });
    } catch (runError) { setAiError(runError instanceof Error ? runError.message : 'AI สรุปไม่สำเร็จ'); } finally { setAiLoading(null); }
  };

  const loadAlerts = async () => {
    try {
      const params = new URLSearchParams({ range, status }); if (level !== 'all') params.set('level', level);
      const response = await fetch(`/api/alerts?${params}`, { cache: 'no-store' });
      const payload = await response.json() as AlertData & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'โหลด alert ไม่สำเร็จ');
      setData(payload); setError('');
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'โหลด alert ไม่สำเร็จ'); }
  };
  useEffect(() => {
    void loadAlerts();
    const id = window.setInterval(() => { if (!document.hidden) void loadAlerts(); }, 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, status, level]);
  useEffect(() => {
    fetch('/api/alert-rules', { cache: 'no-store' }).then((r) => r.json()).then((p: { rules: Partial<AlertRules> | null }) => setRules(Object.fromEntries(Object.entries(defaultAlertRules).map(([k, v]) => [k, { ...v, ...(p.rules?.[k as keyof AlertRules] ?? {}) }])) as AlertRules)).catch(() => setRulesMsg('โหลดกฎไม่สำเร็จ'));
    const loadDaily = () => fetch('/api/reports/daily?days=7', { cache: 'no-store' }).then((r) => r.json()).then((p: { days: DailyRow[]; run_history_since: string | null }) => { setDaily(p.days ?? []); setRunSince(p.run_history_since); }).catch(() => undefined);
    void loadDaily();
    const id = window.setInterval(() => { if (!document.hidden) void loadDaily(); }, 60000);
    return () => window.clearInterval(id);
  }, []);

  const ack = async (body: object, message: string) => {
    const response = await fetch('/api/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as { updated?: number; error?: string };
    notify(response.ok ? `${message} ${payload.updated ?? 0} รายการ` : payload.error || 'บันทึกไม่สำเร็จ');
    void loadAlerts();
  };
  const setRule = <G extends keyof AlertRules>(group: G, field: keyof AlertRules[G], value: number | boolean | string) => {
    setRules((current) => current ? { ...current, [group]: { ...current[group], [field]: value } } : current); setRulesDirty(true); setRulesMsg('');
  };
  const saveRules = async () => {
    const response = await fetch('/api/alert-rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules }) });
    const payload = await response.json() as { rules?: AlertRules; error?: string };
    if (response.ok && payload.rules) { setRules(payload.rules); setRulesDirty(false); setRulesMsg('บันทึกแล้ว · watcher ใช้ค่าใหม่ภายใน 10 วินาที'); } else setRulesMsg(payload.error || 'บันทึกไม่สำเร็จ');
  };
  const exportAlerts = () => csvDownload('cira-core-alerts.csv', ['id', 'time_bangkok', 'level', 'rule', 'device_id', 'title', 'detail', 'status', 'acked_by', 'acked_at', 'resolved_at', 'notify_status'],
    (data?.alerts ?? []).map((a) => [a.id, alertTime(a.ts), a.level, a.rule, a.device_id, a.title, a.detail, a.status, a.acked_by, a.acked_at, a.resolved_at, a.notify_status]));
  const exportDaily = () => csvDownload('cira-core-daily-report.csv', ['day', 'total', 'good', 'defect', 'defect_rate_pct', 'avg_conf_pct', 'last_event', 'run_min', 'alerts'],
    daily.map((d) => [d.day, d.total, d.good, d.defect, d.defect_rate == null ? null : d.defect_rate.toFixed(1), d.avg_conf == null ? null : d.avg_conf.toFixed(1), d.last_at, d.run_min, d.alerts]));

  const c = data?.counts;
  const today = daily[0]; const yesterday = daily[1];
  const delta = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? null : a - b;
  const num = (value: number, onChange: (v: number) => void, min: number, max: number, suffix: string) => <span className="rule-num"><input className="input" type="number" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} /><em>{suffix}</em></span>;

  return <>
    <PageHeader page="alerts" actions={<>
      <button type="button" className="btn btn-ghost" onClick={() => void ack({ action: 'ack_all' }, 'รับทราบแล้ว')} disabled={!c?.unacked}><Check size={14} /> รับทราบทั้งหมด ({c?.unacked ?? 0})</button>
      <button type="button" className="btn btn-primary" onClick={exportAlerts} disabled={!data?.alerts.length}><Download size={14} /> Export alerts</button>
    </>} />
    {data && !data.watcher.running && <div className="live-banner" style={{ marginBottom: 14 }}><AlertTriangle size={14} />alert_watcher ไม่ทำงาน{data.watcher.last_seen ? ` (เห็นล่าสุด ${alertTime(data.watcher.last_seen)})` : ''} · alert ใหม่จะไม่ถูกสร้าง · รัน <code>python scripts/alert_watcher.py</code></div>}
    {error && <div className="live-banner error" style={{ marginBottom: 14 }}>{error}</div>}

    <div className="summary-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 18 }}>
      <div className="summary-tile"><span>เปิดอยู่ (ยังไม่หาย)</span><strong style={{ color: c?.open ? '#d3574e' : undefined }}>{c?.open ?? '-'}</strong>{!!c?.open_critical && <span style={{ color: '#d3574e' }}>วิกฤต {c.open_critical}</span>}</div>
      <div className="summary-tile"><span>ยังไม่รับทราบ</span><strong>{c?.unacked ?? '-'}</strong></div>
      <div className="summary-tile"><span>alert วันนี้</span><strong>{c?.today ?? '-'}</strong></div>
      <div className="summary-tile"><span>Watcher</span><strong style={{ fontSize: 15 }}><StatusPill tone={data?.watcher.running ? 'good' : 'bad'}>{data?.watcher.running ? 'ทำงาน' : 'หยุด'}</StatusPill></strong><span>Telegram รอส่ง {c?.notify_pending ?? 0}</span></div>
    </div>

    <div className="section-grid grid-2 alerts-grid" style={{ alignItems: 'start' }}>
      <div className="card pad">
        <SectionHeader title="Alert inbox" kicker="จาก alert_watcher · อัปเดตทุก 5 วินาที" action={<div style={{ display: 'flex', gap: 6 }}>
          <select className="select" style={{ width: 92 }} aria-label="ช่วงเวลา" value={range} onChange={(e) => setRange(e.target.value)}><option value="24h">24 ชม.</option><option value="7d">7 วัน</option><option value="30d">30 วัน</option></select>
          <select className="select" style={{ width: 110 }} aria-label="สถานะ" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">ทุกสถานะ</option><option value="open">ยังเปิดอยู่</option><option value="new">ยังไม่รับทราบ</option><option value="resolved">หายแล้ว</option></select>
          <select className="select" style={{ width: 92 }} aria-label="ระดับ" value={level} onChange={(e) => setLevel(e.target.value)}><option value="all">ทุกระดับ</option><option value="critical">วิกฤต</option><option value="warning">เตือน</option><option value="info">ข้อมูล</option></select>
        </div>} />
        <div className="alert-list alert-scroll">{data?.alerts.length ? data.alerts.map((a) => <div key={a.id} className={`alert-item ${a.level}`}>
          <div className="alert-symbol">{a.level === 'info' ? <Info size={15} /> : <AlertTriangle size={15} />}</div>
          <div className="alert-content"><strong>{a.title}</strong><p>{a.detail}</p><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <StatusPill tone={a.level === 'critical' ? 'bad' : a.level === 'warning' ? 'warn' : 'neutral'}>{alertLevelLabel[a.level]}</StatusPill>
            {a.level !== 'info' && <StatusPill tone={a.resolved_at ? 'good' : 'bad'}>{a.resolved_at ? 'หายแล้ว' : 'ยังเปิดอยู่'}</StatusPill>}
            <span className="alert-meta">{alertTime(a.ts)}{a.resolved_at && a.level !== 'info' ? ` · หาย ${alertTime(a.resolved_at)}` : ''}{a.acked_at ? ` · รับทราบโดย ${a.acked_by}` : ''} · Telegram: {({ sent: 'ส่งแล้ว', pending: 'รอส่ง', skipped: 'ไม่ส่ง', failed: 'ส่งไม่สำเร็จ' } as Record<string, string>)[a.notify_status] ?? a.notify_status}</span>
          </div></div>
          <div className="alert-actions">{a.status === 'new' && a.level !== 'info' ? <button type="button" className="btn btn-ghost" onClick={() => void ack({ action: 'ack', ids: [a.id] }, 'รับทราบแล้ว')}><Check size={13} /> รับทราบ</button> : <span className="alert-meta">{a.level === 'info' ? '' : 'รับทราบแล้ว'}</span>}</div>
        </div>) : <div className="empty">{data ? 'ไม่มี alert ตามตัวกรองนี้' : 'กำลังโหลด...'}</div>}</div>
      </div>

      <div className="section-grid" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="card pad">
          <SectionHeader title="ประวัติเปิด / ปิดเครื่อง" kicker="device_state_log · บันทึกตอน state เปลี่ยน" />
          <div className="state-log">{data?.history.length ? data.history.map((h) => <div key={h.id} className="state-row">
            <span className="state-time">{alertTime(h.ts)}</span>
            <StatusPill tone={h.to_state === 'offline' ? 'bad' : h.to_state === 'playing' || h.to_state === 'started' ? 'good' : 'neutral'}>{h.to_state}</StatusPill>
            <span className="state-meta">{h.device_id}{h.from_state ? ` · จาก ${h.from_state}` : ''}</span>
            <strong>{alertDuration(h.duration_sec)}</strong>
          </div>) : <div className="empty">ยังไม่มีประวัติ (เริ่มบันทึกเมื่อ watcher ทำงาน)</div>}</div>
        </div>

        <div className="card pad">
          <SectionHeader title="Alert rules" kicker={isAdmin ? 'เก็บใน settings.alert_rules' : 'ดูได้อย่างเดียว · แก้ได้เฉพาะ Admin'} action={isAdmin ? <button type="button" className="btn btn-primary" onClick={() => void saveRules()} disabled={!rulesDirty}><Save size={14} /> บันทึก</button> : undefined} />
          {rules ? <div className={`rule-list ${isAdmin ? '' : 'readonly'}`}>
            <div className="rule-row"><Toggle on={rules.device.enabled} onChange={(v) => setRule('device', 'enabled', v)} label="กล้องหยุด / กลับมา" hint="ไม่มี heartbeat เกิน 6 วินาที (จาก VIEW)" /><label className="rule-check"><input type="checkbox" checked={rules.device.notify_online} onChange={(e) => setRule('device', 'notify_online', e.target.checked)} /> แจ้งตอนกลับมาด้วย</label></div>
            <div className="rule-row"><Toggle on={rules.defect_rate.enabled} onChange={(v) => setRule('defect_rate', 'enabled', v)} label="Defect rate สูง" hint="ต้องมี event ขั้นต่ำก่อนคำนวณ" /><div className="rule-fields">เกิน {num(rules.defect_rate.threshold_pct, (v) => setRule('defect_rate', 'threshold_pct', v), 1, 100, '%')} ใน {num(rules.defect_rate.window_min, (v) => setRule('defect_rate', 'window_min', v), 1, 240, 'นาที')} ขั้นต่ำ {num(rules.defect_rate.min_events, (v) => setRule('defect_rate', 'min_events', v), 1, 10000, 'ผล')}</div></div>
            <div className="rule-row"><Toggle on={rules.no_events.enabled} onChange={(v) => setRule('no_events', 'enabled', v)} label="ทำงานแต่ไม่มีผลไม้เข้า" hint="เครื่อง playing แต่ไม่มี event" /><div className="rule-fields">นานกว่า {num(rules.no_events.after_sec, (v) => setRule('no_events', 'after_sec', v), 10, 3600, 'วินาที')}</div></div>
            <div className="rule-row"><Toggle on={rules.latency.enabled} onChange={(v) => setRule('latency', 'enabled', v)} label="ความหน่วง CIRA ถึง DB สูง" hint="เฉลี่ย event ใน 2 นาทีล่าสุด" /><div className="rule-fields">เกิน {num(rules.latency.avg_sec, (v) => setRule('latency', 'avg_sec', v), 1, 600, 'วินาที')}</div></div>
            <div className="rule-row"><Toggle on={rules.mqtt.enabled} onChange={(v) => setRule('mqtt', 'enabled', v)} label="MQTT broker ล่ม / กลับมา" hint="watcher เชื่อม broker เองไม่ได้ (ระดับวิกฤต)" /></div>
            <div className="rule-row"><Toggle on={rules.internet.enabled} onChange={(v) => setRule('internet', 'enabled', v)} label="Internet ล่ม / กลับมา" hint="ตรวจทุก 5 วินาที (HEALTHCHECK_URL)" /></div>
            <div className="rule-row"><Toggle on={rules.writer.enabled} onChange={(v) => setRule('writer', 'enabled', v)} label="ตัวบันทึก DB ไม่ทำงาน" hint="มีข้อความ MQTT แต่ไม่ถูกเขียนลง DB (mqtt_to_db.py)" /></div>
            <div className="rule-row"><Toggle on={rules.telegram.enabled} onChange={(v) => setRule('telegram', 'enabled', v)} label="ส่งเข้า Telegram" hint="TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID ใน .env" /><div className="rule-fields">ส่งตั้งแต่ระดับ <select className="select" style={{ width: 120 }} value={rules.telegram.min_level} onChange={(e) => setRule('telegram', 'min_level', e.target.value)}><option value="info">ข้อมูล (ทุกอย่าง)</option><option value="warning">เตือนขึ้นไป</option><option value="critical">วิกฤตเท่านั้น</option></select></div></div>
            <div className="rule-row"><Toggle on={rules.model_change.enabled} onChange={(v) => setRule('model_change', 'enabled', v)} label="โมเดลเปลี่ยน" hint="model_version ของ event ใหม่ต่างจากเดิม (เปลี่ยนใน CIRA CORE)" /></div>
            <div className="rule-row"><Toggle on={rules.daily_report.enabled} onChange={(v) => setRule('daily_report', 'enabled', v)} label="รายงานประจำวันเข้า Telegram" hint="สรุปยอดวันนี้ ส่งวันละครั้ง (ส่งเสมอไม่ขึ้นกับระดับขั้นต่ำ)" /><div className="rule-fields">เวลา {num(rules.daily_report.hour, (v) => setRule('daily_report', 'hour', v), 0, 23, 'น.')} {num(rules.daily_report.minute, (v) => setRule('daily_report', 'minute', v), 0, 59, 'นาที')}</div></div>
            <div className="card-kicker">ฐานข้อมูลล่ม บันทึกเสมอ: watcher เก็บไว้ในหน่วยความจำแล้วเขียนลง DB ตอนกลับมา</div>
            {rulesMsg && <div className="card-kicker" style={{ color: rulesMsg.startsWith('บันทึกแล้ว') ? '#1a7f47' : '#c4564d' }}>{rulesMsg}</div>}
          </div> : <div className="empty">{rulesMsg || 'กำลังโหลด...'}</div>}
        </div>
      </div>
    </div>

    <div className="card pad ai-card" style={{ marginTop: 18 }}>
      <SectionHeader title="AI สรุป" kicker="Gemini สรุปจากตัวเลขใน DB (ส่งเฉพาะตัวเลขสรุป) · ใน Telegram กด 🤖 ได้เหมือนกัน" action={<div style={{ display: 'flex', gap: 6 }}>
        <button type="button" className="btn btn-primary" onClick={() => void runAi('today')} disabled={aiLoading !== null}><Sparkles size={14} /> {aiLoading === 'today' ? 'กำลังสรุป...' : 'สรุปวันนี้'}</button>
        <button type="button" className="btn btn-ghost" onClick={() => void runAi('week')} disabled={aiLoading !== null}><Sparkles size={14} /> {aiLoading === 'week' ? 'กำลังสรุป...' : 'สรุป 7 วัน'}</button>
      </div>} />
      {aiError && <div className="live-banner error">{aiError}</div>}
      {ai ? <><div className="ai-text">{ai.text}</div><div className="card-kicker">{ai.scope === 'today' ? 'วันนี้' : '7 วัน'} · {alertTime(ai.at)} · {ai.model}</div></> : !aiError && <div className="empty">กดปุ่มเพื่อให้ AI สรุป</div>}
    </div>

    <div className="card pad" style={{ marginTop: 18 }}>
      <SectionHeader title="รายงานรายวัน (7 วัน)" kicker={`จาก fruit_events + device_state_log + alerts · เวลาทำงานเริ่มนับ ${runSince ? alertTime(runSince) : 'เมื่อ watcher ทำงาน'}`} action={<button type="button" className="btn btn-ghost" onClick={exportDaily} disabled={!daily.length}><Download size={14} /> CSV</button>} />
      {today && <div className="summary-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        <div className="summary-tile"><span>วันนี้คัดแล้ว</span><strong>{today.total.toLocaleString()}</strong><span>{yesterday ? `เมื่อวาน ${yesterday.total.toLocaleString()}` : ''}</span></div>
        <div className="summary-tile"><span>Defect rate วันนี้</span><strong>{today.defect_rate == null ? '-' : `${today.defect_rate.toFixed(1)}%`}</strong><span>{(() => { const d = delta(today.defect_rate, yesterday?.defect_rate); return d == null ? '' : `${d > 0 ? '+' : ''}${d.toFixed(1)} จุดจากเมื่อวาน`; })()}</span></div>
        <div className="summary-tile"><span>เวลาเครื่องทำงานวันนี้</span><strong>{today.run_min} นาที</strong></div>
        <div className="summary-tile"><span>Alert วันนี้ (ไม่รวม info)</span><strong>{today.alerts}</strong></div>
      </div>}
      <div className="table-wrap"><table className="data-table"><thead><tr><th>วันที่</th><th>คัดทั้งหมด</th><th>ดี</th><th>เสีย</th><th>Defect rate</th><th>Avg confidence</th><th>Event ล่าสุด</th><th>เครื่องทำงาน</th><th>Alerts</th></tr></thead>
        <tbody>{daily.map((d) => <tr key={d.day}><td><strong>{d.day}</strong></td><td>{d.total.toLocaleString()}</td><td>{d.good.toLocaleString()}</td><td>{d.defect.toLocaleString()}</td><td><strong>{d.defect_rate == null ? '-' : `${d.defect_rate.toFixed(1)}%`}</strong></td><td>{d.avg_conf == null ? '-' : `${d.avg_conf.toFixed(1)}%`}</td><td>{d.last_at ?? '-'}</td><td>{d.run_min ? `${d.run_min} นาที` : '-'}</td><td>{d.alerts || '-'}</td></tr>)}</tbody></table>
        {!daily.length && <div className="empty">กำลังโหลด...</div>}</div>
    </div>
    {toast && <div className="toast"><Check size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} />{toast}</div>}
  </>;
}

type DeviceStatus = {
  device_id: string;
  source_type: string | null;
  state: string | null;
  last_seen: string | null;
  age_sec: number | null;
};

type SystemHealth = {
  db: 'online' | 'offline' | 'unknown';
  mqtt: 'online' | 'offline' | 'unknown';
  internet: 'online' | 'offline' | 'unknown';
  checked_at: string | null;
};

function SystemView() {
  const shell = useContext(ShellContext);
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [health, setHealth] = useState<SystemHealth>({ db: 'unknown', mqtt: 'unknown', internet: 'unknown', checked_at: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [devicesResponse, healthResponse] = await Promise.all([
          fetch('/api/devices', { cache: 'no-store' }),
          fetch('/api/system-health', { cache: 'no-store' }),
        ]);
        const payload = await devicesResponse.json() as { devices?: DeviceStatus[]; error?: string };
        const healthPayload = await healthResponse.json() as Partial<SystemHealth> & { error?: string };
        if (!devicesResponse.ok) throw new Error(payload.error || 'โหลดสถานะอุปกรณ์ไม่สำเร็จ');
        if (active) {
          setDevices(payload.devices || []);
          if (healthResponse.ok) {
            shell.report({ mqtt: healthPayload.mqtt || 'unknown', db: healthPayload.db || 'unknown', internet: healthPayload.internet || 'unknown' });
            setHealth({
              db: healthPayload.db || 'unknown',
              mqtt: healthPayload.mqtt || 'unknown',
              internet: navigator.onLine ? healthPayload.internet || 'unknown' : 'offline',
              checked_at: healthPayload.checked_at || null,
            });
          }
          setError('');
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'โหลดสถานะอุปกรณ์ไม่สำเร็จ');
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const formatThaiTime = (value: string | null) => value
    ? new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
    : '-';
  const stateTone = (state: string | null) => state === 'offline' ? 'bad' : state === 'playing' || state === 'started' ? 'good' : 'neutral';
  const healthTone = (state: SystemHealth[keyof SystemHealth]) => state === 'online' ? 'good' : state === 'offline' ? 'bad' : 'neutral';
  const healthLabel = (state: SystemHealth[keyof SystemHealth]) => state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'ไม่ทราบ';

  return <><PageHeader page="system" /><div className="card pad"><SectionHeader title="System health" kicker="ตรวจสอบทุก 2 วินาที · การเปลี่ยนสถานะถูกบันทึกใน system_logs" /><div className="summary-strip health-strip"><div className="summary-tile"><span>Database</span><strong><StatusPill tone={healthTone(health.db)}>{healthLabel(health.db)}</StatusPill></strong></div><div className="summary-tile"><span>MQTT broker</span><strong><StatusPill tone={healthTone(health.mqtt)}>{healthLabel(health.mqtt)}</StatusPill></strong></div><div className="summary-tile"><span>Internet</span><strong><StatusPill tone={healthTone(health.internet)}>{healthLabel(health.internet)}</StatusPill></strong></div><div className="summary-tile"><span>ตรวจล่าสุด</span><strong style={{ fontSize: 13 }}>{health.checked_at ? formatThaiTime(health.checked_at) : '-'}</strong></div></div></div><div className="card pad" style={{ marginTop: 18 }}><SectionHeader title="Device status" kicker="ข้อมูลล่าสุดจาก VIEW device_status_live" /><div className="table-wrap">{loading ? <div className="empty">กำลังโหลดสถานะอุปกรณ์...</div> : error ? <div className="empty" style={{ color: '#c4564d' }}>{error}</div> : !devices.length ? <div className="empty">ไม่พบอุปกรณ์ในฐานข้อมูล</div> : <table className="data-table"><thead><tr><th>Device ID</th><th>Source type</th><th>State</th><th>Last seen (เวลาไทย)</th><th>Age</th></tr></thead><tbody>{devices.map((device) => <tr key={device.device_id}><td><strong>{device.device_id}</strong></td><td>{device.source_type || '-'}</td><td><StatusPill tone={stateTone(device.state)}>{device.state || '-'}</StatusPill></td><td>{formatThaiTime(device.last_seen)}</td><td>{device.age_sec == null ? '-' : `${device.age_sec} วินาที`}</td></tr>)}</tbody></table>}</div></div><DataQualityCard /></>;
}

type ProfilesData = {
  fruits: { code: string; name_th: string | null; name_en: string | null; icon: string | null; total_7d: number; defect_7d: number; defect_rate_7d: number | null; avg_conf_7d: number | null; last_seen: string | null }[];
  defects: { code: string; name_th: string | null; name_en: string | null; seen_7d: number }[];
  models: { model_version: string; model_source: string; precision: number | null; recall: number | null; map: number | null; threshold: number | null; created_at: string | null; last_seen: string | null }[];
};
const pctText = (value: number | null | undefined, digits = 1) => value == null ? '-' : `${value.toFixed(digits)}%`;
const metricText = (value: number | null) => value == null ? '-' : value <= 1 ? value.toFixed(3) : value.toFixed(1);

function ProfilesView() {
  const [data, setData] = useState<ProfilesData | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/profiles', { cache: 'no-store' }).then(async (r) => { const p = await r.json() as ProfilesData & { error?: string }; if (!r.ok) throw new Error(p.error || 'โหลดไม่สำเร็จ'); setData(p); }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'));
  }, []);
  return <><PageHeader page="profiles" />
    <div className="info-callout" style={{ marginBottom: 18 }}><Info size={16} /><div><strong>อ่านอย่างเดียว</strong><p>threshold, ความเร็วสายพาน, กล้อง และโมเดล ตั้งค่าใน CIRA CORE เท่านั้น · หน้านี้แสดงสิ่งที่ระบบรู้จัก (ตาราง fruit_types / defect_types / models) และสิ่งที่เห็นจริงใน 7 วันล่าสุด · โมเดลใหม่ถูกลงทะเบียนอัตโนมัติเมื่อมี event แรกเข้ามา</p></div></div>
    {error && <div className="live-banner error" style={{ marginBottom: 14 }}>{error}</div>}
    <div className="profile-grid">{data?.fruits.map((fruit) => <div className="card profile-card" key={fruit.code}>
      <div className="profile-top"><div className="fruit-emoji">{fruit.icon ?? liveEmoji(fruit.code)}</div><StatusPill tone={fruit.total_7d ? 'good' : 'neutral'}>{fruit.total_7d ? 'มีข้อมูล 7 วัน' : 'ไม่มีข้อมูล 7 วัน'}</StatusPill></div>
      <div className="profile-name">{fruit.name_th ?? fruit.code}</div><div className="profile-note">{fruit.name_en ?? ''} · code <code>{fruit.code}</code></div>
      <div className="profile-fields">
        <div className="profile-field"><span>คัด 7 วัน</span><strong>{fruit.total_7d.toLocaleString()} ผล</strong></div>
        <div className="profile-field"><span>Defect rate 7 วัน</span><strong>{pctText(fruit.defect_rate_7d)}</strong></div>
        <div className="profile-field"><span>Confidence เฉลี่ย</span><strong>{pctText(fruit.avg_conf_7d)}</strong></div>
        <div className="profile-field"><span>เห็นล่าสุด</span><strong>{fruit.last_seen ? logDateTime(fruit.last_seen) : '-'}</strong></div>
      </div>
    </div>)}</div>
    {!data && !error && <div className="empty">กำลังโหลด...</div>}
    {data && <div className="section-grid grid-2" style={{ marginTop: 18, alignItems: 'start' }}>
      <div className="card pad"><SectionHeader title="ชนิดตำหนิ (defect_types)" kicker="defect_type ที่ไม่อยู่ในตารางนี้จะถูกเก็บเป็น NULL · ดูที่ System Status" />
        <div className="table-wrap"><table className="data-table" style={{ minWidth: 0 }}><thead><tr><th>code</th><th>ชื่อไทย</th><th>English</th><th>พบ 7 วัน</th></tr></thead><tbody>{data.defects.map((d) => <tr key={d.code}><td><strong>{d.code}</strong></td><td>{d.name_th ?? '-'}</td><td>{d.name_en ?? '-'}</td><td>{d.seen_7d.toLocaleString()}</td></tr>)}</tbody></table></div></div>
      <div className="card pad"><SectionHeader title="โมเดล (models)" kicker="precision / recall / mAP กรอกเมื่อทีม B ส่งผลมา" />
        <div className="table-wrap"><table className="data-table" style={{ minWidth: 0 }}><thead><tr><th>model_version</th><th>source</th><th>precision</th><th>recall</th><th>mAP</th><th>เห็นล่าสุด</th></tr></thead><tbody>{data.models.map((m) => <tr key={m.model_version}><td><strong>{m.model_version}</strong></td><td>{m.model_source}</td><td>{metricText(m.precision)}</td><td>{metricText(m.recall)}</td><td>{metricText(m.map)}</td><td>{m.last_seen ? logDateTime(m.last_seen) : 'ยังไม่มี event'}</td></tr>)}</tbody></table></div></div>
    </div>}
  </>;
}

type RunRow = { device_id: string; start: string; end: string | null; end_state: string | null; running: boolean; duration_sec: number; total: number; good: number; defect: number; defect_rate: number | null; avg_conf: number | null; per_min: number | null; models: string[]; first_event: string | null; last_event: string | null; alerts: number };
type ModelRow = { model: string; source: string | null; total: number; defect: number; defect_rate: number | null; avg_conf: number | null; median_conf: number | null; low_conf_pct: number | null; defect_untyped: number; first_seen: string | null; last_seen: string | null; registered: boolean; metrics: { precision: number | null; recall: number | null; map: number | null; threshold: number | null } | null; by_fruit: { fruit: string; total: number; defect: number; defect_rate: number | null }[] };

function RunsView() {
  const [days, setDays] = useState(7); const [range, setRange] = useState('7d');
  const [runs, setRuns] = useState<{ runs: RunRow[]; history_since: string | null } | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => fetch(`/api/runs?days=${days}`, { cache: 'no-store' }).then(async (r) => { const p = await r.json() as { runs: RunRow[]; history_since: string | null; error?: string }; if (!r.ok) throw new Error(p.error || 'โหลดรอบการทำงานไม่สำเร็จ'); if (active) { setRuns(p); setError(''); } }).catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'));
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { active = false; window.clearInterval(id); };
  }, [days]);
  useEffect(() => {
    let active = true;
    const load = () => fetch(`/api/models?range=${range}`, { cache: 'no-store' }).then(async (r) => { const p = await r.json() as { models: ModelRow[]; error?: string }; if (!r.ok) throw new Error(p.error || 'โหลดสถิติโมเดลไม่สำเร็จ'); if (active) setModels(p.models); }).catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'));
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 30000);
    return () => { active = false; window.clearInterval(id); };
  }, [range]);

  const list = runs?.runs ?? [];
  const sum = list.reduce((acc, r) => ({ total: acc.total + r.total, defect: acc.defect + r.defect, sec: acc.sec + r.duration_sec }), { total: 0, defect: 0, sec: 0 });
  const exportRuns = () => csvDownload('cira-core-runs.csv', ['device_id', 'start_bangkok', 'end_bangkok', 'end_state', 'duration_min', 'total', 'good', 'defect', 'defect_rate_pct', 'avg_conf_pct', 'per_min', 'models', 'alerts'],
    list.map((r) => [r.device_id, logDateTime(r.start), r.end ? logDateTime(r.end) : 'running', r.end_state, (r.duration_sec / 60).toFixed(1), r.total, r.good, r.defect, r.defect_rate == null ? null : r.defect_rate.toFixed(1), r.avg_conf == null ? null : r.avg_conf.toFixed(1), r.per_min == null ? null : r.per_min.toFixed(1), r.models.join(' '), r.alerts]));
  const exportModels = () => csvDownload('cira-core-models.csv', ['model', 'source', 'total', 'defect', 'defect_rate_pct', 'avg_conf_pct', 'median_conf_pct', 'low_conf_pct', 'defect_without_type', 'first_seen', 'last_seen'],
    (models ?? []).map((m) => [m.model, m.source, m.total, m.defect, m.defect_rate == null ? null : m.defect_rate.toFixed(1), m.avg_conf == null ? null : m.avg_conf.toFixed(1), m.median_conf == null ? null : m.median_conf.toFixed(1), m.low_conf_pct == null ? null : m.low_conf_pct.toFixed(1), m.defect_untyped, m.first_seen, m.last_seen]));

  return <><PageHeader page="runs" />
    {error && <div className="live-banner error" style={{ marginBottom: 14 }}>{error}</div>}
    <div className="summary-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 18 }}>
      <div className="summary-tile"><span>รอบการทำงาน ({days} วัน)</span><strong>{runs ? list.length : '-'}</strong>{list[0]?.running && <span style={{ color: '#1a7f47' }}>กำลังทำงาน 1 รอบ</span>}</div>
      <div className="summary-tile"><span>คัดรวมในรอบ</span><strong>{sum.total.toLocaleString()}</strong></div>
      <div className="summary-tile"><span>Defect rate รวม</span><strong>{sum.total ? `${((sum.defect / sum.total) * 100).toFixed(1)}%` : '-'}</strong></div>
      <div className="summary-tile"><span>เวลาเครื่องทำงานรวม</span><strong>{alertDuration(sum.sec)}</strong></div>
    </div>
    <div className="card pad">
      <SectionHeader title="รอบการทำงาน" kicker={`เริ่มเมื่อสถานะเป็น playing/started · จบเมื่อ offline/end · บันทึกสถานะตั้งแต่ ${runs?.history_since ? logDateTime(runs.history_since) : '-'}`} action={<div style={{ display: 'flex', gap: 6 }}>
        <select className="select" style={{ width: 96 }} aria-label="ช่วงเวลา" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>24 ชม.</option><option value={7}>7 วัน</option><option value={30}>30 วัน</option></select>
        <button type="button" className="btn btn-ghost" onClick={exportRuns} disabled={!list.length}><Download size={14} /> CSV</button></div>} />
      <div className="table-wrap"><table className="data-table"><thead><tr><th>เริ่ม</th><th>จบ</th><th>ระยะเวลา</th><th>อุปกรณ์</th><th>คัด</th><th>ดี</th><th>เสีย</th><th>Defect</th><th>Conf.</th><th>ผล/นาที</th><th>โมเดล</th><th>Alert</th></tr></thead>
        <tbody>{list.map((r) => <tr key={`${r.device_id}-${r.start}`}>
          <td><strong>{logDateTime(r.start)}</strong></td>
          <td>{r.running ? <StatusPill tone="good">กำลังทำงาน</StatusPill> : <>{r.end ? logDateTime(r.end) : '-'} <span style={{ color: '#9cada4' }}>{r.end_state}</span></>}</td>
          <td>{alertDuration(r.duration_sec)}</td><td>{r.device_id}</td>
          <td><strong>{r.total.toLocaleString()}</strong></td><td>{r.good.toLocaleString()}</td><td>{r.defect.toLocaleString()}</td>
          <td><strong>{pctText(r.defect_rate)}</strong></td><td>{pctText(r.avg_conf)}</td><td>{r.per_min == null ? '-' : r.per_min.toFixed(1)}</td>
          <td>{r.models.length ? r.models.map((m) => <span key={m} className="tag neutral" style={{ marginRight: 4 }}>{m}</span>) : '-'}</td>
          <td>{r.alerts || '-'}</td>
        </tr>)}</tbody></table>
        {runs && !list.length && <div className="empty">ไม่มีรอบการทำงานในช่วงนี้ (เริ่มบันทึกเมื่อ alert_watcher ทำงาน)</div>}
        {!runs && !error && <div className="empty">กำลังโหลด...</div>}</div>
      <div className="card-kicker" style={{ marginTop: 10 }}>fruit_events ไม่มีคอลัมน์อุปกรณ์ ถ้ามีหลายกล้องทำงานพร้อมกัน ยอดของแต่ละรอบจะนับรวมกัน</div>
    </div>

    <div className="card pad" style={{ marginTop: 18 }}>
      <SectionHeader title="เทียบโมเดล" kicker="แยกตาม model_version ที่ CIRA CORE ใส่มาใน event · เปลี่ยนโมเดลใน CORE แล้ว watcher แจ้ง alert" action={<div style={{ display: 'flex', gap: 6 }}>
        <select className="select" style={{ width: 96 }} aria-label="ช่วงเวลา" value={range} onChange={(e) => setRange(e.target.value)}><option value="24h">24 ชม.</option><option value="7d">7 วัน</option><option value="30d">30 วัน</option><option value="all">ทั้งหมด</option></select>
        <button type="button" className="btn btn-ghost" onClick={exportModels} disabled={!models?.length}><Download size={14} /> CSV</button></div>} />
      <div className="table-wrap"><table className="data-table"><thead><tr><th>โมเดล</th><th>source</th><th>คัด</th><th>Defect rate</th><th>Conf. เฉลี่ย</th><th>Conf. median</th><th title="confidence ต่ำกว่า 60%">Conf. &lt; 60%</th><th>เสียแต่ไม่ระบุตำหนิ</th><th>แยกตามผลไม้</th><th>ใช้ช่วง</th><th>precision / recall</th></tr></thead>
        <tbody>{(models ?? []).map((m) => <tr key={m.model}>
          <td><strong>{m.model}</strong>{!m.registered && <span className="tag warn" style={{ marginLeft: 6 }}>ไม่อยู่ใน models</span>}</td><td>{m.source ?? '-'}</td>
          <td>{m.total.toLocaleString()}</td><td><strong>{pctText(m.defect_rate)}</strong></td><td>{pctText(m.avg_conf)}</td><td>{pctText(m.median_conf)}</td><td>{pctText(m.low_conf_pct)}</td><td>{m.defect_untyped.toLocaleString()}</td>
          <td>{m.by_fruit.map((f) => <span key={f.fruit} className="tag neutral" style={{ marginRight: 4 }}>{liveEmoji(f.fruit)} {f.total.toLocaleString()} · {pctText(f.defect_rate, 0)}</span>)}</td>
          <td>{m.first_seen ? logDateTime(m.first_seen) : '-'} – {m.last_seen ? logDateTime(m.last_seen) : '-'}</td>
          <td>{m.metrics && (m.metrics.precision != null || m.metrics.recall != null) ? `${metricText(m.metrics.precision)} / ${metricText(m.metrics.recall)}` : '-'}</td>
        </tr>)}</tbody></table>
        {models && !models.length && <div className="empty">ไม่มี event ในช่วงนี้</div>}</div>
      <div className="card-kicker" style={{ marginTop: 10 }}>defect rate ต่างกันระหว่างโมเดลอาจมาจากผลไม้ล็อตต่างกัน · เทียบให้แฟร์ใช้ชุดทดสอบเดียวกัน (ภาพหน้างานจากทีม A)</div>
    </div>
  </>;
}

type DataQuality = {
  range: string; stored: number; rejected: number; dedup_dropped: number;
  reasons: { reason: string; n: number }[];
  unknown: { fruit: number; defect: number; model: number; defect_untyped: number; no_track: number; fruit_values: string[]; defect_values: string[]; model_values: string[] };
  rejects: { id: number; ts: string; reason: string; payload: string }[];
};
const rejectReasonLabel: Record<string, string> = {
  invalid_json: 'JSON เสีย', not_a_json_object: 'ไม่ใช่ JSON object', missing_event_id: 'ไม่มี event_id', missing_timestamp: 'ไม่มี timestamp',
  bad_timestamp: 'timestamp ผิดรูปแบบ', bad_external_result: 'external_result ไม่ใช่ good/defect', bad_confidence: 'confidence ไม่ใช่ตัวเลข',
};
const rejectLabel = (reason: string) => rejectReasonLabel[reason.split(' ')[0]] ?? (reason.startsWith('db_rejected') ? 'DB ไม่รับ' : reason);

function DataQualityCard() {
  const [range, setRange] = useState('24h'); const [data, setData] = useState<DataQuality | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => fetch(`/api/data-quality?range=${range}`, { cache: 'no-store' }).then(async (r) => { const p = await r.json() as DataQuality & { error?: string }; if (!r.ok) throw new Error(p.error || 'โหลดไม่สำเร็จ'); if (active) { setData(p); setError(''); } }).catch((e: unknown) => active && setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'));
    void load();
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { active = false; window.clearInterval(id); };
  }, [range]);
  const u = data?.unknown;
  const unknownTotal = u ? u.fruit + u.defect + u.model : 0;
  return <div className="card pad" style={{ marginTop: 18 }}>
    <SectionHeader title="คุณภาพข้อมูลจาก CIRA CORE" kicker="จาก mqtt_to_db.py · payload ที่ถูกปฏิเสธ ผลไม้ที่ส่งซ้ำ และค่าที่ระบบไม่รู้จัก" action={<select className="select" style={{ width: 96 }} aria-label="ช่วงเวลา" value={range} onChange={(e) => setRange(e.target.value)}><option value="1h">1 ชม.</option><option value="24h">24 ชม.</option><option value="7d">7 วัน</option></select>} />
    {error && <div className="live-banner error">{error}</div>}
    <div className="summary-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
      <div className="summary-tile"><span>เก็บลง DB</span><strong>{data ? data.stored.toLocaleString() : '-'}</strong></div>
      <div className="summary-tile"><span>ถูกปฏิเสธ (ไม่เก็บ)</span><strong style={{ color: data?.rejected ? '#d3574e' : undefined }}>{data ? data.rejected.toLocaleString() : '-'}</strong></div>
      <div className="summary-tile"><span>ผลไม้ส่งซ้ำ (ทิ้ง)</span><strong>{data ? data.dedup_dropped.toLocaleString() : '-'}</strong><span>run + track_id เดียวกัน</span></div>
      <div className="summary-tile"><span>ค่าที่ไม่รู้จัก (เก็บเป็น NULL)</span><strong style={{ color: unknownTotal ? '#b86f34' : undefined }}>{data ? unknownTotal.toLocaleString() : '-'}</strong>{u && unknownTotal > 0 && <span>{[...u.fruit_values.map((v) => `fruit ${v}`), ...u.defect_values.map((v) => `defect ${v}`), ...u.model_values.map((v) => `model ${v}`)].slice(0, 4).join(', ')}</span>}</div>
    </div>
    {data && data.reasons.length > 0 && <div className="live-defects" style={{ marginBottom: 12 }}>สาเหตุ: {data.reasons.map((r) => <span key={r.reason} className="tag warn">{rejectLabel(r.reason)} {r.n}</span>)}</div>}
    {u && (u.defect_untyped > 0 || u.no_track > 0) && <div className="card-kicker" style={{ marginBottom: 12 }}>{u.defect_untyped > 0 ? `เสียแต่ไม่มี defect_type ${u.defect_untyped.toLocaleString()} ผล · ` : ''}{u.no_track > 0 ? `ไม่มี track_id ${u.no_track.toLocaleString()} ผล (กันนับซ้ำไม่ได้)` : ''}</div>}
    <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>{data?.rejects.length ? <table className="data-table" style={{ minWidth: 0 }}><thead><tr><th>เวลา</th><th>สาเหตุ</th><th>payload (200 ตัวอักษรแรก)</th></tr></thead><tbody>{data.rejects.map((r) => <tr key={r.id}><td>{logDateTime(r.ts)}</td><td><StatusPill tone="warn">{rejectLabel(r.reason)}</StatusPill></td><td style={{ whiteSpace: 'normal', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 10, wordBreak: 'break-all' }}>{r.payload}</td></tr>)}</tbody></table> : <div className="empty">{data ? 'ไม่มี payload ที่ถูกปฏิเสธในช่วงนี้' : 'กำลังโหลด...'}</div>}</div>
  </div>;
}

type UserRow = { id: number; email: string; name: string; role: 'admin' | 'viewer'; active: boolean; created_at: string | null; last_login_at: string | null; acks: number };
function UsersView() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null); const [error, setError] = useState(''); const [toast, setToast] = useState('');
  const [form, setForm] = useState({ name: '', email: '', role: 'viewer', password: '' }); const [formError, setFormError] = useState('');
  const notify = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 2200); };
  const load = () => fetch('/api/users', { cache: 'no-store' }).then(async (r) => { const p = await r.json() as { users: UserRow[]; error?: string }; if (!r.ok) throw new Error(p.error || 'โหลดผู้ใช้ไม่สำเร็จ'); setUsers(p.users); setError(''); }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'));
  useEffect(() => { if (user?.role === 'admin') void load(); }, [user?.role]);
  if (user?.role !== 'admin') return <><PageHeader page="users" /><div className="empty">หน้านี้สำหรับ Admin เท่านั้น</div></>;

  const patch = async (id: number, body: object, message: string) => {
    const response = await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as { error?: string };
    notify(response.ok ? message : payload.error || 'บันทึกไม่สำเร็จ'); void load();
  };
  const resetPassword = (row: UserRow) => {
    const password = window.prompt(`รหัสผ่านใหม่ของ ${row.name} (อย่างน้อย 8 ตัวอักษร)`);
    if (password) void patch(row.id, { password }, 'เปลี่ยนรหัสผ่านแล้ว · ผู้ใช้ถูก logout ทุกเครื่อง');
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setFormError('');
    const response = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
    const payload = await response.json() as { error?: string };
    if (!response.ok) { setFormError(payload.error || 'เพิ่มผู้ใช้ไม่สำเร็จ'); return; }
    setForm({ name: '', email: '', role: 'viewer', password: '' }); notify('เพิ่มผู้ใช้แล้ว'); void load();
  };
  const list = users ?? [];
  return <><PageHeader page="users" />
    {error && <div className="live-banner error" style={{ marginBottom: 14 }}>{error}</div>}
    <div className="metric-grid"><MetricCard label="ผู้ใช้ทั้งหมด" value={list.length} /><MetricCard label="ใช้งานได้" value={list.filter((u) => u.active).length} tone="green" /><MetricCard label="Admin" value={list.filter((u) => u.role === 'admin' && u.active).length} /><MetricCard label="Viewer" value={list.filter((u) => u.role === 'viewer' && u.active).length} /></div>
    <div className="card pad"><SectionHeader title="บัญชีผู้ใช้" kicker="รหัสผ่านเก็บแบบ scrypt hash · ปิดใช้หรือเปลี่ยนรหัสแล้วผู้ใช้ถูก logout ทันที" />
      <div className="table-wrap"><table className="data-table"><thead><tr><th>ผู้ใช้</th><th>อีเมล</th><th>Role</th><th>สถานะ</th><th>เข้าระบบล่าสุด</th><th>รับทราบ alert</th><th /></tr></thead>
        <tbody>{list.map((row) => <tr key={row.id}>
          <td><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><div className="avatar" style={{ width: 28, height: 28, background: row.role === 'admin' ? '#10352a' : '#1aa55c' }}>{initialsOf(row.name)}</div><strong>{row.name}</strong>{row.id === user.id && <span className="tag neutral">คุณ</span>}</div></td>
          <td>{row.email}</td>
          <td><select className="select" style={{ width: 96 }} value={row.role} onChange={(e) => void patch(row.id, { role: e.target.value }, 'เปลี่ยน role แล้ว')}><option value="admin">Admin</option><option value="viewer">Viewer</option></select></td>
          <td><StatusPill tone={row.active ? 'good' : 'neutral'}>{row.active ? 'ใช้งานได้' : 'ปิดใช้'}</StatusPill></td>
          <td>{row.last_login_at ? logDateTime(row.last_login_at) : 'ยังไม่เคย'}</td><td>{row.acks.toLocaleString()}</td>
          <td><div style={{ display: 'flex', gap: 5 }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => resetPassword(row)}>ตั้งรหัสใหม่</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => void patch(row.id, { active: !row.active }, row.active ? 'ปิดใช้แล้ว' : 'เปิดใช้แล้ว')}>{row.active ? 'ปิดใช้' : 'เปิดใช้'}</button></div></td>
        </tr>)}</tbody></table>{!users && !error && <div className="empty">กำลังโหลด...</div>}</div></div>
    <div className="section-grid grid-2" style={{ marginTop: 18, alignItems: 'start' }}>
      <div className="card pad"><SectionHeader title="เพิ่มผู้ใช้" />
        <form onSubmit={(e) => void create(e)}><div className="form-grid">
          <div><label className="form-label">ชื่อ</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label className="form-label">อีเมล</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div><label className="form-label">Role</label><select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="viewer">Viewer</option><option value="admin">Admin</option></select></div>
          <div><label className="form-label">รหัสผ่านเริ่มต้น (≥ 8 ตัว)</label><input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} /></div>
        </div>{formError && <div style={{ color: '#c4564d', fontSize: 11, marginTop: 10 }}>{formError}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}><button className="btn btn-primary" type="submit"><Users size={14} /> เพิ่มผู้ใช้</button></div></form></div>
      <div className="card pad"><SectionHeader title="สิทธิ์ตาม role" /><div className="grid-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="summary-tile"><StatusPill tone="good">Admin</StatusPill><p style={{ color: '#7b8e84', fontSize: 11, lineHeight: 1.5 }}>ทุกอย่างของ Viewer + แก้ alert rules / เวลารายงาน และจัดการผู้ใช้</p></div>
        <div className="summary-tile"><StatusPill tone="neutral">Viewer</StatusPill><p style={{ color: '#7b8e84', fontSize: 11, lineHeight: 1.5 }}>ดูทุกหน้า export CSV ใช้ AI สรุป และกดรับทราบ alert (บันทึกชื่อผู้รับทราบ)</p></div>
      </div></div>
    </div>
    {toast && <div className="toast"><Check size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} />{toast}</div>}
  </>;
}

function MyTeamView() {
  const members = [
    { letter: 'A', order: '01', tone: 'data', name: 'วุฒิไกร แย้มพุ่ม', studentId: '66085721', section: '1', focus: 'Dataset / Labeling', detail: 'จัดเตรียมชุดข้อมูลและทำ Labeling ให้พร้อมสำหรับการเทรน', image: '/images/team-data.jpg' },
    { letter: 'B', order: '02', tone: 'training', name: 'ธาริณี สนิทสตรี', studentId: '66083156', section: '2', focus: 'Training (CIRA CORE)', detail: 'ฝึกและพัฒนาโมเดลสำหรับการตรวจจับผลไม้และตำหนิ', image: '/images/team-training.jpg' },
    { letter: 'C', order: '03', tone: 'realtime', name: 'ณัฐกฤษณ์ เบ้าสาลี', studentId: '66066780', section: '1', focus: 'Coding & Functions', detail: 'พัฒนาฟังก์ชันและโค้ดที่เชื่อมการทำงานของระบบ', image: '/images/team-realtime.jpg' },
    { letter: 'D', order: '04', tone: 'platform', name: 'ศรัณย์ภัทร ตรีเพียร', studentId: '66044768', section: '2', focus: 'Platform & Dashboard', detail: 'ออกแบบแพลตฟอร์มและ Dashboard สำหรับติดตามระบบ', image: '/images/team-platform.jpg' },
  ];
  return <><PageHeader page="myteam" /><section className="team-hero"><div className="team-hero-copy"><span className="team-kicker">CIRA CORE PROJECT</span><h2>Fruit Defect<br />Detection Engine</h2><p>ทีมของเราร่วมกันสร้างระบบคัดแยกผลไม้ให้แม่นยำ เชื่อถือได้ และพร้อมใช้งานจริง</p><div className="team-hero-meta"><span>04 สมาชิก</span><i /> <span>Vision · Sort · Trust</span></div></div><div className="team-hero-logo-wrap"><div className="team-logo-glow" /><img className="team-hero-logo" src="/images/cira-core-logo.png" alt="Fruit Defect Detection Engine logo" /></div></section><section className="team-grid">{members.map((member) => <article className={`team-member-card team-tone-${member.tone}`} key={member.order}><div className="team-card-top"><span className="team-letter">{member.letter}</span><span className="team-order">{member.order}</span><img className="team-member-photo" src={member.image} alt={`รูปของ ${member.name}`} /></div><div className="team-student-id"><span>รหัสนักศึกษา</span><strong>{member.studentId}</strong></div><div className="team-field-label">ชื่อ–นามสกุล</div><div className="team-member-name">{member.name}</div><div className="team-field-label team-role-label">หน้าที่ของแต่ละคนในทีม</div><div className="team-member-focus">{member.focus}</div><p>{member.detail}</p><div className="team-card-divider" /><div className="team-card-details"><div><span>Section / กลุ่มเรียน</span><strong>{member.section}</strong></div></div></article>)}</section></>;
}

function LoginView({ setupRequired, onSignedIn }: { setupRequired: boolean; onSignedIn: (user: AuthUser) => void }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<{ label: string; email: string; password: string; role: string }[]>([]);
  useEffect(() => {
    if (setupRequired) return;
    fetch('/api/auth/demo', { cache: 'no-store' }).then((r) => r.json()).then((p: { accounts?: typeof demo }) => {
      const accounts = p.accounts ?? [];
      setDemo(accounts);
      if (accounts[0]) { setEmail(accounts[0].email); setPassword(accounts[0].password); }
    }).catch(() => undefined);
  }, [setupRequired]);
  const pickDemo = (value: string) => { const account = demo.find((a) => a.email === value); setEmail(account?.email ?? ''); setPassword(account?.password ?? ''); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const response = await fetch(setupRequired ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(setupRequired ? { name, email, password } : { email, password }) });
      const payload = await response.json() as { user?: AuthUser; error?: string };
      if (!response.ok || !payload.user) throw new Error(payload.error || 'เข้าสู่ระบบไม่สำเร็จ');
      onSignedIn(payload.user);
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : 'เข้าสู่ระบบไม่สำเร็จ'); } finally { setBusy(false); }
  };
  return <div className="login-page"><div className="card login-card"><div className="login-logo"><Logo compact /><div><div className="brand-name">Fruit Defect Detection</div><span className="brand-sub">ENGINE BY CIRA CORE</span></div></div>
    <h1>{setupRequired ? 'ตั้งค่าบัญชี Admin แรก' : 'ยินดีต้อนรับกลับ'}</h1>
    <p>{setupRequired ? 'ยังไม่มีผู้ใช้ในระบบ บัญชีนี้จะเป็น Admin และเพิ่มผู้ใช้คนอื่นได้ในหน้า Users' : 'เข้าสู่ระบบเพื่อดูสถานะไลน์คัดแยกผลไม้'}</p>
    <form className="login-form" onSubmit={(e) => void submit(e)}>
      {demo.length > 0 && <div><label className="form-label">บัญชี demo</label><select className="select" style={{ width: '100%' }} value={demo.some((a) => a.email === email) ? email : ''} onChange={(e) => pickDemo(e.target.value)}>{demo.map((a) => <option key={a.email} value={a.email}>{a.label} · {a.email}</option>)}<option value="">กรอกเอง</option></select></div>}
      {setupRequired && <div><label className="form-label">ชื่อที่แสดง</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></div>}
      <div><label className="form-label">อีเมล</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></div>
      <div><label className="form-label">รหัสผ่าน{setupRequired ? ' (อย่างน้อย 8 ตัวอักษร)' : ''}</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} required minLength={setupRequired ? 8 : undefined} /></div>
      {error && <div style={{ color: '#c4564d', fontSize: 11 }}>{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy}><LogIn size={14} /> {busy ? 'กำลังตรวจสอบ...' : setupRequired ? 'สร้างบัญชีและเข้าสู่ระบบ' : 'เข้าสู่ Control Room'}</button>
    </form>
    <div className="login-demo">{setupRequired ? 'หน้านี้แสดงเฉพาะตอนยังไม่มีผู้ใช้' : 'ลืมรหัสผ่าน: ให้ Admin ตั้งรหัสใหม่ในหน้า Users'}</div></div></div>;
}

function NotFoundView() { return <div className="login-page"><div className="card login-card"><div className="login-logo"><Logo compact /><div><div className="brand-name">CIRA CORE</div><span className="brand-sub">EDGE CONTROL ROOM</span></div></div><h1>ไม่พบหน้านี้</h1><p>เส้นทางที่เรียกไม่มีอยู่ใน Dashboard</p><a className="btn btn-primary" href="/simulate"><Activity size={14} /> กลับไปหน้า Live</a></div></div>; }

export default function DashboardPage() {
  const pathname = usePathname(); const router = useRouter(); const [mobileOpen, setMobileOpen] = useState(false);
  const [auth, setAuth] = useState<{ checked: boolean; user: AuthUser | null; setupRequired: boolean; error: string }>({ checked: false, user: null, setupRequired: false, error: '' });
  const checkAuth = async () => {
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      const payload = await response.json() as { user?: AuthUser | null; setup_required?: boolean; error?: string };
      if (response.status === 503) throw new Error(payload.error || 'ฐานข้อมูลไม่พร้อม');
      setAuth({ checked: true, user: payload.user ?? null, setupRequired: Boolean(payload.setup_required), error: '' });
    } catch (authError) { setAuth({ checked: true, user: null, setupRequired: false, error: authError instanceof Error ? authError.message : 'ตรวจสอบการเข้าสู่ระบบไม่สำเร็จ' }); }
  };
  useEffect(() => { void checkAuth(); }, []);
  // Session expired / revoked while a page is open: any API answering 401 sends the browser to login.
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].pathname : args[0].url;
      if (response.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) setAuth((current) => current.user ? { ...current, user: null } : current);
      return response;
    };
    return () => { window.fetch = original; };
  }, []);
  const logout = async () => { await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined); setAuth((current) => ({ ...current, user: null })); router.replace('/login'); };

  const path = pathname === '/' ? 'simulate' : pathname.split('/')[1] || 'simulate';
  const known = navItems.some((item) => item.key === path) || path === 'login' || pathname === '/';
  const page = (navItems.some((item) => item.key === path) ? path : path === 'login' ? 'login' : 'simulate') as PageKey;
  useEffect(() => {
    if (!auth.checked) return;
    if (!auth.user && page !== 'login') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (auth.user && page === 'login') {
      const next = new URLSearchParams(window.location.search).get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/simulate');
    }
  }, [auth.checked, auth.user, page, pathname, router]);

  if (!known) return <NotFoundView />;
  if (!auth.checked) return <div className="login-page"><div className="empty">กำลังตรวจสอบการเข้าสู่ระบบ...</div></div>;
  if (auth.error) return <div className="login-page"><div className="card login-card"><h1>เชื่อมต่อระบบไม่ได้</h1><p>{auth.error}</p><button type="button" className="btn btn-primary" onClick={() => void checkAuth()}><RefreshCcw size={14} /> ลองใหม่</button></div></div>;
  if (!auth.user) return page === 'login' ? <LoginView setupRequired={auth.setupRequired} onSignedIn={(user) => setAuth({ checked: true, user, setupRequired: false, error: '' })} /> : <div className="login-page"><div className="empty">กำลังไปหน้าเข้าสู่ระบบ...</div></div>;
  if (page === 'login') return <div className="login-page"><div className="empty">เข้าสู่ระบบแล้ว...</div></div>;
  return <AuthContext.Provider value={{ user: auth.user, logout: () => void logout() }}><Shell current={page} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen}><main className="page-wrap">{page === 'simulate' && <SimulateView />}{page === 'logs' && <LogsView />}{page === 'runs' && <RunsView />}{page === 'alerts' && <AlertsView />}{page === 'system' && <SystemView />}{page === 'profiles' && <ProfilesView />}{page === 'users' && <UsersView />}{page === 'myteam' && <MyTeamView />}</main></Shell></AuthContext.Provider>;
}
