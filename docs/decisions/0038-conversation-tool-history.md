# 0038: Old tool calls are stored as pairs with a Stub as the result

Status: accepted

Date: 2026-11-28

Ticket [#246](https://github.com/kacperborowieckb/billy/issues/246) of spec [#255](https://github.com/kacperborowieckb/billy/issues/255), after the investigation [#243](https://github.com/kacperborowieckb/billy/issues/243). This is one record for #246 and [#251](https://github.com/kacperborowieckb/billy/issues/251), because both change the stored form of a Turn. "Tool history" holds the rules of #246. "Replies and the Trust Level" holds the rules of #251, which the repository owner decided on 2026-11-28. #251 adds rules and changes no text of #246. Where the two differ, the rules of #251 apply.

The spec calls the Stub that stands in place of a tool result a "placeholder". `CONTEXT.md` keeps one term: Stub.

It supersedes these rules. All other rules of the named records stay in force.

- [0033](0033-prompt-and-conversation-architecture.md), "Untrusted Content and Stubs": each tool call of an `untrusted` Turn becomes a Stub as text of the agent. The call is now a pair, and the Stub is its result.
- [0034](0034-architecture-review-changes.md), "The Stub of an MCP result keeps ordered ids": the ids and their shape rule stay. The place of the Stub and the way code names the Connection and the tool change.
- [0036](0036-mcp-connections.md), "Stub": the names of the Connection and the tool come from the input of the call, checked against the MCP Catalog.

[0029](0029-untrusted-tool-results.md) and [0030](0030-untrusted-context-of-a-turn.md) do not change with #246.

#251 also supersedes or changes these rules.

- [0033](0033-prompt-and-conversation-architecture.md), "No model text of an `untrusted` run is stored": the stored form keeps the reply of the run. Tool-call inputs are still removed, and no step text is kept.
- [0033](0033-prompt-and-conversation-architecture.md), "Write-back": a Side Session that read Untrusted Content writes back the sent text, not a Stub.
- [0033](0033-prompt-and-conversation-architecture.md), "The Summary does not make a Turn `untrusted`": a Summary of `untrusted` rows is `untrusted`.
- [0029](0029-untrusted-tool-results.md) and [0030](0030-untrusted-context-of-a-turn.md), "How code checks it" as 0033 changed it: a later Turn can start `untrusted` from the stored Conversation.

The rule of [0032](0032-pending-approval-keeps-its-trust.md) and the `capture_note` rule of [0036](0036-mcp-connections.md) stay. The id shape rule of [0034](0034-architecture-review-changes.md) stays: a Turn that wrote no reply leaves no `untrusted` row, so a later `owner` Turn can read its Stubs.

## Facts that the decision uses

- Code stored the tool history of an `untrusted` Turn as bracket lines in one assistant message. In a real Notion chat the reply model copied these lines three times in place of a tool call. In two of those Turns the Owner asked for a change, and no call ran. In other Turns the model asked the Owner for a page name and a text that it could read again.
- No framework that we looked at writes a placeholder into assistant text. Anthropic context editing, LangChain `ClearToolUsesEdit`, and `truncateOlderToolResults` of `agents/chat` keep the tool-call and tool-result pair and replace the result.
- The same failure is on record in other projects: [llama_index#23500](https://github.com/run-llama/llama_index/issues/23500) and [pit#409](https://github.com/cv/pit/issues/409).

## Decision

### Tool history (#246)

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
- **Migration.** A versioned migration removes the Stubs that the next request would show to the model as its own text, which it then copies. A text holds only Stubs here when each of its lines with text is one bracket group that says that something was removed from the history. A line with other words, or with a second opening bracket, keeps the whole text. In the rows that Compaction did not replace, the migration deletes each `step` and `reply` row with such a text, and it removes each such text part from a `step` row. Such rows come from the old form of an `untrusted` Turn, and from replies and step texts in which the model copied Stubs in a trusted Turn. The reply Stub stays until #251. The old rows cannot become pairs, because they hold no call id and no pair. The Owner messages, the other replies, the Journal, and the Traces stay. A replay of a Trace that sent a changed or deleted row reports changed Conversation rows. Compacted rows are never sent again and stay until the retention step.

### Replies and the Trust Level (#251)

- **Replies.** The stored form of an `untrusted` Turn holds the reply text that the Owner got. This ends the rule "Reply Stub" above.
- **The mark.** Each Conversation row has the column `trust_level` (`owner` or `untrusted`). It says where the model text of the row came from. It is `untrusted` on three kinds of row: the reply of an `untrusted` Turn, the Write-back of an `untrusted` run, and the Summary of a Compaction that read an `untrusted` row (the earlier Summary included). All other rows are `owner`: they hold words of the Owner, text of code, or pairs that code wrote.
- **A Turn from the rows.** An Owner message Turn starts `untrusted` when a row of its request is `untrusted`. Code reads the column and never marker text. The text of the row goes to the model as it is.
- **The stored form of that Turn.** A Turn that is `untrusted` for any reason, also only because of a row, has the `untrusted` stored form: marked parts of the inputs become Stubs, each tool call becomes a pair with a removed input, and no step text is kept. So its reply is `untrusted` too.
- **A Turn with no reply.** A Turn that ends with a reaction, with silence, or with no answer writes no `untrusted` row. A forward that ends this way leaves the next Turn `owner`.
- **Prefix.** A Turn whose stored inputs and steps are the bytes that it sent is not a planned miss, also when it is `untrusted`.
- **Side Sessions.** The Run block quotes an `untrusted` row inside the Untrusted Content marker. So the Side Session is `untrusted` by the rule of 0034, with the same gate rules.
- **Write-back.** The row kind `write_back_stub` is gone. The Turn that is connected to a Proactive Message quotes the sent text inside the marker unless the Write-back of that run is `owner`.
- **Gate.** No change. In an `untrusted` Turn a `change` call asks the Owner. [#140](https://github.com/kacperborowieckb/billy/issues/140) later sends that call to a reviewer first.
- **At storage.** The Trust Level of the stored form is `untrusted` when the run says so, when its inputs or steps hold the marker, or when a row in the Conversation at that time is `untrusted`. After a reset, the run says only what its Event or its Pending Approval says, and code reads the other two again. When another run added an `untrusted` row in between, the Turn is stored as `untrusted`. That direction only asks for more Approval.
- **Migration of the mark.** A versioned migration adds the column. The rows from before hold no model text of an `untrusted` run, so they are `owner`. In the rows that Compaction did not replace, it deletes each reply Stub and each `write_back_stub` row. Their text was never stored, and it stays in the Journal and the Traces. A compacted `write_back_stub` row becomes an `untrusted` `write_back` row.

## What follows from the mark

- The main Conversation does not go back to `owner`. After the first `untrusted` reply, each later Turn is `untrusted`, so its reply is too, and each Compaction passes the mark to the Summary. No rule ends this today.
- Until #140 ships, each `change` call of an Owner message Turn after that point waits for a tap. `capture_note` of a new Note with no link still runs, and code marks the Note `untrusted`.
- Each later tool call is stored with a removed input and a Stub as its result, also a call that read only data of the Owner. The agent reads the data again when it needs it.
- A Side Session whose Run block quotes an `untrusted` reply or Write-back cannot close an Open Loop, and code writes the prompt of its follow-up. Its own Write-back is `untrusted`.

## The generic Stub of `call_mcp_tool`

In the real run of #243, the Stub of `call_mcp_tool` was the generic form with no Connection and no tool name. Cause: code built the MCP form only from a result of type `json` that decodes as an MCP call output. A call has such a result only when it ran. A call that waits for Approval has a text result. A call that code refused (wrong arguments, an unknown tool, a Connection that is not ready, a blocked call) has an error result. In the Notion entry each write is of the class `approve`, so each change request gave the generic form. This reading comes from the code. The stored rows of the real chat were not read.

Fix: the Stub names the Connection and the tool from the input of the call, which every call has, and reads only counts and ids from the result.

## SDK functions

- `pruneMessages` of `ai` removes a whole pair, the call and its result, from messages that it selects by position, and removes reasoning parts. It cannot replace an input or a result, so the history would lose that a call ran. Our form keeps only tool-call parts of a step, so its reasoning rule has nothing to add.
- `truncateOlderToolResults` of `agents/chat` needs the UI messages of Agents SDK sessions, which Billy does not use. It keeps the first characters of a result, so Untrusted Content would stay. It writes no code-written Stub and no record. It runs when the request is built and its cutoff moves with each message, which changes the prefix.

## Why

A model reads assistant text as words that it said, and copies their form. A tool result is data that code or a tool wrote. With pairs, the history shows that a call ran and what it returned, in the form that the model knows, and the removal is in the place where a model expects data. The reply guard is the second layer, because a prompt cannot promise that a model never writes such a line.

Billy keeps its replies because a short answer such as "Yes" refers to the last reply. With the reply removed, the agent did not know its own offer, and the Owner had to name the same page four times. A confirmation for each change is also a safety problem, because an Owner who confirms everything stops reading. The control against an instruction in a kept reply is code: the mark, and the gate that reads it. An `approve` call always asks the Owner, and a `blocked` call never runs.

## Rejected options

- **Keep the Stubs as assistant text with other words.** The form is the cause.
- **Drop the old pairs.** The agent would not know that it read or changed something, and the ids would be gone.
- **Keep the connection and the tool in the stored input.** The input of a stored call would look like a real call with no arguments, which a model can copy. The Stub of the result names them.
- **Keep the provider call id.** Some providers let the model write it.
- **A copy of the full result in a new table for the record.** The Trace already holds it.
- **Convert the old Stub rows into pairs from the Traces.** More code for rows of a few days, with no production Instance.
- **A code-written message that tells the model why code refused its reply.** One more kind of message that is not the Owner's words. Add it only when plain retries fail often.

- **A removal of reply text, or a mark that ends after some Turns.** The repository owner decided against both. A reply that leaves the mark behind can carry an instruction into an `owner` Turn.
- **Marker text in the content of the row.** The model reads it and can copy or drop it.
- **A row kind for each `untrusted` row.** The kind says what a row is. The Trust Level is a second fact, and each kind would need a twin.
- **A mark on every row of an `untrusted` Turn.** A Turn with no reply leaves no model text, so the mark would hold the Conversation `untrusted` for nothing.
- **The trusted stored form for a Turn that is `untrusted` only because of a row.** Its tool inputs and step texts are model text that was written after Untrusted Content.

## Revisit if

- The Owner gets so many Approval requests that they stop reading them, also with #140.
- Side Sessions often fail to close Open Loops because the Run block quotes an `untrusted` row. Then give the Run block a rule of its own.

- The model still writes Stubs as a reply, so `rejectedStubReplies` is often in the Traces or Turns fail at the retry limit.
- The model copies the removed input into a new call.
- The model still asks the Owner for data that a tool can read.
- The Owner or Forget needs the short view after the retention period of the Trace.
- A route of `reply` needs the reasoning of an earlier tool call in the request.
- Billy moves to Agents SDK sessions. Then check the two SDK functions again.
