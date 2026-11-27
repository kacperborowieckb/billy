export const notionWorkspaceSummaries = {
  "notion-ai-search": "search Notion and connected apps for {query}",
  "notion-connector-search": "search connected apps for {question}",
  "notion-query-meeting-notes":
    "read meeting notes[ matching {query|title|filter.title}]",
  "notion-get-self": "read the connected workspace and user",
  "notion-get-teams": "list teamspaces[ matching {query}]",
  "notion-get-groups": "look up groups[ matching {query}]",
  "notion-get-users": "look up users[ matching {query|user_id}]",
  "notion-get-tool-access": "check tool access[ for {tool_names}]",
  "notion-list-private-pages": "list private pages",
  "notion-list-shared-pages": "list shared pages",
  "notion-list-favorite-pages": "list favorite pages",
  "notion-list-recent-pages": "list recent pages",
  "notion-list-page-backlinks": "list pages that link to {page_id}",
} as const;
