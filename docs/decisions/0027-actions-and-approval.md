# 0027: Actions and Approval

Status: accepted

Date: 2026-11-21

Spec [#139](https://github.com/kacperborowieckb/billy/issues/139) (Actions and Approval). The spec names this record 0026, but 0026 is the marketing site stack, so it is 0027. It supersedes one rule of [0021](0021-outcome-tools.md): the `readsOnly` flag of a tool. The Risk Class `read` takes its place, and the outcome-refusal rules read the Risk Class. The rest of 0021 stands. It builds on [0019](0019-proactivity.md), [0022](0022-chat-replies.md), and [0025](0025-restart-mid-turn.md).

The feature is built in steps. Ticket [#143](https://github.com/kacperborowieckb/billy/issues/143) adds the Risk Class and the gate, with no change in behavior for the Owner: the gate denies only a `blocked` call, and no tool is `blocked` yet. The later tickets of #139 add the Trust Level of a Turn, Pending Approvals, the Telegram buttons, and the typed yes.

This feature does not use the word "Action". In `CONTEXT.md`, an Action stays the Action of a Schedule (`SendText` or `RunPrompt`).

## Decision

### Risk Class

- Each agent tool declares a Risk Class: `read`, `change`, `approve`, or `blocked`. The type makes it required, and a test lists every tool of every tool set and fails when a tool has no Risk Class.
- A tool can also give a function from its decoded input to a Risk Class. The class of a call is the higher of the two, so the function can raise the class and never lower it.
- The model never sets or sees the class.
- `read` for `search_notes`, `list_linked_notes`, `list_open_loops`, `list_schedules`, and the outcome tools (`stay_silent`, `react`). `change` for every other tool. No tool is `approve` or `blocked` yet.

### Trust Level of a Turn

- A Turn starts with the Trust Level of its Burst: a forwarded message makes it `untrusted`. Proactive Turns and Scheduled Task Turns are `owner`.
- A tool result that returns Untrusted Content (for example an untrusted Note from `search_notes` or `list_linked_notes`) makes the Turn `untrusted` for the rest of the Turn. Code decides this from the stored Trust Level of the data, never from the model.
- Owner message Turns stop removing tools by Trust Level. They get all tools, and the gate decides each call.

### The gate

- The gate is one function from (tool, input, Trust Level of the Turn) to a decision. The Model Gateway gives it to the native `toolApproval` option of the AI SDK `ToolLoopAgent`, so the SDK stops a call before `execute`.
- Rules:
  - `read`: runs.
  - `change` in an `owner` Turn: runs.
  - `change` in an `untrusted` Turn: needs Approval. One exception: `capture_note` of a new Note runs, because code marks that Note `untrusted`. An edit of an existing Note needs Approval.
  - `approve`: always needs Approval.
  - `blocked`: denied. The model gets the reason as the tool result, and the call counts as a failed changing call for the outcome-refusal rules.
- The gate has a place for Auto-review between the code rules and the Owner. It is not built.
- A run that the gate allows maps to `not-applicable`, so the Conversation gets no approval parts for it.
- Code does not continue the model history with `tool-approval-response`. When the SDK stops for Approval, code writes the frozen call as a draft Pending Approval, and writes a tool result for that call into the Conversation: "waiting for the Owner's Approval, id X". The history stays valid when other Owner messages or a reset come before the answer. Each call of a step that needs Approval becomes its own draft.

### What the Owner sees

- Each tool that can need Approval gives a code function that writes its frozen input in plain words (the summary). The model's text is never the summary.
- A Turn with drafts sends one Delivery: the model's reply text, if any, then for each draft its summary and one row of Approve and Reject buttons. There is no "Approve all".
- A Turn with drafts cannot end with `stay_silent` or with a reaction only. Code refuses them.
- The Channel gets: send with Approval buttons, edit the Approval message with a status line and no buttons, and answer a button press. Telegram uses inline keyboards, `editMessageText` or `editMessageReplyMarkup`, and `answerCallbackQuery`. The webhook setup receives `callback_query` updates.

### Pending Approval

- States: `draft`, then `pending`, then `approved`, `rejected`, or `expired`, then for an approved one `executed`, `failed`, or `unconfirmed`. Every change after `draft` is a Journal Entry.
- A draft becomes `pending` only when its Delivery is `Sent`. A Restart or a failed send deletes the drafts. When the send is `Unconfirmed`, the drafts become `pending` and expire as usual.
- Storage: a new table in the Personal Agent SQLite, read only through an Effect `Schema`, added by a versioned migration. It has the id, the Turn Event id, the tool name, the frozen input (redacted like other recorded tool input), the summary, the state, the expiry instant, the Channel message id, and the result.
- Expiry: each tool can set its own. The default is a new Behavior Config value of 24 hours. The alarm of the Schedules store expires Pending Approvals at their instant, with no model call.

### Answering

- Button press: the Edge accepts a Telegram `callback_query` only from the Owner's Channel Identity in the Directory, with data that is a short Pending Approval id and an answer. It forwards an `ApprovalAnswered` Event. The Inbox gives it Owner priority and drops a duplicate by the callback query id. Code answers the press at once.
- Typed yes: the outcome tool `answer_approval` exists only in a Turn whose Trust Level is `owner` and when exactly one Pending Approval is `pending`. Code checks both again when the tool runs.
- Code handles an `ApprovalAnswered` Event with no model call. It does not join a Burst and does not cause a Restart.
- An answer to a Pending Approval that is not `pending` changes nothing. A late press gets "This expired" or "This was already answered".

### Running an approved call

- Code runs the exact frozen input through the tool's own execute once, keyed by the Pending Approval id through the recorded tool call. A reset during the run recovers from that record and does not run the call again.
- The result sets the state to `executed`, `failed` (with the tool's failure message), or `unconfirmed`.
- Code edits the Approval message: the summary stays, the buttons go, and one status line is added: "Approved, done", "Approved, but it failed: <reason>", "Rejected", or "Expired". No new message and no model call.
- Code adds a short Conversation entry, for example "Approval for <summary>: approved, done", and the Journal Entry records the same answer and result.

### Scope

- Only Owner message Turns create Pending Approvals. Proactive Turns and Scheduled Task Turns keep their tool sets, and none of their tools need Approval.

### Temporary paths

- No Eval Cases for Approval. They come with the Eval work, as in [0019](0019-proactivity.md).
- No Auto-review. Issue [#140](https://github.com/kacperborowieckb/billy/issues/140) tracks it, blocked until the first `approve`-class tool.

## Why

Removing tools by Trust Level was the only protection, and it was too strict and incomplete at once. A forwarded invitation could not become a Reminder, and an untrusted Note read in an Owner message Turn could still push the model to change data. A Risk Class on each tool and one gate in code give one place that decides every call, from facts that the model cannot change. The native `toolApproval` option stops a call before it runs, so no tool needs its own check. Approval as stored data, not as a continued model history, keeps the Conversation valid when other messages, a Restart, or a reset come before the answer. Later tools (Forget, MCP Connections) declare a Risk Class and a summary and get Approval with no new code.

## Revisit if

- A result needs a model summary, for example MCP output.
- Scheduled Turns get a tool that needs Approval.
- The Channel is not Telegram.
