-- 运行位置 (decision 2026-11-02-2330, Alex): 云端 is the default and means the
-- person's own E2B cloud, then their servers, then their computers. Every
-- stored row still held the old default 本地, which no one could be told to
-- have picked, so each moves to 云端; 本地 is one switch away in 模型与订阅.
ALTER TABLE model_order_settings ALTER COLUMN location SET DEFAULT 'cloud';
UPDATE model_order_settings SET location = 'cloud', "updatedAt" = now() WHERE location = 'local';
