const parent =
  "{parent|parent.page_id|parent.data_source_id|parent.database_id|parent.teamspace_id|parent.type}";

export const notionDatabaseSummaries = {
  "notion-create-database": `create a database[ {title.text.content|title|name}][ in ${parent}]`,
  "notion-convert-to-meetings-database":
    "turn database {database_id|database_url|url} into a meetings database",
  "notion-update-data-source":
    "update data source {data_source_id}[, title {title.text.content|title|name}][, change properties {statements|properties}][, page layout {page_layout}][, to Trash: {in_trash}]",
  "notion-create-view":
    "create a view[ {name}][ of type {type}][ on {database_id|data_source_id|parent_page_id}]",
  "notion-update-view": "update view {view_id}[, name {name}]",
  "notion-query-data-sources":
    "read database rows[ from {data_source_url|view_url|data.data_source_urls|data.view_url}][ with query {query|data.query}]",
  "notion-query-multiple-data-sources":
    "query data sources {data_source_urls}[ with {query}]",
  "notion-delete-databases":
    "move databases to Trash: {database_ids|databases.id|databases|database_id}",
  "notion-create-folder":
    "create a folder[ {title|name}][ under {page_id|parent|parent.page_id}]",
  "notion-update-folder":
    "change folder {folder_id}: {command|command.command}",
  "notion-create-file-upload":
    "create a file upload[ for {filename|file_name|name}]",
  "notion-create-attachment":
    "create an attachment[ {filename|name}][ from {url|source_url|source_file_id}]",
  "notion-download-attachment": "read attachment {file_upload_id}",
  "notion-get-file-download-urls": "get download links for {references}",
} as const;
