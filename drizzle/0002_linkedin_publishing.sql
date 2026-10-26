CREATE TABLE `storybank_linkedin_connections` (
	`owner_user_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`client_id` text NOT NULL,
	`subject` text NOT NULL,
	`person_urn` text NOT NULL,
	`display_name` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`expires_at` integer NOT NULL,
	`scopes` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storybank_linkedin_connections_connection_id_unique` ON `storybank_linkedin_connections` (`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `linkedin_client_subject` ON `storybank_linkedin_connections` (`client_id`,`subject`);--> statement-breakpoint
CREATE TABLE `storybank_linkedin_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`story_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`source_approval_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`due_at` integer NOT NULL,
	`time_zone` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`post_urn` text,
	`lease_id` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT "linkedin_snapshot_json" CHECK(json_valid("storybank_linkedin_jobs"."snapshot")),
	CONSTRAINT "linkedin_job_status" CHECK("storybank_linkedin_jobs"."status" IN ('queued','sending','published','unknown','rejected','cancelled')),
	CONSTRAINT "linkedin_attempts" CHECK("storybank_linkedin_jobs"."attempts" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linkedin_owner_idempotency` ON `storybank_linkedin_jobs` (`owner_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `linkedin_owner_approval` ON `storybank_linkedin_jobs` (`owner_user_id`,`source_approval_id`);--> statement-breakpoint
CREATE INDEX `linkedin_jobs_due` ON `storybank_linkedin_jobs` (`status`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `linkedin_content_dedup` ON `storybank_linkedin_jobs` (`owner_user_id`,`content_hash`) WHERE "storybank_linkedin_jobs"."status" IN ('queued','sending','published','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX `linkedin_one_dispatch_per_owner` ON `storybank_linkedin_jobs` (`owner_user_id`) WHERE "storybank_linkedin_jobs"."status" = 'sending';--> statement-breakpoint
CREATE TABLE `storybank_linkedin_oauth` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`cookie_hash` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`verifier_ciphertext` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linkedin_oauth_owner` ON `storybank_linkedin_oauth` (`owner_user_id`);
--> statement-breakpoint
CREATE TRIGGER linkedin_lock_workspace_update BEFORE UPDATE ON storybank_personal_workspaces
WHEN EXISTS (SELECT 1 FROM storybank_linkedin_jobs WHERE owner_user_id = OLD.owner_user_id AND status = 'sending')
BEGIN SELECT RAISE(ABORT, 'STORYBANK_PUBLISH_IN_FLIGHT'); END;
--> statement-breakpoint
CREATE TRIGGER linkedin_lock_workspace_delete BEFORE DELETE ON storybank_personal_workspaces
WHEN EXISTS (SELECT 1 FROM storybank_linkedin_jobs WHERE owner_user_id = OLD.owner_user_id AND status = 'sending')
BEGIN SELECT RAISE(ABORT, 'STORYBANK_PUBLISH_IN_FLIGHT'); END;
--> statement-breakpoint
CREATE TRIGGER linkedin_invalidate_changed_stories AFTER UPDATE ON storybank_personal_workspaces
BEGIN
  UPDATE storybank_linkedin_jobs SET status = 'cancelled', reason = 'story_or_approval_changed', finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE owner_user_id = NEW.owner_user_id AND status = 'queued' AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.payload, '$.collections.stories') s
    WHERE json_extract(s.value, '$[1].id') = storybank_linkedin_jobs.story_id
      AND json_extract(s.value, '$[1].revision') = storybank_linkedin_jobs.source_revision
      AND json_extract(s.value, '$[1].activeApprovalId') = storybank_linkedin_jobs.source_approval_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER linkedin_lock_connection_update BEFORE UPDATE ON storybank_linkedin_connections
WHEN EXISTS (SELECT 1 FROM storybank_linkedin_jobs WHERE owner_user_id = OLD.owner_user_id AND status = 'sending')
BEGIN SELECT RAISE(ABORT, 'STORYBANK_PUBLISH_IN_FLIGHT'); END;
--> statement-breakpoint
CREATE TRIGGER linkedin_lock_connection_delete BEFORE DELETE ON storybank_linkedin_connections
WHEN EXISTS (SELECT 1 FROM storybank_linkedin_jobs WHERE owner_user_id = OLD.owner_user_id AND status = 'sending')
BEGIN SELECT RAISE(ABORT, 'STORYBANK_PUBLISH_IN_FLIGHT'); END;
--> statement-breakpoint
CREATE TRIGGER linkedin_cancel_reconnected_jobs AFTER UPDATE ON storybank_linkedin_connections
BEGIN
  UPDATE storybank_linkedin_jobs SET status = 'cancelled', reason = 'connection_changed', finished_at = NEW.updated_at
  WHERE owner_user_id = NEW.owner_user_id AND status = 'queued' AND connection_id != NEW.connection_id;
END;
--> statement-breakpoint
CREATE TRIGGER linkedin_cancel_disconnected_jobs AFTER DELETE ON storybank_linkedin_connections
BEGIN
  UPDATE storybank_linkedin_jobs SET status = 'cancelled', reason = 'disconnected', finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE owner_user_id = OLD.owner_user_id AND status = 'queued';
END;
--> statement-breakpoint
CREATE TRIGGER linkedin_erase_deleted_workspace AFTER UPDATE ON storybank_personal_workspaces
WHEN json_extract(NEW.payload, '$.audit[#-1].type') = 'privacy.deleted'
 AND json_extract(NEW.payload, '$.audit[#-1].id') IS NOT json_extract(OLD.payload, '$.audit[#-1].id')
BEGIN
  DELETE FROM storybank_linkedin_oauth WHERE owner_user_id = NEW.owner_user_id;
  DELETE FROM storybank_linkedin_connections WHERE owner_user_id = NEW.owner_user_id;
  DELETE FROM storybank_linkedin_jobs WHERE owner_user_id = NEW.owner_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER linkedin_erase_removed_workspace AFTER DELETE ON storybank_personal_workspaces
BEGIN
  DELETE FROM storybank_linkedin_oauth WHERE owner_user_id = OLD.owner_user_id;
  DELETE FROM storybank_linkedin_connections WHERE owner_user_id = OLD.owner_user_id;
  DELETE FROM storybank_linkedin_jobs WHERE owner_user_id = OLD.owner_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER linkedin_erase_initially_deleted_workspace AFTER INSERT ON storybank_personal_workspaces
WHEN json_extract(NEW.payload, '$.audit[#-1].type') = 'privacy.deleted'
BEGIN
  DELETE FROM storybank_linkedin_oauth WHERE owner_user_id = NEW.owner_user_id;
  DELETE FROM storybank_linkedin_connections WHERE owner_user_id = NEW.owner_user_id;
  DELETE FROM storybank_linkedin_jobs WHERE owner_user_id = NEW.owner_user_id;
END;
