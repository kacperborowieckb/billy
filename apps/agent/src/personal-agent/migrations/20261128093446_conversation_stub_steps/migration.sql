CREATE TABLE stub_only_texts (text TEXT NOT NULL PRIMARY KEY);
--> statement-breakpoint
INSERT INTO stub_only_texts (text)
WITH RECURSIVE
  candidates(text) AS (
    SELECT json_extract(message, '$.content')
    FROM conversation_messages
    WHERE kind IN ('step', 'reply')
      AND compacted_at IS NULL
      AND json_type(message, '$.content') = 'text'
    UNION
    SELECT json_extract(part.value, '$.text')
    FROM conversation_messages, json_each(conversation_messages.message, '$.content') AS part
    WHERE kind = 'step'
      AND compacted_at IS NULL
      AND json_type(message, '$.content') = 'array'
      AND json_extract(part.value, '$.type') = 'text'
  ),
  lines(text, line, rest) AS (
    SELECT text, '', replace(text, char(13), '') || char(10)
    FROM candidates
    UNION ALL
    SELECT
      text,
      trim(substr(rest, 1, instr(rest, char(10)) - 1), char(9, 32)),
      substr(rest, instr(rest, char(10)) + 1)
    FROM lines
    WHERE rest <> ''
  )
SELECT text
FROM lines
GROUP BY text
HAVING sum(line <> '') > 0
  AND sum(
    line <> ''
    AND NOT (
      substr(line, 1, 1) = '['
      AND instr(line, ']') = length(line)
      AND line LIKE '%removed from the history%'
    )
  ) = 0;
--> statement-breakpoint
DELETE FROM conversation_messages
WHERE kind IN ('step', 'reply')
  AND compacted_at IS NULL
  AND json_extract(message, '$.role') = 'assistant'
  AND json_type(message, '$.content') = 'text'
  AND json_extract(message, '$.content') IN (SELECT text FROM stub_only_texts)
  AND NOT (
    kind = 'reply'
    AND json_extract(message, '$.content') = '[Reply sent to the Owner. Text removed from the history]'
  );
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
      AND json_extract(part.value, '$.text') IN (SELECT text FROM stub_only_texts)
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
      AND json_extract(part.value, '$.text') IN (SELECT text FROM stub_only_texts)
  );
--> statement-breakpoint
DELETE FROM conversation_messages
WHERE kind = 'step'
  AND compacted_at IS NULL
  AND json_extract(message, '$.role') = 'assistant'
  AND json_type(message, '$.content') = 'array'
  AND json_array_length(message, '$.content') = 0;
--> statement-breakpoint
DROP TABLE stub_only_texts;
