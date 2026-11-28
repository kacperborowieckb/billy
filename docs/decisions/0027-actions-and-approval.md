# 0027: Actions and Approval

Status: accepted

Partly superseded: [0031](0031-gated-tools-resolve-their-input.md) changes the list of `read` tools under "Risk Class": `quiet_hours` and `proactive_message_budget` are `read` for a call with no value to change.

Changed on 2026-11-28 by [#242](https://github.com/kacperborowieckb/billy/issues/242): an approved call that settles now gets one Model Turn that answers the Owner from its outcome. See "Answer after an approved call". This meets the first "Revisit if" item.

Date: 2026-11-21

Spec [#139](https://github.com/kacperborowieckb/billy/issues/139) (Actions and Approval). The spec names this record 0026. That number belongs to the marketing site stack, so this record has the number 0027. It supersedes one rule of [0021](0021-outcome-tools.md): the `readsOnly` flag of a tool. This decision replaces that flag with the Risk Class `read`, and the outcome-refusal rules read the Risk Class of each failed call. For a call in the current model run, the class comes from its tool and its exact input. A call from Turn progress (after a Restart or a reset) has its recorded input. The `recordedInput` function of a tool and the Redactor can change that input, so code counts the call as a read call only when its tool is `read` for every input. All other rules of 0021 stay in force. It builds on [0019](0019-proactivity.md), [0022](0022-chat-replies.md), and [0025](0025-restart-mid-turn.md).

Each ticket of #139 adds one part of this decision. Ticket [#143](https://github.com/kacperborowieckb/billy/issues/143) adds the Risk Class and the gate. The Owner sees no change in behavior. The gate denies only a `blocked` call, and no tool is `blocked` yet. The later tickets of #139 add the Trust Level of a Turn, Pending Approvals, and the Telegram buttons. The repository owner decided two rules that differ from #139. First, a call whose input contains an Operator secret gets no Pending Approval. Second, the Owner answers only with the buttons. The typed yes ticket, [#149](https://github.com/kacperborowieckb/billy/issues/149), is closed as not planned.

This feature does not use the word "Action". In `CONTEXT.md`, an Action stays the Action of a Schedule (`SendText` or `RunPrompt`).

## Decision

### Risk Class

- Each agent tool declares a Risk Class: `read`, `change`, `approve`, or `blocked`. The type makes it required, and a test lists every tool of every tool set and fails when a tool has no Risk Class.
- A tool can also give a function from its decoded input to a Risk Class. The class of a call is the higher of the two, so the function can raise the class and never lower it. The function runs only on an input that matches the input schema of the tool. Any other input keeps the declared class, because the tool cannot run with it.
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
  - `blocked`: the gate denies the call. The model gets the reason as the tool result, and the call counts as a failed changing call for the outcome-refusal rules. The stored history keeps the tool call and its `execution-denied` result, and code removes the native `tool-approval-request` and `tool-approval-response` parts.
- Auto-review, when it exists, runs in the gate after the code rules and before the Owner sees the call. This decision does not build Auto-review.
- The SDK calls the gate only for a call whose input parses as JSON and matches the input schema of the tool. The SDK reads an empty or whitespace-only input as the JSON text `{}`. A tool declared `blocked` never runs its work: its execute function only returns the denial reason as a failure. So its schema accepts any JSON. When its input does not parse as JSON, the Model Gateway replaces that input with the JSON text `{}`. Every call to a tool declared `blocked` therefore reaches the gate, and the model gets the denial reason. For a tool of another declared class, the tool does not run when its input is malformed. An input that does not parse as JSON gives the model the parse error. An input that does not match the schema gives the model the validation error.
- A run that the gate allows maps to `not-applicable`, so the Conversation gets no approval parts for it.
- Code does not continue the model history with `tool-approval-response`. When the SDK stops for Approval, code writes the frozen call as a draft Pending Approval, and writes a tool result for that call into the Conversation: "waiting for the Owner's Approval, id X". The history stays valid when other Owner messages or a reset come before the answer. Each call of a step that needs Approval becomes its own draft, except a call whose input contains an Operator secret (see Pending Approval).

### What the Owner sees

- Each tool that can need Approval gives a code function that writes its frozen input in plain words (the summary). The model's text is never the summary.
- A Turn with drafts sends one Delivery: the model's reply text, if any, then for each draft its summary and one row of Approve and Reject buttons. There is no "Approve all".
- A Turn with drafts cannot end with `stay_silent` or with a reaction only. Code refuses them.
- The Channel interface adds three operations: send with Approval buttons, edit the Approval message with a status line and no buttons, and answer a button press. Telegram uses inline keyboards, `editMessageText` or `editMessageReplyMarkup`, and `answerCallbackQuery`. The webhook setup receives `callback_query` updates.

### Pending Approval

- States: `draft`, then `pending`, then `approved`, `rejected`, or `expired`, then for an approved one `executed`, `failed`, or `unconfirmed`. Every change after `draft` is a Journal Entry.
- A draft becomes `pending` only when its Delivery is `Sent` or `Unconfirmed`. When the Delivery is `Unconfirmed`, the Pending Approval is `pending` and expires at its expiry instant like any other. A Restart or a failed send deletes the drafts.
- Storage: a new table in the Personal Agent SQLite. Code reads it only through an Effect `Schema`. A versioned migration adds the table. It has the id, the Turn Event id, the tool name, the frozen input, the summary, the state, the expiry instant, the Channel message id, and the result.
- Frozen input: it is the decoded input of the tool call, not the output of `recordedInput`. The run of an approved call reads only the stored frozen input.
- Operator secrets: the Redactor replaces only the Operator secrets of the Instance. Before code writes a draft, it checks the input with the Redactor. When the Redactor would change the input, code creates no Pending Approval and gives the model a refusal as the tool result. So the stored frozen input is always the exact decoded input, and no stored input contains an Operator secret.
- Expiry: each tool can set its own. The default is a new Behavior Config value of 24 hours. The alarm of the Schedules store expires Pending Approvals at their instant, with no model call.

### Answering

- Button press: the Edge accepts a Telegram `callback_query` only from the Owner's Channel Identity in the Directory, with data that is a short Pending Approval id and an answer. It forwards an `ApprovalAnswered` Event. The Inbox gives it Owner priority and drops a duplicate by the callback query id. Code answers the press at once.
- Buttons only: the Owner answers a Pending Approval only with its Approve or Reject button. A text message from the Owner never answers a Pending Approval.
- Code answers the press and records the answer with no model call. The Event does not join a Burst and does not cause a Restart. Only the answer after an approved call runs a model call (see "Answer after an approved call").
- An answer to a Pending Approval that is not `pending` changes nothing. A late press gets "This expired" or "This was already answered".

### Running an approved call

- Code runs the exact frozen input through the tool's own execute once. The recorded tool call uses the Pending Approval id as its key. After a reset during the run, code recovers from that record and does not run the call again.
- The result sets the state to `executed`, `failed` (with the tool's failure message), or `unconfirmed`.
- Code edits the Approval message: code keeps the summary, removes the buttons, and adds one status line: "Approved, done", "Approved, but it failed: <reason>", "Rejected", or "Expired".
- Code adds a short Conversation entry, for example "Approval for <summary>: approved, done", and the Journal Entry records the same answer and result.
- A Reject, an expiry, and a late press get no new message and no model call.

### Answer after an approved call

- When an approved call settles as `executed`, `failed`, or `unconfirmed`, one Model Turn answers the Owner in a new message, so Telegram notifies the Owner. The Approval message still gets its status line first. The Turn is keyed by the `ApprovalAnswered` Event, so its Delivery, Turn progress, Conversation rows, and Trace use that Event id.
- In the transaction that records the run, code writes the call and its outcome into the Turn progress of that Event, as a completed step: a tool call with the Pending Approval id as the tool call id and the frozen input, and its tool result. For `executed`, the result is the output of the tool, so an MCP result is the same Untrusted Content as a `call_mcp_tool` result in a Turn, with the same size limit and the same Stub in the Conversation. For `failed`, the result is an error that gives the reason and says that the call failed. For `unconfirmed`, it is the error that says that code cannot confirm the call ran.
- The input of the Turn is a code message that names the Pending Approval id, the tool, and the summary. The summary of an `untrusted` Pending Approval is marked as Untrusted Content. The Turn starts with the Trust Level of the Pending Approval, and a tool result with Untrusted Content makes it `untrusted`, so the gate applies: a `change` call needs Approval.
- The Turn is a reply Turn of the main Conversation: it sends the same system text and tool definitions as an Owner message Turn, so it reuses the prompt cache. Its tools are the tools of the first Owner message Turn of the chain, and they record under the `ApprovalAnswered` Event. A Pending Approval that this Turn creates names that Event as its Turn, and code finds the tools of its run through the answered Pending Approval.
- The Turn must answer with text: code refuses `stay_silent` and a reaction. A failed model call sends the honest failure text, and so does a reply with no text and no Approval buttons.
- Approval Events are handled one by one in Inbox order, so two approved calls that settle close together give two ordered Turns. After a reset, the Delivery state of the Event decides: a Turn that sent is not sent again, and a Turn that did not send runs from the recorded step.

### Scope

- Only Owner message Turns create Pending Approvals. Proactive Turns and Scheduled Task Turns keep their tool sets, and none of their tools need Approval.

### Temporary paths

- No Eval Cases for Approval. They come with the Eval work, as in [0019](0019-proactivity.md).
- No Auto-review. Issue [#140](https://github.com/kacperborowieckb/billy/issues/140) tracks it. Work on #140 starts only after the first `approve`-class tool exists.

## Why

Before this decision, the only protection was to remove tools by Trust Level. That protection had two problems. It was too strict: a forwarded invitation could not become a Reminder. It was incomplete: in an Owner message Turn, the model can read an untrusted Note. That Note can contain an instruction, and the model can follow it and call a tool that changes the Owner's data. A Risk Class on each tool and one gate in code give one place that decides every call, from facts that the model cannot change. The native `toolApproval` option stops a call before it runs, so no tool needs its own check. Approval as stored data, not as a continued model history, keeps the Conversation valid when other messages, a Restart, or a reset come before the answer. The first version sent no message after an approved call. The real Notion run of #158 showed that the Owner then got no answer and the model never saw the result, so an approved call now gets its own Turn, and that Turn gets the result as a completed step that code wrote. Later tools (Forget, MCP Connections) declare a Risk Class and a summary and get Approval with no new code.

## Revisit if

- An approved call needs a result that the model must not see in full, for example a result that is too large for one Turn.
- Scheduled Turns get a tool that needs Approval.
- The Channel is not Telegram.
- The Owner needs to answer a Pending Approval in text, for example from a Channel with no buttons. Issue [#162](https://github.com/kacperborowieckb/billy/issues/162) tracks a typed yes.
