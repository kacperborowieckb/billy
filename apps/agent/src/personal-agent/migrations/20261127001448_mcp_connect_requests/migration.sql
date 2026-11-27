CREATE TABLE `mcp_connect_requests` (
	`event_id` text NOT NULL,
	`catalog_id` text NOT NULL,
	CONSTRAINT `mcp_connect_requests_pk` PRIMARY KEY(`event_id`, `catalog_id`)
);
