INSERT INTO defect_types (code, name_th, name_en, name_zh) VALUES
('bruise','ช้ำ','Bruise','瘀伤'),
('rot','เน่า','Rot','腐烂'),
('crack','แตก','Crack','裂纹')
ON CONFLICT (code) DO NOTHING;
