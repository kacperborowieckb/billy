export const notionCommentSummaries = {
  "notion-create-comment":
    "comment on page {page_id|parent.page_id}: {markdown|rich_text.text.content}[ in discussion {discussion_id}]",
  "notion-get-comments": "read the comments of page {page_id}",
  "notion-update-comment": "change comment {comment_id} to {markdown}",
  "notion-delete-comment": "delete comment {comment_id}",
  "notion-set-discussion-resolved":
    "set discussion {discussion_id} to resolved: {resolved}",
  "notion-set-comment-reaction":
    "set reaction {emoji} on comment {comment_id} to: {reacted}",
  "notion-create-suggested-edit":
    "suggest an edit on page {page_id}: {old_text} to {new_text}[ ({mode})]",
  "notion-get-suggested-edit": "read suggested edit {suggested_edit_url}",
  "notion-resolve-suggested-edit":
    "{action} suggested edit {suggested_edit_url}",
  "notion-view-version": "read {page_id|page|url} as of {time}",
  "notion-get-version-changes":
    "read the changes of {page_id|page|url}[ since {start_time|from}]",
  "notion-restore-version":
    "restore {page_id|page|url} to its version of {time}[, with its databases: {include_inline_databases}][, confirmed: {user_confirmed}]",
} as const;
