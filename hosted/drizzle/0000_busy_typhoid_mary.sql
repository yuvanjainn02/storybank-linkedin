CREATE TABLE `storybank_personal_workspaces` (
	`tenant_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `owner_user_id`),
	CONSTRAINT "revision_positive" CHECK("storybank_personal_workspaces"."revision" >= 1),
	CONSTRAINT "payload_json" CHECK(json_valid("storybank_personal_workspaces"."payload"))
);
