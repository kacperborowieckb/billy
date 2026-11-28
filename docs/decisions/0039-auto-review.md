# 0039: Auto-review

Status: accepted

Date: 2026-11-28

Issue [#140](https://github.com/kacperborowieckb/billy/issues/140), spec [#255](https://github.com/kacperborowieckb/billy/issues/255). This record extends [0027](0027-actions-and-approval.md) and replaces the rule of the grilling of [#139](https://github.com/kacperborowieckb/billy/issues/139) that the reviewer can never approve.

It supersedes these rules. All other rules of the named records stay in force.

- [0027](0027-actions-and-approval.md), "The gate": a `change` call in an `untrusted` Turn needs Approval. "Temporary paths": no Auto-review, and work on #140 starts only after the first `approve`-class tool exists.
- [0029](0029-untrusted-tool-results.md): the same rule for a `change` call after an untrusted tool result.
- [0034](0034-architecture-review-changes.md), "A Side Session follows its Trust Level": `close_open_loop` is denied in an `untrusted` Side Session.
- [0036](0036-mcp-connections.md), "Approval" and "`capture_note` in an untrusted Turn": a `change` call, and an edit or a link to an existing Note, need Approval.
- [0038](0038-conversation-tool-history.md), "Reply guard": code runs the model step again for a reply that holds only Stubs. A Turn that stops at the refusal limit is the exception: it sends no text of the model, so it has no Stub check and no new model step.

## Decision

### When the reviewer runs

- The gate sends a `change` call of an `untrusted` Turn to the reviewer. A call of an `owner` Turn and a `read` call get no review.
- The two exceptions of the gate come first, so these calls get no review: a call whose tool marks its work `untrusted` (a new Note with no links), and, in a Side Session, a call of a tool with a code-written input (`set_schedule`).
- An `approve`-class call always asks the Owner. The reviewer never sees it.
- The Risk Class decides, with no list of tools. So `disconnect_mcp_connection` and an MCP tool of the class `change` can also run after `allow`. The MCP Catalog gives each write to an external service the class `approve`.

### What the reviewer reads

- The messages that the Owner sent: the messages of the Burst of the Turn, and the newest `autoReviewRecentOwnerMessages` (10) earlier messages that were not forwarded. Code reads them from the Inbox, which holds only what the Channel received from the Owner. A forwarded message of the Burst is a line with no text and no sender.
- The planned call: the tool name and the frozen input.
- Two facts that code writes: the local time of the Owner, and the time of each message.
- Nothing else: no tool result, no text that the model wrote, no code summary of the call, no Note, and no Profile entry. Code removes Operator secrets from the messages.

A call that names existing data only by an id gives the reviewer no way to check the target, so its instructions say to ask.

An earlier message asked for its change at an earlier time, and the reviewer cannot see if it was done. So its instructions count it only when a message of the Burst continues it, or when it is a standing instruction to make this kind of change each time something happens. An earlier request to set or change something, for example a Reminder with a due time in the future, counts one time. In every other case they say to ask. This is a rule for the model, not a check in code.

### What the reviewer answers

- One JSON object: `allow`, or `ask` or `refuse` with a reason. Code decodes it with a Schema.
- `allow`: the call runs like an approved call, with no tap.
- `ask`: the Owner gets the Pending Approval, with the reason under the code summary as "Why this asks: <reason>". Code redacts the reason, puts it on one line, cuts it at 200 characters, and stores it in the column `reviewer_reason`. The line goes away when the Owner answers. The reason never replaces the summary, and no later model request holds it.
- `refuse`: the call does not run, and the model gets the reason as the tool result.
- Code answers `ask` with no reason, and makes no Pending Approval run, when the model call fails, when it passes `autoReviewTimeoutMillis` (45 seconds), when the answer is not valid, when the review or its record fails, when the daily budget is spent, when no message with the Owner's own words exists, and when the input holds an Operator secret (then the draft refuses the call, as before). It never answers `allow` by itself.

### Limits

- **Refusals.** After `autoReviewMaxRefusals` (3) `refuse` answers in one Turn, code reviews and runs no more `change` calls in that Turn, also a call of the same model step that the reviewer allowed before or that needs no review, makes no more model step, and sends only a fixed line: "I stopped here: a safety check refused several changes that your messages did not ask for, so I did not make them. If you want one of them, tell me directly." The model wrote the text of that step before it got the refusals, so it can claim a change that did not run. Code sends none of it. So the reply also does not name a change that ran earlier in the Turn. Approval buttons of the same step still go with the line. The Trace keeps the text of the model.
- The count of refusals lives in the running Turn. A Turn that runs again after a Restart or a reset starts a new count. The step limit and the daily budget still bound it.
- **Cost.** Each Owner has a daily token budget for the reviewer, `autoReviewDailyTokenBudget` (200,000 input and output tokens, local day of the Owner). Over it, code asks the Owner with no model call. A step limit and the refusal limit bound one Turn.

### What the Owner sees for `refuse`

The model gets the reason and answers the Owner in its own words. The rules of the outcome tools already refuse silence and a reaction after a failed changing call, so the Owner always gets a text. Code writes its own line only at the refusal limit.

### Side Sessions

A Side Session cannot ask the Owner. `allow` runs the call. Every other answer denies it with the reason that an `untrusted` Side Session already used. The refusal limit also counts there.

### Model

- The Model Task `auto_review` has its own route, `reviewer`, in `MODEL_ROUTES`. For now it has the model and the reasoning effort of a reply: `@cf/deepseek-ai/deepseek-v4.1-flash-1017` with `none`. The repository owner decided this on 2026-11-28. It replaces, for now, the rule of #140 that the reviewer is a strong model with reasoning and not the reply model. A stronger model comes later, as a change of this route only. The answer is plain JSON text, with no tool call and no response format, so the route can change to another provider.
- The reviewer sits behind the `Reviewer` service. The model reviewer is one layer of it.

### Records

- One `AutoReviewed` Journal Entry for each review: the tool, the answer, and, when code answered by itself, the cause. No input text and no reason text.
- The Trace of the Turn lists each review with the tool call id, the tool, the answer, and the reason.
- Usage rows of the Model Task `auto_review`, with the Event id of the Turn.

### Proof

`apps/agent/control/auto-review/fixed-set.ts` is the fixed set: changes that the Owner asked for, which must be allowed, and changes that the Owner did not ask for, with instructions inside the tool-call arguments, which must not be allowed, in Polish and English. No agent run changes a case to make a result pass. A change of the set needs the repository owner. `pnpm control review-set --k <n>` runs it on the real model. It costs money, so an agent runs it only with the owner's approval ([0037](0037-agent-merge-and-automations.md)).

### Rollback

A version before this decision cannot read the `AutoReviewed` Journal Entry, so a rollback to it stops the recovery of an Event that has one and is not settled ([0024](0024-reaction-plan-on-reply-planned.md) and [0025](0025-restart-mid-turn.md) name this risk). The rollback plan: fix forward, or roll back only to a version that reads the Entry. No production Instance exists ([#190](https://github.com/kacperborowieckb/billy/issues/190)), so no stored Entry can meet an earlier version today. The new column of `pending_approvals` is nullable, and an earlier version does not read it.

## Why

Before this decision, each change after outside text asked the Owner, also a change that the Owner had just asked for in plain words. The reviewer reads only the Owner's words and the planned call, so text from outside reaches it only through the arguments of the call. Claude Code auto mode and LlamaFirewall AlignmentCheck use the same input rule ([auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode), [LlamaFirewall](https://arxiv.org/html/2505.03574v1)). The risk that stays is a wrong `allow`: a changed Note, Schedule, Profile entry, or preference. Writes to external services and Forget keep the button.

A typed decision model (Jev, `typesafe/jev`) was not chosen. It returns no reason for the Owner, independent tests show it weak under attack ([Check Point](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/), [Datadog](https://securitylabs.datadoghq.com/articles/jev-as-a-judge-how-counterfeit-policy-steers-jev/)), Polish is not documented, and the product is new.

## Rejected options

- **The code summary of the call as reviewer input.** It resolves ids to Note texts, which can be Untrusted Content or model text.
- **A reason that code picks from a fixed list.** It cannot say what does not fit the request. The cut, one-line, labelled reason keeps the code summary as the text that the Owner approves.
- **A line from code for every refusal.** The model already must answer in text, and one refusal is often a model mistake.
- **No cost limit.** A forwarded message can make a model call changing tools again and again in many Turns.

## Revisit if

- A stronger reviewer model is chosen. Then change the `reviewer` route and run the fixed set on it.
- The fixed set or real use shows a false `allow`. Then remove that tool from the review, or strengthen the instructions and run the set again.
- `ask` is common for changes that name data by an id. Then give the reviewer the Owner-written fields of that data.
- The budget is spent in normal use.
- Jev, or another fast model, passes the fixed set with no loss as a first stage.
