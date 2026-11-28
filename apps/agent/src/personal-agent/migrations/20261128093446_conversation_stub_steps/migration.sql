DELETE FROM conversation_messages
WHERE kind = 'step'
  AND compacted_at IS NULL
  AND json_extract(message, '$.role') = 'assistant'
  AND json_type(message, '$.content') = 'text'
  AND json_extract(message, '$.content') LIKE '[%removed from the history%]';
