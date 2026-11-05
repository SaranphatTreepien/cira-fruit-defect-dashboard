export type FruitType = 'ส้ม' | 'แอปเปิล' | 'กล้วย' | 'แก้วมังกร';
export type ExternalResult = 'ดี' | 'เสีย';
export type DefectType = 'รอยตำหนิ' | 'สีผิดปกติ-จุดด่าง' | 'รูปร่างบิดเบี้ยว' | 'เสียหาย-เน่า' | null;
export type NirResult = 'ปกติ' | 'เสียภายใน' | 'ไม่รองรับ';
export type CameraView = 'มุมบน' | 'มุมข้าง';

export type FruitEvent = {
  fruit_id: string;
  timestamp: string;
  fruit_type: FruitType;
  external_result: ExternalResult;
  defect_type: DefectType;
  nir_result: NirResult;
  type_mismatch: boolean;
  confidence: number;
  camera_view: CameraView;
};

export type FruitProfile = {
  id: string;
  fruit_type: FruitType;
  emoji: string;
  color: string;
  threshold: number;
  nirSupported: boolean;
  nirParams: string;
  beltSpeed: number;
  enabled: boolean;
  note: string;
};

export type AlertItem = {
  id: string;
  level: 'ข้อมูล' | 'เตือน' | 'วิกฤต';
  title: string;
  detail: string;
  time: string;
  status: 'ใหม่' | 'รับทราบแล้ว';
  channel: 'LINE' | 'Telegram' | 'ระบบ';
};

export { fruitProfiles } from './fruitProfiles';

export const mockFruitEvents: FruitEvent[] = [
  { fruit_id: 'FR-24081', timestamp: '10:42:18', fruit_type: 'ส้ม', external_result: 'ดี', defect_type: null, nir_result: 'ปกติ', type_mismatch: false, confidence: 98.2, camera_view: 'มุมบน' },
  { fruit_id: 'FR-24080', timestamp: '10:42:14', fruit_type: 'แอปเปิล', external_result: 'เสีย', defect_type: 'สีผิดปกติ-จุดด่าง', nir_result: 'ปกติ', type_mismatch: false, confidence: 94.6, camera_view: 'มุมข้าง' },
  { fruit_id: 'FR-24079', timestamp: '10:42:11', fruit_type: 'กล้วย', external_result: 'ดี', defect_type: null, nir_result: 'ไม่รองรับ', type_mismatch: false, confidence: 96.8, camera_view: 'มุมบน' },
  { fruit_id: 'FR-24078', timestamp: '10:42:07', fruit_type: 'ส้ม', external_result: 'เสีย', defect_type: 'รอยตำหนิ', nir_result: 'เสียภายใน', type_mismatch: false, confidence: 91.4, camera_view: 'มุมบน' },
  { fruit_id: 'FR-24077', timestamp: '10:42:03', fruit_type: 'แอปเปิล', external_result: 'ดี', defect_type: null, nir_result: 'ปกติ', type_mismatch: false, confidence: 97.7, camera_view: 'มุมข้าง' },
  { fruit_id: 'FR-24076', timestamp: '10:41:58', fruit_type: 'กล้วย', external_result: 'เสีย', defect_type: 'รูปร่างบิดเบี้ยว', nir_result: 'ไม่รองรับ', type_mismatch: false, confidence: 93.1, camera_view: 'มุมบน' },
  { fruit_id: 'FR-24075', timestamp: '10:41:54', fruit_type: 'ส้ม', external_result: 'ดี', defect_type: null, nir_result: 'ปกติ', type_mismatch: false, confidence: 99.1, camera_view: 'มุมข้าง' },
  { fruit_id: 'FR-24074', timestamp: '10:41:50', fruit_type: 'แอปเปิล', external_result: 'เสีย', defect_type: 'เสียหาย-เน่า', nir_result: 'เสียภายใน', type_mismatch: false, confidence: 88.9, camera_view: 'มุมบน' },
  { fruit_id: 'FR-24073', timestamp: '10:41:46', fruit_type: 'ส้ม', external_result: 'ดี', defect_type: null, nir_result: 'ปกติ', type_mismatch: false, confidence: 98.4, camera_view: 'มุมบน' },
  { fruit_id: 'FR-24072', timestamp: '10:41:42', fruit_type: 'กล้วย', external_result: 'ดี', defect_type: null, nir_result: 'ไม่รองรับ', type_mismatch: false, confidence: 95.8, camera_view: 'มุมข้าง' },
];

export const mockAlerts: AlertItem[] = [
  { id: 'AL-104', level: 'วิกฤต', title: 'หยุดเครื่องเพราะผิดชนิด', detail: 'พบกล้วย 3 ผลในโหมดล็อกชนิดแอปเปิล', time: '10:36:21', status: 'ใหม่', channel: 'LINE' },
  { id: 'AL-103', level: 'เตือน', title: 'อัตราเสียภายในสูงขึ้น', detail: 'Apple สูงกว่า baseline 6.4% ในช่วง 10 นาทีล่าสุด', time: '10:31:08', status: 'ใหม่', channel: 'Telegram' },
  { id: 'AL-102', level: 'ข้อมูล', title: 'ซิงก์ข้อมูลกลับสำเร็จ', detail: 'ส่งข้อมูลค้างรอ 24 รายการไปยัง edge queue แล้ว', time: '10:24:52', status: 'รับทราบแล้ว', channel: 'ระบบ' },
  { id: 'AL-101', level: 'เตือน', title: 'ตะกร้าเสียภายนอกใกล้เต็ม', detail: 'ความจุ 82% · แนะนำให้เปลี่ยนตะกร้าใน 12 นาที', time: '10:18:44', status: 'รับทราบแล้ว', channel: 'LINE' },
  { id: 'AL-100', level: 'ข้อมูล', title: 'เริ่มกะการผลิตใหม่', detail: 'Operator: Narin P. · Profile: Auto mode', time: '09:00:02', status: 'รับทราบแล้ว', channel: 'ระบบ' },
];

export const mockDevices = [
  { name: 'Camera · มุมบน', type: 'Vision / CIRA CORE', status: 'พร้อมใช้งาน', tone: 'good', latency: '24 ms', lastSeen: 'เมื่อ 3 วินาทีที่แล้ว', icon: 'camera' },
  { name: 'Camera · มุมข้าง', type: 'Vision / CIRA CORE', status: 'พร้อมใช้งาน', tone: 'good', latency: '28 ms', lastSeen: 'เมื่อ 3 วินาทีที่แล้ว', icon: 'camera' },
  { name: 'IR sensor', type: 'นับจำนวนผลไม้', status: 'พร้อมใช้งาน', tone: 'good', latency: '8 ms', lastSeen: 'เมื่อ 1 วินาทีที่แล้ว', icon: 'ir' },
  { name: 'NIR sensor', type: 'ตรวจสภาพภายใน', status: 'ตอบสนองช้า', tone: 'warn', latency: '184 ms', lastSeen: 'เมื่อ 12 วินาทีที่แล้ว', icon: 'nir' },
  { name: 'OLED display', type: 'สถานะหน้าเครื่อง', status: 'พร้อมใช้งาน', tone: 'good', latency: '—', lastSeen: 'เมื่อ 1 นาทีที่แล้ว', icon: 'oled' },
  { name: 'Servo gate', type: 'แขนคัดแยก', status: 'พร้อมใช้งาน', tone: 'good', latency: '12 ms', lastSeen: 'เมื่อ 2 วินาทีที่แล้ว', icon: 'servo' },
] as const;

export const mockUsers = [
  { id: 'USR-001', name: 'Narin Phongchai', initials: 'NP', email: 'narin@ciracore.ai', role: 'Admin', status: 'Active', lastSeen: 'ตอนนี้' },
  { id: 'USR-002', name: 'Mali Suthida', initials: 'MS', email: 'mali@ciracore.ai', role: 'Operator', status: 'Active', lastSeen: '8 นาทีที่แล้ว' },
  { id: 'USR-003', name: 'Krit S.', initials: 'KS', email: 'krit@ciracore.ai', role: 'Viewer', status: 'Active', lastSeen: '1 ชั่วโมงที่แล้ว' },
  { id: 'USR-004', name: 'Ploy N.', initials: 'PN', email: 'ploy@ciracore.ai', role: 'Viewer', status: 'Inactive', lastSeen: '3 วันที่แล้ว' },
] as const;

export const aiAnswers: Record<string, string> = {
  'สรุปวันนี้': 'วันนี้ระบบคัดแยกแล้ว 1,284 ผล อัตราผ่าน 92.4% และพบเสียภายใน 3.6% โดยแอปเปิลมี defect สูงสุดในช่วง 10:00–10:30 น.',
  'ทำไมอัตราเสียสูงขึ้น': 'อัตราเสียเพิ่มจากจุดด่างบนแอปเปิลล็อต A-17 และ NIR response ช้าชั่วคราว แนะนำตรวจแสงบริเวณ Camera มุมข้างและ recalibrate NIR sensor.',
  'คาดการณ์สัปดาห์หน้า': 'หาก throughput คงที่ คาดว่าจะคัดแยกประมาณ 8,900 ผล อัตราเสียรวมอยู่ที่ 7.1–7.8% และควรเผื่อ capacity ตะกร้าเสียภายนอกเพิ่ม 1 ใบ.',
  'ชนิดไหนเสียภายในมากที่สุด': 'แอปเปิลมี internal defect สูงสุดที่ 5.8% รองลงมาคือส้ม 2.9% ส่วนกล้วยยังไม่รองรับ NIR จึงยังไม่มีข้อมูลภายใน.',
  'ช่วงไหนมีผลไม้ผิดชนิดปนเข้ามา': 'พบ mismatch มากที่สุดระหว่าง 10:30–10:40 น. รวม 3 ผล คาดว่าเกิดจากการเปลี่ยนล็อตผลไม้โดยไม่ได้สลับเป็น Automatic mode.',
};

export const defectOptions = ['ทั้งหมด', 'รอยตำหนิ', 'สีผิดปกติ-จุดด่าง', 'รูปร่างบิดเบี้ยว', 'เสียหาย-เน่า'];
export const fruitOptions: FruitType[] = ['ส้ม', 'แอปเปิล', 'กล้วย', 'แก้วมังกร'];
