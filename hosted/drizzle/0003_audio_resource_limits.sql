-- Application-selected public-tester budgets, not provider or paid-plan quotas.
-- All sizes are bytes. The fixed upload-attempt window is 600 UTC seconds.
-- Keep limits in one durable row so all Worker instances enforce the same policy.
CREATE TABLE `storybank_audio_policy` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `owner_max_bytes` integer NOT NULL CHECK (typeof(`owner_max_bytes`) = 'integer' AND `owner_max_bytes` BETWEEN 1 AND 9007199254740991),
  `owner_max_objects` integer NOT NULL CHECK (typeof(`owner_max_objects`) = 'integer' AND `owner_max_objects` BETWEEN 1 AND 1000000),
  `project_max_bytes` integer NOT NULL CHECK (typeof(`project_max_bytes`) = 'integer' AND `project_max_bytes` BETWEEN 1 AND 9007199254740991),
  `project_max_objects` integer NOT NULL CHECK (typeof(`project_max_objects`) = 'integer' AND `project_max_objects` BETWEEN 1 AND 1000000),
  `owner_window_attempts` integer NOT NULL CHECK (typeof(`owner_window_attempts`) = 'integer' AND `owner_window_attempts` BETWEEN 1 AND 1000000),
  `project_window_attempts` integer NOT NULL CHECK (typeof(`project_window_attempts`) = 'integer' AND `project_window_attempts` BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
INSERT INTO `storybank_audio_policy` VALUES (1, 52428800, 20, 524288000, 200, 12, 120);
--> statement-breakpoint
CREATE TABLE `storybank_audio_rate` (
  `scope` text NOT NULL CHECK (`scope` IN ('owner', 'project')),
  `subject` text NOT NULL,
  `window_start` integer NOT NULL CHECK (typeof(`window_start`) = 'integer' AND `window_start` >= 0 AND `window_start` % 600 = 0),
  `attempts` integer NOT NULL CHECK (typeof(`attempts`) = 'integer' AND `attempts` > 0),
  PRIMARY KEY (`scope`, `subject`),
  CHECK (`scope` = 'owner' OR `subject` = '')
);
--> statement-breakpoint
-- The insert and all trigger effects are one SQLite/D1 statement transaction.
-- Count EVERY reservation, including uploading/deleting/uncertain rows. No age
-- based expiry is safe: a late R2 put could still create an object after expiry.
CREATE TRIGGER audio_reserve_budget BEFORE INSERT ON storybank_audio
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM storybank_audio_policy WHERE id = 1)
    THEN RAISE(ABORT, 'STORYBANK_AUDIO_POLICY_MISSING') END;
  SELECT CASE WHEN
    (SELECT count(*) FROM storybank_audio WHERE owner_id = NEW.owner_id) >= (SELECT owner_max_objects FROM storybank_audio_policy WHERE id = 1)
    OR NEW.size > (SELECT owner_max_bytes FROM storybank_audio_policy WHERE id = 1) - (SELECT coalesce(sum(size), 0) FROM storybank_audio WHERE owner_id = NEW.owner_id)
    THEN RAISE(ABORT, 'STORYBANK_AUDIO_OWNER_QUOTA') END;
  SELECT CASE WHEN
    (SELECT count(*) FROM storybank_audio) >= (SELECT project_max_objects FROM storybank_audio_policy WHERE id = 1)
    OR NEW.size > (SELECT project_max_bytes FROM storybank_audio_policy WHERE id = 1) - (SELECT coalesce(sum(size), 0) FROM storybank_audio)
    THEN RAISE(ABORT, 'STORYBANK_AUDIO_PROJECT_QUOTA') END;
  SELECT CASE WHEN
    coalesce((SELECT attempts FROM storybank_audio_rate WHERE scope = 'owner' AND subject = NEW.owner_id AND window_start >= CAST(unixepoch() / 600 AS INTEGER) * 600), 0) >= (SELECT owner_window_attempts FROM storybank_audio_policy WHERE id = 1)
    OR coalesce((SELECT attempts FROM storybank_audio_rate WHERE scope = 'project' AND subject = '' AND window_start >= CAST(unixepoch() / 600 AS INTEGER) * 600), 0) >= (SELECT project_window_attempts FROM storybank_audio_policy WHERE id = 1)
    THEN RAISE(ABORT, 'STORYBANK_AUDIO_RATE_LIMIT') END;
END;
--> statement-breakpoint
-- The current-window owner rows are bounded by admitted project attempts.
-- Prune expired counters only, never storage reservations. Deleted recordings
-- do not refund attempts. A clock moving backwards does not reset the budget.
CREATE TRIGGER audio_charge_attempt AFTER INSERT ON storybank_audio
BEGIN
  DELETE FROM storybank_audio_rate WHERE window_start < CAST(unixepoch() / 600 AS INTEGER) * 600;
  INSERT INTO storybank_audio_rate (scope, subject, window_start, attempts)
    VALUES ('owner', NEW.owner_id, CAST(unixepoch() / 600 AS INTEGER) * 600, 1)
    ON CONFLICT (scope, subject) DO UPDATE SET attempts = attempts + 1;
  INSERT INTO storybank_audio_rate (scope, subject, window_start, attempts)
    VALUES ('project', '', CAST(unixepoch() / 600 AS INTEGER) * 600, 1)
    ON CONFLICT (scope, subject) DO UPDATE SET attempts = attempts + 1;
END;
--> statement-breakpoint
-- Reservations may shrink to their actual size, never grow or change owner.
CREATE TRIGGER audio_reservation_immutable BEFORE UPDATE OF owner_id, size ON storybank_audio
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.size > OLD.size
BEGIN SELECT RAISE(ABORT, 'STORYBANK_AUDIO_RESERVATION_IMMUTABLE'); END;
