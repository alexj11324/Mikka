-- 线程完成 pushes are on by default, to the desktop app and the phone
-- (Alex, 2026-10-31, docs/design/decisions.md). Every stored false becomes
-- true: a save writes every preference at once, so a stored false cannot be
-- told apart from the old default. Each member can still turn it off.
UPDATE user_preferences SET "pushFinished" = true, "updatedAt" = now() WHERE "pushFinished" = false;
ALTER TABLE user_preferences ALTER COLUMN "pushFinished" SET DEFAULT true;
