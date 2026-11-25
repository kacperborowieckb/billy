DROP TRIGGER turn_traces_no_update;
--> statement-breakpoint
DROP TRIGGER turn_traces_no_delete;
--> statement-breakpoint
UPDATE turn_traces
SET record = json_set(
  json_remove(record, '$.system', '$.messages'),
  '$.request',
  json_object(
    'kind', 'copy',
    'system', json_extract(record, '$.system'),
    'messages', json(json_extract(record, '$.messages'))
  )
)
WHERE json_type(record, '$.system') = 'text';
--> statement-breakpoint
CREATE TRIGGER turn_traces_no_update
BEFORE UPDATE ON turn_traces
BEGIN SELECT RAISE(ABORT, 'Traces are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER turn_traces_no_recent_delete
BEFORE DELETE ON turn_traces
WHEN OLD.recorded_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
BEGIN SELECT RAISE(ABORT, 'Traces newer than the retention floor cannot be deleted'); END;
