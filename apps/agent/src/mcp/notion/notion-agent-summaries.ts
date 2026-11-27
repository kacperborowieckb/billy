export const notionAgentSummaries = {
  "notion-convert-page-to-skill":
    "turn page {page_url|url|page_id} into a Skill",
  "notion-download-skill": "download Skill {id|page_id}",
  "notion-upload-skill":
    "replace page {page_id} with an uploaded Skill: {action}",
  "notion-get-enabled-skills": "list enabled Skills",
  "notion-update-enabled-skills":
    "change enabled Skills[, add {add_skill_urls}][, remove {remove_skill_urls}]",
  "notion-memory-search": "search saved memories for {query}",
  "notion-search-agents": "search Custom Agents[ for {query}]",
  "notion-query-sessions": "list agent sessions",
  "notion-search-sessions": "search agent sessions[ for {query}]",
  "notion-spawn-session":
    "start an agent session[ with {agent_url|agent|agent_id}][: {message|prompt|instructions}]",
  "notion-send-message-to-session":
    "send {message|prompt} to session {session_url}",
  "notion-get-session-status": "check session {session_url}",
  "notion-wait-session": "wait for session {session_url}",
  "notion-stop-session": "stop session {session_url}",
  "notion-list-session-events": "list the activity of session {session_url}",
  "notion-read-session-event": "read an event of session {session_url}",
} as const;
