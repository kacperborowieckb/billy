DELETE FROM conversation_messages
WHERE kind IN ('step', 'reply')
  AND compacted_at IS NULL
  AND json_extract(message, '$.role') = 'assistant'
  AND json_type(message, '$.content') = 'text'
  AND trim(json_extract(message, '$.content'), char(9, 10, 13, 32)) LIKE '[%removed from the history%]'
  AND json_extract(message, '$.content') <> '[Reply sent to the Owner. Text removed from the history]';
--> statement-breakpoint
UPDATE conversation_messages
SET message = json_set(
  message,
  '$.content',
  json((
    SELECT json_group_array(json(part.value))
    FROM json_each(conversation_messages.message, '$.content') AS part
    WHERE NOT (
      json_extract(part.value, '$.type') = 'text'
      AND trim(json_extract(part.value, '$.text'), char(9, 10, 13, 32)) LIKE '[%removed from the history%]'
    )
  ))
)
WHERE kind = 'step'
  AND compacted_at IS NULL
  AND json_extract(message, '$.role') = 'assistant'
  AND json_type(message, '$.content') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(conversation_messages.message, '$.content') AS part
    WHERE json_extract(part.value, '$.type') = 'text'
      AND trim(json_extract(part.value, '$.text'), char(9, 10, 13, 32)) LIKE '[%removed from the history%]'
  );
--> statement-breakpoint
DELETE FROM conversation_messages
WHERE kind = 'step'
  AND compacted_at IS NULL
  AND json_extract(message, '$.role') = 'assistant'
  AND json_type(message, '$.content') = 'array'
  AND json_array_length(message, '$.content') = 0;
