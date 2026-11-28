const parent =
  "{parent|parent.page_id|parent.data_source_id|parent.database_id|parent.teamspace_id|parent.type}";

const newParent =
  "{new_parent|new_parent.page_id|new_parent.data_source_id|new_parent.database_id|new_parent.teamspace_id|new_parent.type}";

export const notionPageSummaries = {
  "notion-create-pages": `create page {pages.properties.title|pages.properties.Name|pages.content}[ in ${parent}]`,
  "notion-update-page":
    "update page {page_id}: {command}[, title {properties.title|properties.Name}][, text {new_str|content_updates.new_str}][, all matches: {content_updates.replace_all_matches}][, may delete content: {allow_deleting_content}]",
  "notion-move-pages": `move {page_or_database_ids|page_ids} to ${newParent}`,
  "notion-duplicate-page": "duplicate page {page_id}",
  "notion-delete-pages": "move to Trash: {page_ids|pages.id|pages|page_id}",
  "notion-restore-pages": "restore from Trash: {page_ids|pages.id|pages|ids}",
  "notion-get-async-task": "check task {task_id}",
  "notion-create-meeting-note": `create a meeting note[ {title|content}][ in ${parent}][ for event {calendarEvent|calendarEvent.eventId}]`,
  "notion-link-meeting-note-to-calendar-event":
    "link a meeting note to a calendar event[: {url|meeting_note_url|meetingNoteUrl}][ and {calendarEvent|calendarEvent.eventId}]",
} as const;
