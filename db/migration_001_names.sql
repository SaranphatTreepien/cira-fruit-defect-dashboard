ALTER TABLE fruit_types ADD COLUMN name_en TEXT, ADD COLUMN name_zh TEXT;
ALTER TABLE defect_types ADD COLUMN name_en TEXT, ADD COLUMN name_zh TEXT;
UPDATE fruit_types SET name_en='Apple', name_zh='苹果' WHERE code='apple';
UPDATE fruit_types SET name_en='Orange', name_zh='橙子' WHERE code='orange';
