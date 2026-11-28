# 0038: Old tool calls are stored as pairs with a Stub as the result

Status: accepted

Date: 2026-11-28

Ticket [#246](https://github.com/kacperborowieckb/billy/issues/246) of spec [#255](https://github.com/kacperborowieckb/billy/issues/255), after the investigation [#243](https://github.com/kacperborowieckb/billy/issues/243). This is one record for #246 and [#251](https://github.com/kacperborowieckb/billy/issues/251), because both change the stored form of a Turn. This version holds the rules of #246. #251 adds its rules here: the reply text of an `untrusted` Turn, and the Trust Level that code reads from the stored rows.

The spec calls the Stub that stands in place of a tool result a "placeholder". `CONTEXT.md` keeps one term: Stub.

It supersedes these rules. All other rules of the named records stay in force.

- [0033](0033-prompt-and-conversation-architecture.md), "Untrusted Content and Stubs": each tool call of an `untrusted` Turn becomes a Stub as text of the agent. The call is now a pair, and the Stub is its result.
- [0034](0034-architecture-review-changes.md), "The Stub of an MCP result keeps ordered ids": the ids and their shape rule stay. The place of the Stub and the way code names the Connection and the tool change.
- [0036](0036-mcp-connections.md), "Stub": the names of the Connection and the tool come from the input of the call, checked against the MCP Catalog.

[0029](0029-untrusted-tool-results.md) and [0030](0030-untrusted-context-of-a-turn.md) do not change with #246.

## Facts that the decision uses

- Code stored the tool history of an `untrusted` Turn as bracket lines in one assistant message. In a real Notion chat the reply model copied these lines three times in place of a tool call. In two of those Turns the Owner asked for a change, and no call ran. In other Turns the model asked the Owner for a page name and a text that it could read again.
- No framework that we looked at writes a placeholder into assistant text. Anthropic context editing, LangChain `ClearToolUsesEdit`, and `truncateOlderToolResults` of `agents/chat` keep the tool-call and tool-result pair and replace the result.
- The same failure is on record in other projects: [llama_index#23500](https://github.com/run-llama/llama_index/issues/23500) and [pit#409](https://github.com/cv/pit/issues/409).

## Decision

- **Pairs.** The stored form of an `untrusted` Turn holds, for each model step with tool calls, one assistant message with the `tool-call` parts and one tool message with the `tool-result` parts. It holds no other part of a step: no text and no reasoning of the model. No Stub is text of an agent step.
- **Input.** Code replaces each tool-call input with one fixed value that code writes, because the model can have written the input from Untrusted Content.
- **Call id.** Code replaces each tool call id with `call_` and the first 24 hex characters of the SHA-256 of the Turn Event id and the original id. Some model providers let the model write the id. A hex string of a fixed length cannot hold an instruction (the shape rule of 0034).
- **Tool name.** A name that does not have the shape of a tool name is stored as `unknown_tool`, as before.
- **Result.** The result is a Stub: one line in square brackets with the tool, the status (done, failed, timed out, no result, or waits for Approval with its id), counts, Note ids, and the ordered MCP result ids. A failed call, a timed-out call, and a call with no result have an error result type.
- **MCP names.** For `call_mcp_tool` and `find_mcp_tools`, the Stub names the catalog id of the Connection and the catalog name of the tool, which code reads from the input and finds in the MCP Catalog. A tool that the Catalog does not list gets no name. A Connection that the Catalog does not have gets no name. No text of the input or of the server enters the Stub.
- **Large trusted results.** A result above `maxStoredToolResultCharacters` of a trusted Turn gets the same Stub, with its size. Its pair, its input, and its id stay as they were.
- **The record.** Each result Stub names the Trace of its Turn by the Turn Event id. The Trace holds the inputs and the results in full, so the short view can be built again from it: the stored call id of an `untrusted` Turn is the hash of the Turn Event id and the call id in the Trace. A call that code ran after an Approval is in the request tail of the Trace of the Turn that answered it. A Trace stays for the retention period (`traceRetentionDays`). After that, or when a reset stopped a Turn before it recorded a Trace and no later model call sent its steps, only the Journal Entries of the Turn stay, which name an MCP call, its Risk Class, and its status.
- **Call again.** The Stub and the system text tell the model to call a tool that reads the data by itself, and not to ask the Owner for data that a tool can read. They also tell it never to repeat a change, because a Stub also stands for a change that is done.
- **Reply guard.** A reply that holds only Stubs is never sent and never stored. Code drops its text, keeps the tool calls that ran, and runs the model step again. After `maxStubReplyRetries` retries (first value 2) the Turn ends as a failed model call, with the honest failure text for an Owner message Turn. Each retry counts against the step limit. The Trace records each refused text in `rejectedStubReplies`. A step text that holds only Stubs is also left out of the stored form of a trusted Turn.
- **Prefix.** Code builds the stored form once, from the Turn Event id and the steps, so the normal path and the recovery path store the same bytes, and the rule of 0033 stays: the next requests send the stored rows unchanged. A Turn that was stored with a Stub is still the planned miss `stub_in_turn_before`.
- **Reply Stub.** The reply of an `untrusted` Turn stays a Stub as assistant text until #251.
- **Migration.** A versioned migration removes the Stubs that the next request would show to the model as its own text, which it then copies. In the rows that Compaction did not replace, it deletes each `step` and `reply` row whose text holds only Stubs, and it removes each text part with only Stubs from a `step` row. Such rows come from the old form of an `untrusted` Turn, and from replies and step texts in which the model copied Stubs in a trusted Turn. The reply Stub stays until #251. The old rows cannot become pairs, because they hold no call id and no pair. The Owner messages, the other replies, the Journal, and the Traces stay. A replay of a Trace that sent a changed or deleted row reports changed Conversation rows. Compacted rows are never sent again and stay until the retention step.

## The generic Stub of `call_mcp_tool`

In the real run of #243, the Stub of `call_mcp_tool` was the generic form with no Connection and no tool name. Cause: code built the MCP form only from a result of type `json` that decodes as an MCP call output. A call has such a result only when it ran. A call that waits for Approval has a text result. A call that code refused (wrong arguments, an unknown tool, a Connection that is not ready, a blocked call) has an error result. In the Notion entry each write is of the class `approve`, so each change request gave the generic form. This reading comes from the code. The stored rows of the real chat were not read.

Fix: the Stub names the Connection and the tool from the input of the call, which every call has, and reads only counts and ids from the result.

## SDK functions

- `pruneMessages` of `ai` removes a whole pair, the call and its result, from messages that it selects by position, and removes reasoning parts. It cannot replace an input or a result, so the history would lose that a call ran. Our form keeps only tool-call parts of a step, so its reasoning rule has nothing to add.
- `truncateOlderToolResults` of `agents/chat` needs the UI messages of Agents SDK sessions, which Billy does not use. It keeps the first characters of a result, so Untrusted Content would stay. It writes no code-written Stub and no record. It runs when the request is built and its cutoff moves with each message, which changes the prefix.

## Why

A model reads assistant text as words that it said, and copies their form. A tool result is data that code or a tool wrote. With pairs, the history shows that a call ran and what it returned, in the form that the model knows, and the removal is in the place where a model expects data. The reply guard is the second layer, because a prompt cannot promise that a model never writes such a line.

## Rejected options

- **Keep the Stubs as assistant text with other words.** The form is the cause.
- **Drop the old pairs.** The agent would not know that it read or changed something, and the ids would be gone.
- **Keep the connection and the tool in the stored input.** The input of a stored call would look like a real call with no arguments, which a model can copy. The Stub of the result names them.
- **Keep the provider call id.** Some providers let the model write it.
- **A copy of the full result in a new table for the record.** The Trace already holds it.
- **Convert the old Stub rows into pairs from the Traces.** More code for rows of a few days, with no production Instance.
- **A code-written message that tells the model why code refused its reply.** One more kind of message that is not the Owner's words. Add it only when plain retries fail often.

## Revisit if

- The model still writes Stubs as a reply, so `rejectedStubReplies` is often in the Traces or Turns fail at the retry limit.
- The model copies the removed input into a new call.
- The model still asks the Owner for data that a tool can read.
- The Owner or Forget needs the short view after the retention period of the Trace.
- A route of `reply` needs the reasoning of an earlier tool call in the request.
- Billy moves to Agents SDK sessions. Then check the two SDK functions again.
