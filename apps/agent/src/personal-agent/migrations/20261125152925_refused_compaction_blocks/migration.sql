CREATE TABLE `refused_compaction_blocks` (
	`slot` integer PRIMARY KEY,
	`last_compacted_sequence` integer NOT NULL,
	`refused_at` text NOT NULL,
	CONSTRAINT "refused_compaction_blocks_one_row" CHECK("slot" = 0)
);
