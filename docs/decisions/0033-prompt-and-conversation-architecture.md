# 0033: Prompt and Conversation architecture

Status: accepted

Partly superseded: [0034](0034-architecture-review-changes.md) changes four rules. A Side Session follows its Trust Level, and a Proactive Turn has change tools, so "the change tools are missing" is not true for it. The Stub of an MCP result keeps ordered ids. Compaction marks the rows that the Summary replaces and does not delete them: they stay until the Trace retention ends, and a Trace points to the rows and holds no copy. The check for Compaction reads the token count of the provider.

Partly superseded: [0035](0035-summary-open-items.md) changes the rule that the `compaction` prompt names Notes by id. The model writes the Summary prose with no ids. Code adds the open items with their ids.

Date: 2026-11-23

Issue [#179](https://github.com/kacperborowieckb/billy/issues/179) (measure and decide). Issue [#182](https://github.com/kacperborowieckb/billy/issues/182) builds this decision. The measurement, with its method and all numbers, is in [the prefix cache research](../research/2026-11-23-prefix-cache-measurements.md).

It supersedes these rules. All other rules of the named records stay in force.

- [0009](0009-agent-loop-and-client-boundaries.md), "Message storage": every tool result of a Turn replays in full in the next Turn. A result that is Untrusted Content or large is now stored as a Stub.
- [0015](0015-scheduled-task-turn.md), "Input" and "Result": the system prompt of a Scheduled Task Turn has the sections of a reply Turn, and the prompt and the result enter the Conversation history.
- [0019](0019-proactivity.md): the place of the Open Loops in reach and of the connected Proactive Message ("in its system prompt"). The content stays, the place changes.
- [0030](0030-untrusted-context-of-a-turn.md), "How code checks it": the marker of Untrusted Content stays in the recent Conversation until it leaves a window.
- [0032](0032-pending-approval-keeps-its-trust.md): only the place of the list of open Pending Approvals ("its system prompt"). It moves to the Turn Context Block.

## Facts that the decision uses

Measured on 2026-11-23 with real calls to `@cf/deepseek-ai/deepseek-v4.1-flash-1017` through AI Gateway (`/compat`), and with real Turns in the local Worker:

- The model caches prefixes, and the gateway returns the count in `usage.prompt_tokens_details.cached_tokens`. The AI SDK already maps it to `cachedInputTokens`.
- The order in the prompt of this model is: system message, tool definitions, messages. A change in the system message makes the tool definitions and the full history uncached. A different tool set keeps the system message cached.
- An Owner message request is about 10,500 tokens before any long chat: system text about 3,000, the 17 tool definitions about 6,500, history the rest.
- The cache has blocks of 64 tokens and a minimum of 128 to 192 tokens. A cached prefix was still a full hit after 60 minutes. The lifetime above 60 minutes was not measured.
- `x-session-affinity` made no difference at our traffic: 6 of 6 hits with it and 6 of 6 without it.
- The cached input price is $0.006 per million tokens, and the input price is $0.30 per million tokens.

**Hit rate before the change** (cached input tokens / input tokens, 34 model calls in 16 Turns):

| Turn kind | Step 1 (cross-Turn) | Step 2 and later (in-Turn) | Share of input tokens |
| --- | --- | --- | --- |
| `reply` | 47.2% | 97.1% | 83.7% |
| `scheduled_task` | 54.1% | 93.8% | 6.8% |
| `proactive` | 33.5% | 91.2% | 9.5% |

Step 1 is all or nothing. It was 99% when two Turns ran in the same minute with fewer than 20 stored messages, and 22% to 26% in every other case, which is only the system text before the time line. The test driver sent messages seconds apart, so the run is too good for real use: with Turns more than one minute apart, each step 1 call before the change reuses about 24%.

**Step 1 of the 12 Owner message Turns, before and predicted after.** The same 12 Turns were sent again in the layout of this decision. The first call of a run is cold in both layouts, so the table gives both populations:

| Population | Before the change, in the run | Predicted after the change |
| --- | --- | --- |
| Turns 2 to 12 (the first, cold call left out) | 48.9% | 96.2% (91.6% to 98.6% per Turn) |
| All 12 Turns | 47.2% | 90.9% |

#182 measures the real value with the same method and reports Turns 2 to 12.

### Corrections to the findings of #179

- Finding 2: the window is 20 stored messages, not 20 Turns. One Owner message Turn with two tool calls stores six messages.
- Finding 4: tool definitions do not come first for this model. The system message comes first.
- Finding 5: a Reminder also writes `role: "user"` text ("A Schedule fired ...") before the sent text.
- `turn_model_steps` holds only a step counter. The step content of a Turn is in `turn_progress`, and its rows are never deleted today.
- The claim that the prefix of a daily Brief hits the cache of the Brief of the day before has no evidence. Do not count on it.

## Decision

### The rule

The request of a session is append-only. Each request starts with the bytes of the Conversation as code stored it. Only the new tail is uncached. A cache miss that code did not plan is a bug.

The planned misses are: the first call after a Compaction, a changed Owner Context Block, a Forget, a Stub in the Turn before, a deploy that changes the system text or a tool definition, and the first call after the cache lifetime.

### Request layout of the main Conversation

```
1. System message          fixed instructions and the texting style of the Instance.
                           No time, no Profile, no situation, no Owner data.
2. Tool definitions        the fixed tool set of the Turn kind, in a fixed order.
3. Owner Context Block     Profile, time zone, MCP Connections with their states,
                           and the MCP Catalog entries that are not connected.
4. Summary                 the one rolling summary, when it exists.
5. History                 append-only.
6. Turn Context Block      current time and situation, at the start of the new
   + new Owner message     Owner message.
```

- The system message is the same bytes for every Owner of an Instance and every Turn of one kind.
- The Owner Context Block is one message that code writes. Code replaces it only when its content changes. That is one planned miss on the history, and the system message and the tool definitions stay cached.
- The Turn Context Block holds the current time and the situation: the open Pending Approvals, the connected Proactive Message with its Open Loops, the Restart note, and the lateness note. Code stores it in the Conversation as it was sent, so the next Turn sends the same bytes. Each Owner message in the history then also shows when it was sent.
- Both blocks are `user`-role messages with a label that code writes. Text from an MCP server never goes into the Owner Context Block: the names come from the MCP Catalog.

Reason: the measured order makes every byte of the system message a key for all that follows. The Profile and the Connection states change rarely, so one block after the tool definitions costs one small miss per change. The time changes in every Turn, so it must be in the tail.

### History and Compaction

- The history is shortened only by Compaction. No message is dropped one at a time.
- **When.** When the Turn loop has no due Event, code checks the token count of the stored history against a limit from the Behavior Config. Over the limit, Compaction starts. It runs after the Delivery of the Turn that passed the limit, so it never delays a reply, and the cache is warm.
- **What.** Compaction replaces the oldest part of the history with one Summary. The block always ends at the end of a delivered Turn. The newest part stays word for word. Each Compaction reads the old Summary and the block and writes one new Summary, so exactly one Summary exists and its size has a limit.
- **Who.** A new Model Task `compaction` with its own route (default: the reply route), a fixed prompt, and no tools. It gets the old Summary and the block as data to summarize, not as a conversation to continue (the pattern of the Judge, [0011](0011-eval-runner.md)). Code checks the size of the result. Usage is recorded under `compaction`.
- **First values** (guesses in the Behavior Config): limit 30,000 history tokens, keep the newest 8,000 tokens, Summary at most 1,500 tokens.
- **The Summary is not the memory.** The Profile is outside it and is never compacted. Notes and the Journal hold what must last. The Summary and the newest Turns are the short memory of the chat.

**Restart and reset** ([0025](0025-restart-mid-turn.md)):

- Compaction has no stored plan. Code derives it from the token count at each check.
- A Restart happens before Delivery and writes nothing to the Conversation. The steps of a running Turn are in Turn progress. So a running Turn or a restarted Turn is never in a block.
- The Summary and the delete of the rows that it replaces are one transaction.
- An Owner Burst that becomes due stops the Compaction call, and the Turn goes first. After a stop, a failure, or a reset, nothing was written, and the next check starts Compaction again.
- A Turn reads the history one time at its start. A Turn after a reset reads the history again, with its steps from Turn progress. That costs one cache miss and no correctness.

Reason: a chat that lasts months needs a request with a fixed maximum size. A rolling Summary gives that with one planned miss per 40 to 60 Turns. The trigger after the Turn gives the warm cache that the idle timer of the [feasibility research](../research/2026-11-12-cloudflare-feasibility.md) wants, with no extra alarm path.

### Untrusted Content and Stubs

- The Turn that receives Untrusted Content (a forwarded message, an untrusted Note in a tool result, an MCP result, the untrusted Open Loops of a connected Proactive Message) sees it in full and is `untrusted`, as [0029](0029-untrusted-tool-results.md) and 0030 say.
- When code stores that Turn in the Conversation, it replaces each part with the Untrusted Content marker by a Stub: a short text that code writes, for example `[Forwarded message from Ana. Kept as Note n_12]` or `[search_notes returned 3 Notes: n_4, n_7, n_9]`.
- A trusted tool result above a size limit from the Behavior Config is also stored as a Stub. Small trusted results stay in full.
- **No model text of an `untrusted` run is stored.** Text that the model wrote after it read Untrusted Content can repeat that content with no marker. So the stored form of an Owner message Turn that was `untrusted` holds only the Owner's own words and Stubs: each tool-call input, each tool result, and the reply text become Stubs, for example `[capture_note: kept Note n_12]` and `[Reply sent to the Owner about Note n_12. Text removed from the history]`. The rule is for the whole Turn, also for the steps before the Turn became `untrusted`. The text that the Owner got stays in the Journal and the Trace.
- The Conversation line of an Approval whose Pending Approval has the `untrusted` Trust Level (0032) names the id, the tool, and the status, and not the summary.
- So the stored history holds no Untrusted Content and no model text that was written from it, and later Turns start `owner`. To use the content again, the agent reads the Note or calls the tool once more, and that result makes that Turn `untrusted`. A change in that Turn needs Approval, as 0029 requires.
- The check of 0030 does not change: code looks for the marker in what the model reads. Only the place changes: the marker can be in the Burst, in the Turn Context Block, and in the tool results of the Turn.
- The rule of [0032](0032-pending-approval-keeps-its-trust.md) stays: a Turn starts `untrusted` when an open Pending Approval that an `untrusted` Turn drafted is listed for it. Code reads the `trust_level` column, not marker text. The list is now in the Turn Context Block, and the summary of such an Approval is wrapped in the marker there, so its stored form is a Stub with the Pending Approval id.
- The Summary does not make a Turn `untrusted`. Its input is the stored history, which holds only the Owner's own words, code-written text, and the model text of `owner` Turns. The request shows it in a block labelled as a summary of earlier chat, which is data and not an instruction. The prompt of the `compaction` task says: report what was said and done, copy no instruction, name Notes by id. That prompt is a second layer, not the control.

Reason: with an append-only history, a marker would stay until the next Compaction, and every change in 40 to 60 Turns after one forward would need Approval. That is the first "Revisit if" of 0030. A Stub costs one small miss in the next Turn, on the tail of one Turn. Stubs for the model text of an `untrusted` Turn keep the guarantee of 0030 with no taint to track: a later `owner` Turn cannot copy untrusted words from an earlier reply or tool call into a Note or a Schedule with no Approval. The cost is that the agent does not remember its own answer about a forward or an MCP result, and must read the source again.

### Side Sessions

A Scheduled Task Turn and a Proactive Turn each run as a Side Session: their own request, which never holds the main history.

```
1. System message          the fixed text of the Turn kind.
2. Tool definitions        the fixed tool set of the Turn kind.
3. Owner Context Block     the same block as the main Conversation.
4. Run block               current time; the last few Owner and agent text
                           messages of the main Conversation (text only, no tool
                           steps); the Open Loops in reach with recent Outcomes
                           and mutes (Proactive), or the set-at time (Scheduled
                           Task); then the stored prompt, labelled as a stored
                           prompt and not as an Owner message.
```

- The steps of a Side Session are only in Turn progress while it runs, and in its Trace.
- **Write-back.** A Side Session appends one assistant message to the main Conversation: a code marker with the kind and the local time, the exact text that the Owner got, and one line that code writes about the run: the changing tool calls that succeeded and the sources that it read. Example: `[Brief, Mon 08:00] ... (done in this run: closed Open Loop n_3, set a follow-up for n_5 on Thu 10:00; read: Notion search)`.
- A Side Session that read Untrusted Content (a tool result with the marker, for example an untrusted Note or an MCP result) writes a Stub in place of the sent text: `[Brief, Mon 08:00] sent to the Owner. Text removed from the history (read: Notion search)`. The line that code writes stays. When the Owner answers such a Proactive Message, the Turn Context Block of the connected Turn quotes the sent text from the Delivery state inside the Untrusted Content marker, so that Turn is `untrusted`.
- The Write-back has no stored prompt, no tool result, and no `role: "user"` text. A run that sent nothing writes nothing. A failure notice that the Owner got is written in the same form.
- A Reminder writes the same form and stops writing "A Schedule fired" as `role: "user"`.

Checked in code, with no change needed:

- "Less of this": code connects the next Owner message to the Proactive Message at receive time, and `mute_proactive_message` resolves its target from that connection. It does not read the Conversation.
- Outcomes come from Journal Entries of the connected Turn.
- Only Owner message Turns create Pending Approvals ([0027](0027-actions-and-approval.md)). The Conversation line of an answered or expired Approval is an appended assistant message, which fits the rule.

Reason: measured, each Scheduled Task Turn stored four to six messages in the main Conversation, and the next Owner message Turn missed the cache. The stored prompt was read as an Owner message. With MCP ([#153](https://github.com/kacperborowieckb/billy/issues/153)) the results of a Side Session are large Untrusted Content. The state that a Brief needs is in Notes, Open Loops, Schedules, Outcomes, and the Profile, not in the chat. The cost difference between the options is below $0.01 per run, so the choice is about quality and safety.

### Tool sets

- Each Turn kind keeps its own tool set. Inside a kind, the content and the order are fixed: no tool is added or removed by Trust Level, by the connected MCP servers, or during a Turn.
- Safety when the Owner is absent is by construction: the change tools are missing. The Risk Class gate (0027) stays as the second layer.
- A test proves that the serialized tool definitions of a kind are the same bytes between Turns.

### MCP ([#150](https://github.com/kacperborowieckb/billy/issues/150), [#151](https://github.com/kacperborowieckb/billy/issues/151), #153)

- The names and states of the MCP Connections, and the MCP Catalog entries that are not connected, are in the Owner Context Block. A state change is one planned miss. This replaces "the system prompt lists only the names and states" of #150 and #151: the content is the same and the place is the block.
- The four MCP tools of #150 do not change with the connected servers, so the tool definitions stay fixed.
- Every MCP result is Untrusted Content, so the Stub rule covers it with no new mechanism. The Stub names the Connection, the tool, and the status, for example `[Notion search: 4 results, removed from the history. Call the tool again to read them]`. Code stores no copy of the result for the history (vision: pointer Notes, no copies).
- The MCP results of a Side Session never reach the main Conversation. Its Write-back names what it read.

### Forget ([#138](https://github.com/kacperborowieckb/billy/issues/138))

After #182:

- `conversation_messages` holds only the main Conversation: Owner messages with their Turn Context Block, the steps of the agent with Stubs, replies, Write-back lines, Approval lines, and the one Summary. Each row records its Turn Event id and a row kind, so Forget finds the rows of a Turn with no text search.
- Compaction deletes the rows that the Summary replaces. The Trace and the Journal stay the long-term record.
- `turn_progress` rows of a Turn are deleted when its Event is done, for all Turn kinds. `turn_model_steps` holds only the step counter.
- A Summary is never edited. A Forget deletes the Summary row and redacts the Conversation rows of the forgotten Turns in place to a Stub. The next Compaction writes a new Summary from what is left.

For #138 to solve: each Trace stores the full request, so the Summary and the history are copied into every later Trace. Finding the Traces by the Turns that created a Note does not cover those copies.

Reason: code cannot prove which words of a model-written Summary are about a subject. Dropping the Summary proves that the content is gone from the prompt.

### Model, session affinity, metric, and gateway cache

- **Model.** Keep `@cf/deepseek-ai/deepseek-v4.1-flash-1017`. It caches prefixes and reports cached tokens through AI Gateway.
- **Session affinity.** The Model Gateway sends `x-session-affinity` on every model call. The value is one stable opaque id per Owner, a hash of the Owner Id. One id covers the main Conversation and the Side Sessions.
- **Metric.** One Operator metric data point per model step: the Turn kind, the step number (1 is cross-Turn, 2 and later is in-Turn), the input tokens, the cached tokens, the minutes since the earlier call of that session, and the planned-miss reason when code knows one.
- **Guard.** The guard against a regression is a test in `pnpm verify`: two Turns in a row send a byte-identical prefix, for each Turn kind.
- **Alert.** `pnpm control doctor` reads the metric and fails when the hit rate of calls with no planned miss is below a limit. First values, over 24 hours: step 2 and later below 90%, step 1 inside 60 minutes below 80%.
- **Gateway response cache.** The gateway setting stays off, and the deploy steps say so. The Model Gateway also sends `cf-aig-skip-cache: true` on every model call. The `MISS` status in the gateway logs is the response cache and not the prefix cache.

### Migration

The versioned migration of #182 deletes the existing `conversation_messages` rows and adds the new columns. The agent forgets the recent chat one time. Notes, the Profile, Schedules, and the Journal stay. No production Instance and no real Owner exist.

## Why

Each Turn sends the system text, the tool definitions, and the history. Before this decision, the first model call of almost every Turn read about 76% of its input uncached, because the time line was in the system message and the history was a moving window. The cached price is 2% of the input price, and a cached first step was also faster in the measurement (about 1.1 to 1.9 seconds against 2.9 to 5.6 seconds, with different output lengths).

The larger gain is quality and safety. Side Session internals no longer push real chat out of the history. A stored prompt is no longer read as the Owner's words. Untrusted Content no longer stays in the context of later Turns. One rule, "the request is the stored Conversation plus a new tail", can be tested byte for byte.

## Rejected options

- **Profile in the system message.** A Profile change would also make the 6,500 tokens of tool definitions uncached, and the system message would differ for each Owner.
- **A new context block appended on each Profile change.** No miss, but old Profile versions stay in the history and the model can read a stale rule.
- **Profile in every Turn Context Block.** The Profile tokens are uncached in every Turn and stored again in every Turn.
- **Compaction when the Owner is idle, or before the Turn.** The idle timer adds an alarm path for a gain that the trigger after the Turn already gives. Compaction before the Turn delays a reply.
- **Cut old blocks with no Summary.** The agent would lose all short memory of the chat that made no Note.
- **Summary from a fork of the main request.** The cheapest call, but the summarizer has the tools and reads the history as a conversation, so an injected instruction has more reach.
- **Summary from code only.** It loses all of the chat that made no Journal Entry.
- **Untrusted Content in full until Compaction, or Compaction after every Untrusted Content.** The first makes the Owner tap Approve for many Turns. The second costs a summary call after every forward.
- **A Summary that carries a taint.** A rolling Summary would stay `untrusted` for ever after the first forward.
- **Reply text of an `untrusted` Turn kept in the history.** With no marker, a later `owner` Turn can act on words that came from Untrusted Content. With the marker, every later Turn stays `untrusted` until a Compaction, which then must run after every forward and every MCP read.
- **A stored Compaction job.** One more state to keep consistent, for no gain over the derived check.
- **Side Session as a fork of the main Conversation.** It sends 10,000 to 40,000 tokens per run, needs one tool set and one system text for all kinds, and leaves safety to the gate alone. It wins only when side work needs the whole chat.
- **A Side Session with no chat at all.** A Brief could repeat what the Owner and the agent settled ten minutes ago.
- **A model-written note in the Write-back.** Model text from a run that read untrusted Notes or MCP results would enter the main history.
- **One tool set gated by Risk Class.** Each Side Session would send 6,500 tokens of tools that it cannot use, and a blocked call costs a step.
- **MCP states in the Turn Context Block or the system message.** The first stores the list again in every Turn. The second makes the tool definitions uncached on every state change.
- **An MCP result kept as a Note.** It copies service data into Billy, against the vision, and Forget must then delete it.
- **Compacted rows kept as an archive.** One more permanent copy of all chat, in a product that promises to really delete.
- **A model that rewrites the Summary on Forget, or one Summary per block.** Nobody can prove the first. The second sends more summary text in every request.
- **No session affinity, or one id per Turn kind.** The first risks the hit rate under load. The second gives no gain, because requests with different prefixes share no cache.
- **An automatic notice to the Operator.** The Instance has no Operator notice path yet.
- **Migration by converting rows, or by folding old rows into the first Summary.** No production data exists, so the simplest path is correct.
- **Another model.** DeepSeek V4 Flash and Pro, GLM 5.2, 5.3, and 5.3 Flash, Kimi K2.5, K2.6, and K2.7 Code, and Inkling 2 Small also have a cached input price on Workers AI. No reason to change exists.

## Revisit if

- The step 1 hit rate of Owner message Turns after #182, with the same method and with the first, cold call of the run left out, is below 90%.
- Owners set Scheduled Tasks that need the chat history. Then give Side Sessions a read tool for the stored Conversation, not the full history in the prompt.
- Owners often ask a follow-up question about a forward or an MCP result, and the second read with its Approval is a burden. Then keep the reply text for the next Turns inside the marker and compact it away, and measure the cost.
- A Brief that read an MCP result makes the answer of the Owner an `untrusted` Turn, so "less of this" needs Approval. Then give `mute_proactive_message` a rule of its own.
- The agent asks the Owner again for things from Stubs, or calls tools again so often that it costs more than the Stubs save.
- Owners use Forget often and the loss of the Summary hurts.
- The first values of Compaction give a Summary that loses what the Owner still talks about, or the planned misses are more than one in 30 Turns.
- The route of `reply` changes to a model with another prompt order, a cache lifetime below the usual gap between Owner messages, or no cached price. Run the measurement again before the change.
- The hit rate drops with more Owners. Then check session affinity first.
- An Operator alert channel exists. Then send the hit rate alert there.
- A live Instance has an Owner before #182 ships. Then the migration must keep the newest messages.
- The tool definitions grow above 8,000 tokens. Then shorten the descriptions or load schemas on demand.
