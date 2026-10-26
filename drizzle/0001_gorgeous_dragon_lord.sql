CREATE TABLE `storybank_audio` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`object_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	`status` text NOT NULL,
	`upload_complete` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_id`, `id`),
	CONSTRAINT "audio_size_bounded" CHECK("storybank_audio"."size" > 0 AND "storybank_audio"."size" <= 10485760),
	CONSTRAINT "audio_status" CHECK("storybank_audio"."status" IN ('uploading','active','deleting')),
	CONSTRAINT "audio_upload_complete" CHECK("storybank_audio"."upload_complete" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storybank_audio_object_key_unique` ON `storybank_audio` (`object_key`);