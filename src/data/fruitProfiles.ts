import type { FruitProfile } from './mockData';

export const fruitProfiles: FruitProfile[] = [
  { id: 'orange', fruit_type: 'ส้ม', emoji: '🍊', color: '#FF8A24', threshold: 62, nirSupported: true, nirParams: 'Moisture 0.42 · NIR-850', beltSpeed: 68, enabled: true, note: 'อ่านผิวและเนื้อในได้' },
  { id: 'apple', fruit_type: 'แอปเปิล', emoji: '🍎', color: '#E75C58', threshold: 58, nirSupported: true, nirParams: 'Density 0.78 · NIR-940', beltSpeed: 54, enabled: true, note: 'อ่านผิวและเนื้อในได้' },
  { id: 'banana', fruit_type: 'กล้วย', emoji: '🍌', color: '#D8A400', threshold: 70, nirSupported: false, nirParams: '—', beltSpeed: 46, enabled: true, note: 'ตรวจภายนอกเท่านั้น' },
];
