# 0036: MCP Connections

Status: accepted

Date: 2026-11-26

Ticket [#151](https://github.com/kacperborowieckb/billy/issues/151) of spec [#150](https://github.com/kacperborowieckb/billy/issues/150). The spec asked for the number 0027, which is taken. It applies [0033](0033-prompt-and-conversation-architecture.md) and [0034](0034-architecture-review-changes.md), and it builds on [0027](0027-actions-and-approval.md) and [0029](0029-untrusted-tool-results.md). It replaces the MCP paragraph of [0009](0009-agent-loop-and-client-boundaries.md) ("MCP tools come from `this.addMcpServer()` in the Personal Agent"), and it replaces the exception of `capture_note` in 0029. This record covers the read path (#151). The tickets #152 to #158 add Approval, Scheduled Turns, connect, tokens, refresh, disconnect, and the Notion entry, and each adds its decisions to this record.

## Decision

- **An MCP Hub for each Owner.** The MCP Hub is a Durable Object that is separate from the Personal Agent, named by the Owner Id. It owns the Agents SDK `MCPClientManager`, installed on its own Lifecycle (`agents/lifecycle`). The Personal Agent calls it only through RPC and our own interface (`McpHubPort`). SDK types do not leave `src/mcp/mcp-hub.ts`.
- **Lazy connect.** The SDK restores every stored server on wake and has no switch for it. The hub uses a subclass of the manager that overrides the public method `restoreConnectionsFromStorage` with nothing. A wake connects nothing. The hub connects one server on the first call for it, and waits at most `mcpConnectTimeoutMillis`. A Telegram message, an alarm, and an Approval press never call the hub, because the Personal Agent calls it only inside `call_mcp_tool` and at the add of a Connection.
- **The MCP Catalog is code.** `src/mcp/mcp-catalog.ts` has the typed entries: id, name, description, server URL, and for each tool a Risk Class and, for a `read` tool, the field that holds the id of a result with an id shape. The shapes are a UUID, a hex string of a fixed length (16 to 64), and a number, so no shape can hold words. A test of the Catalog fails for any other shape. Production has no entry now. The test-only entry `test_server` exists only when the Worker variable `MCP_TEST_SERVER_URL` is not empty. The Operator route `POST /operator/mcp-connections` adds a Connection for an Owner, and the test setup and `pnpm control request --mcp` use it. The first real entry (Notion) comes with #158.
- **Tool catalog copy.** The Personal Agent keeps the tool list and the state of each MCP Connection in its SQLite (`mcp_connections` and `mcp_tools`, a versioned migration), read through an Effect `Schema`. The hub sends the copy after a connect. A Turn reads a snapshot of the copy when it builds its tools and never waits for the hub to search.
- **Fixed tools.** `find_mcp_tools` (`read`) answers from the copy with no hub call. It returns up to 5 matches with their input schemas, or a short index when more tools match. Its text is server text, so it comes inside the Untrusted Content markers. `call_mcp_tool` runs only a tool that the catalog marks `read` and that the server does not mark `destructiveHint: true`. Every other class is `blocked` until #152 adds Approval. A tool that the catalog does not list is `approve` by the rules of the spec, so it is `blocked` for now. The class comes from the catalog and can only be raised by an annotation.
- **Results.** The result comes inside the Untrusted Content markers, so the Turn becomes `untrusted` by 0029. Code cuts it at `mcpResultMaxCharacters` with a visible marker. A call that times out (`mcpCallTimeoutMillis`) or fails returns a status and a notice to the model. Each call writes one `McpToolCalled` Journal Entry with the Connection, the tool, the Risk Class, and the status, without arguments or result.
- **Stub.** The stored Conversation gets a code-written Stub: the Connection name, the tool name, and the count of results. It lists the ordered ids that match the id shape of the catalog entry. Text that does not match the shape is dropped, and the Stub holds no title and no text of a result. The names in the Stub come from the catalog.
- **Owner Context Block.** The block lists the names and the states of the Connections, and the catalog entries that are not connected, with text from the catalog only. A state change replaces the block one time. The system text and the tool definitions do not change with the Connections.
- **Outbound refusal.** Every request of the hub goes through a guard that refuses non-HTTPS addresses, private, internal, loopback, and link-local addresses, names without a dot, and redirects. The Operator can name one exact origin as an exception for the test server (`MCP_TEST_SERVER_URL`).
- **`capture_note` in an untrusted Turn (replaces the exception in 0029).** A new Note that links to no existing Note runs with no Approval in every `untrusted` Turn, and code marks the Note `untrusted`, whether the Burst or a tool result made the Turn `untrusted`. The gate has a new decision, `RunMarkedUntrusted`, and the tool gets it in its call. An edit or a link to an existing Note still needs Approval.

## Why

The spec of #150 says that the gate rules apply with no MCP exceptions and that a new Note saves with no Approval after an MCP result. 0029 required Approval for it, because the Note would be an `owner` Note with text that can copy Untrusted Content. Marking the Note `untrusted` removes that risk, and the Owner keeps "read my page and keep the main points" as one message.

## Revisit if

- Eval results show bad tool choice with the generic find and call tools. Then consider giving some MCP tools to the model directly.
- The number of Approval taps for MCP calls is a problem. Then consider more `change`-class tools in the catalog.
- The Agents SDK adds a switch for the restore on wake. Then drop the subclass of the manager.
- A server uses ids that no shape of the catalog covers.
