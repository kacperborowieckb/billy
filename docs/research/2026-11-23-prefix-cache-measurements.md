# Prefix cache: provider facts and Hit Rate before and after the change

Date: 2026-11-23

Issue: [#179](https://github.com/kacperborowieckb/billy/issues/179). Decision: [0033](../decisions/0033-prompt-and-conversation-architecture.md). Code on `main` at `a1287c5`. [Part D](#part-d-results-after-the-change) measures the code of [#182](https://github.com/kacperborowieckb/billy/issues/182) on 2026-11-25 ([#202](https://github.com/kacperborowieckb/billy/issues/202)).

The repository owner approved the real model calls (decision [0002](../decisions/0002-agent-authority.md)). All content was synthetic. This record has no tokens, account ids, or URLs.

## Sources

Cloudflare docs, read on 2026-11-23: [Workers AI prompt caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [the model page](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/), [AI Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/), [AI Gateway and Workers AI](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/), [AI Gateway chat completion](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/).

What the docs state:

- Prefix caching is automatic for select models. "A single token difference invalidates the cache from that point onward."
- "Place static content first", "avoid timestamps in system prompts", and "tools are part of the prompt prefix".
- `x-session-affinity` "routes requests with the same identifier to the same model instance". The docs show it only for the REST API and the Workers binding.
- `@cf/deepseek-ai/deepseek-v4.1-flash-1017`: $0.30 per million input tokens, $1.20 per million output tokens, $0.006 per million cached input tokens.
- Models with a cached input price: DeepSeek V4 Flash, V4.1 Flash, and V4 Pro, GLM 5.2, 5.3, and 5.3 Flash, Kimi K2.5, K2.6, and K2.7 Code, Inkling 2 Small.
- The AI Gateway response cache is off by default. Its key is an exact match of the full request.

What the docs do not state: the cache lifetime, the minimum prefix size, the name of the usage field, and if `x-session-affinity` works through AI Gateway. The measurement answers these.

## Method

A recording proxy on `127.0.0.1` sat between the caller and the gateway URL of the Instance (`.../compat`). For each call it kept the request body and the `usage` object of the response, and it stopped all calls at 2,000,000 input tokens. Hit rate is `usage.prompt_tokens_details.cached_tokens / usage.prompt_tokens`.

- **Part A, provider probes.** Direct chat completion calls with the headers that the Model Gateway sends, `max_tokens: 1`, and `reasoning_effort: "none"`. Each probe starts its system message with a new random text, so no probe reads the cache of another probe. Each probe sends a request (prime), waits 1.5 seconds, and sends the next request.
- **Part B, real Turns.** A driver started the real Worker in the wrangler test harness (the Eval entry `eval/worker.ts`, temporary local storage, the fake Telegram API), with `AI_GATEWAY_URL` set to the proxy. One Owner sent 12 messages: time zone, two Captures, two Recalls, two Scheduled Tasks set for some minutes later, small talk, two moves of the Brief to some minutes later, "less of this", and a closed task. The driver waited until each Schedule fired, so the run has 2 Scheduled Task Turns and 2 Proactive Turns between the Owner message Turns. The loading of the local values file was off for the run (`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`), because that file overrides the variables of the harness.
- **Step 1 and later steps.** A call whose last message has the role `user` is step 1 of a Turn (cross-Turn reuse). Every other call is a later step (in-Turn reuse).
- **Part C, replay.** A script rebuilt the stored history from the recorded Part B requests and sent step 1 of each Owner message Turn again in the layout of decision 0033: the fixed part of the system text, the same tool definitions, an Owner context block, the append-only history with the time and the situation at the start of each Owner message, and each side Turn as one assistant line. `max_tokens: 1`.

The scripts were temporary and are not in the repository. #182 measures the result with the same parts B and the same hit rate definition.

## Part A results

| Probe | Result |
| --- | --- |
| Same request two times, 4,024 input tokens | First call 0 cached. Second call 3,904 cached. The field is `usage.prompt_tokens_details.cached_tokens`. |
| Session affinity, 6 pairs each | Without the header: 6 of 6 hits, 3,904 cached. With the header: 6 of 6 hits, 3,968 cached. |
| Minimum prefix | 122 tokens: 0 cached. 223: 192. 520: 512. 1,021: 960. 2,022: 1,984. Blocks of 64 tokens. |
| Cache lifetime | A full hit (3,904 of about 4,020) after 1, 5, 15, 30, and 60 minutes, with and without the header. Not measured above 60 minutes. |
| Different tool set, same system message | 2,176 of 2,818 cached: the system message stays cached, and all text after it is read again. So the order is system message, tool definitions, messages. |
| Same tool set, different system message | 0 cached. |

Layout probes, with a system text of about 3,000 tokens and exchanges of about 600 tokens:

| Request                                                | Input | Cached |
| ------------------------------------------------------ | ----- | ------ |
| Time line at the end of the system message, Turn 1     | 3,351 | 0      |
| Same time line, one exchange appended                  | 3,965 | 3,328  |
| New time line in the system message, one more exchange | 4,579 | 3,008  |
| Same time line, the window moved by one exchange       | 4,579 | 3,008  |
| Time in the new message, Turn 1                        | 3,351 | 0      |
| Time in the new message, new time, Turn 2              | 3,993 | 3,328  |
| Time in the new message, new time, Turn 3              | 4,635 | 3,968  |

A new time line in the system message, or a moved window, keeps only the system text before the time line.

Gateway settings, read from the Cloudflare API: Authenticated Gateway on, response cache off (`cache_ttl` 0), logs on.

## Part B results: the layout before the change

34 model calls in 16 Turns.

| Turn kind | Calls | Step 1 input | Step 1 cached | Step 1 hit rate | Later steps hit rate | All calls hit rate | Share of input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reply` | 25 | 128,040 | 60,480 | 47.2% | 97.1% | 73.4% | 83.7% |
| `scheduled_task` | 5 | 8,511 | 4,608 | 54.1% | 93.8% | 78.4% | 6.8% |
| `proactive` | 4 | 14,711 | 4,928 | 33.5% | 91.2% | 63.5% | 9.5% |
| all | 34 |  |  |  |  | 72.8% | 100% |

Step 1 of the 12 Owner message Turns:

| Turn | Condition | Input | Cached | Hit rate | Call time |
| --- | --- | --- | --- | --- | --- |
| 1 | First call | 9,564 | 2,496 | 26% | 5.0 s |
| 2 | The time zone was set in Turn 1, so the time line changed | 9,641 | 2,496 | 26% | 3.3 s |
| 3 | Same minute | 10,228 | 10,112 | 99% | 1.9 s |
| 4 | Same minute | 10,422 | 10,304 | 99% | 1.1 s |
| 5 | Same minute | 10,701 | 10,560 | 99% | 1.9 s |
| 6 | New minute, more than 20 stored messages | 10,904 | 2,496 | 23% | 3.6 s |
| 7 | Same minute, window moved | 10,587 | 9,408 | 89% | 1.7 s |
| 8 | After a Scheduled Task Turn | 10,566 | 2,496 | 24% | 3.6 s |
| 9 | After a Scheduled Task Turn | 10,473 | 2,496 | 24% | 3.5 s |
| 10 | After a Proactive Turn | 11,742 | 2,560 | 22% | 5.6 s |
| 11 | Same minute, but the situation text changed | 11,445 | 2,496 | 22% | 2.9 s |
| 12 | After a Proactive Turn | 11,767 | 2,560 | 22% | 3.7 s |

- The 2,496 cached tokens of a miss are the system text before the first line that changes.
- The request of an Owner message Turn was 9,564 to 11,954 tokens. By characters, the system message was 26% to 32% of it and the tool definitions were 54% to 67%.
- The Turns 3, 4, 5, and 7 hit because the driver sent them in the same minute as the Turn before. A real Owner seldom does that. With Turns more than one minute apart, the step 1 hit rate is 22% to 26%, about 24%.
- A Scheduled Task Turn stored 4 to 6 messages in the main Conversation, and a Proactive Turn stored 4 to 5.
- Call times include different output lengths, so they are an indication only.

## Part C results: the layout of decision 0033

Step 1 of the same 12 Owner message Turns, sent again:

| Turn     | Messages | Input  | Cached | Hit rate |
| -------- | -------- | ------ | ------ | -------- |
| 1 (cold) | 3        | 9,595  | 1,856  | 19.3%    |
| 2        | 7        | 9,746  | 9,472  | 97.2%    |
| 3        | 13       | 10,375 | 9,728  | 93.8%    |
| 4        | 18       | 10,611 | 10,368 | 97.7%    |
| 5        | 22       | 10,932 | 10,560 | 96.6%    |
| 6        | 26       | 11,281 | 10,880 | 96.4%    |
| 7        | 30       | 11,590 | 11,264 | 97.2%    |
| 8        | 34       | 11,754 | 11,584 | 98.6%    |
| 9        | 39       | 12,108 | 11,712 | 96.7%    |
| 10       | 46       | 13,207 | 12,096 | 91.6%    |
| 11       | 50       | 13,434 | 13,184 | 98.1%    |
| 12       | 55       | 14,114 | 13,376 | 94.8%    |

Turns 2 to 12: 129,152 input tokens, 124,224 cached, **96.2%**. All 12 Turns, with the cold first call: 138,747 input tokens, 126,080 cached, 90.9%. The layout before the change, for the same two populations: Turns 2 to 12 had 118,476 input tokens and 57,984 cached, 48.9%, and all 12 Turns had 47.2%. Compare like with like: 48.9% against 96.2%, or 47.2% against 90.9%. The uncached part of each call is the tail of the Turn before and the new message.

Limits of the replay: it has no Compaction, no Stub, and no Profile change, so it has none of the planned misses. Decision 0033 stores an `untrusted` Turn as Stubs, which adds one planned miss on the tail of that Turn. The calls were seconds apart.

## Part D results: after the change

Date: 2026-11-25. Code on `main` at `698c61a`, after all parts of #182. The repository owner approved this run on 2026-11-25 (decision 0002).

Method: the same as Part B. A recording proxy on `127.0.0.1` stopped all calls at 2,000,000 input tokens. The real Worker ran in the wrangler test harness (`eval/worker.ts`, temporary local storage, the fake Telegram API). One Owner sent 12 messages of the same kinds and in the same order as Part B. The messages were: time zone, two Captures, two Recalls, and two Scheduled Tasks set for some minutes later. Then small talk, a move of the Brief, "less of this", a second move of the Brief, and a closed task. The driver waited until each Schedule fired, so the run has 2 Scheduled Task Turns and 2 Proactive Turns between the Owner message Turns. The texts are new synthetic texts, so the numbers of tokens are not the same as in Part B. No local values file was present, and the proxy was the only path to the gateway. Every call sent `x-session-affinity` and `cf-aig-skip-cache: true`.

33 model calls in 16 Turns.

| Turn kind | Calls | Step 1 input | Step 1 cached | Step 1 Hit Rate | Later steps Hit Rate | All calls Hit Rate | Share of input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `reply` | 24 | 136,040 | 133,568 | 98.2% | 98.0% | 98.1% | 86.7% |
| `scheduled_task` | 6 | 7,407 | 5,824 | 78.6% | 94.2% | 89.4% | 7.5% |
| `proactive` | 3 | 12,106 | 7,936 | 65.6% | 95.9% | 75.9% | 5.8% |
| all | 33 |  |  |  |  | 96.2% | 100% |

Step 1 of the 12 Owner message Turns. The gap is the time from the end of the earlier call of the main Conversation.

| Turn | Condition | Messages | Input | Cached | Hit Rate | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | First call, warm (see below) | 3 | 9,715 | 9,600 | 98.8% | - |
| 2 | The time zone was set in Turn 1 | 7 | 9,860 | 9,664 | 98.0% | 0.1 min |
| 3 |  | 12 | 10,096 | 9,920 | 98.3% | 0.1 min |
| 4 |  | 17 | 10,374 | 10,240 | 98.7% | 0.1 min |
| 5 |  | 21 | 10,631 | 10,560 | 99.3% | 0.1 min |
| 6 |  | 25 | 10,955 | 10,816 | 98.7% | 0.1 min |
| 7 |  | 29 | 11,341 | 11,200 | 98.8% | 0.1 min |
| 8 | After a Scheduled Task Turn | 34 | 11,755 | 11,520 | 98.0% | 1.7 min |
| 9 | After a Scheduled Task Turn | 37 | 11,901 | 11,712 | 98.4% | 1.9 min |
| 10 | After a Proactive Turn | 44 | 12,752 | 12,288 | 96.4% | 2.0 min |
| 11 |  | 48 | 12,985 | 12,864 | 99.1% | 0.1 min |
| 12 | After a Proactive Turn | 53 | 13,675 | 13,184 | 96.4% | 1.7 min |

Turns 2 to 12: 126,325 input tokens, 123,968 cached, **98.1%**. Before the change: 48.9% in the run, and about 24% for Turns more than one minute apart. Predicted by the replay of Part C: 96.2%. The result is above the 90% of decision 0033, so the design stays.

- The Turns 8, 9, 10, and 12 came 1.7 to 2.0 minutes after the earlier call of the main Conversation. A Side Session ran between them. They hit 96.4% to 98.4%. Before the change, the same Turns hit 22% to 24%. A Side Session does not change the prefix of the main Conversation.
- Turn 1 was not cold. A test of the driver at about 08:20 UTC sent the same system text and tool definitions some minutes before (see the cost). The system message and the tool definitions do not depend on the Owner, so the cache of one Owner serves another. A cold call of a new kind reads only the shared 2,432 tokens, as the first Side Session of each kind shows. The method leaves Turn 1 out, so the result does not change.
- The step 1 Hit Rate of a Side Session is 40% to 91%. The first Side Session of each kind read only the 2,432 tokens that all kinds share. The second of each kind read 91%. Its Run block holds the current time and the recent messages, so the text after the Owner Context Block is new in each Side Session. Its later steps hit 94% to 96%.
- The run has no Compaction, no Stub, and no Profile change after Turn 1, so it has none of the planned misses.
- The calls were seconds to 2 minutes apart. The run does not measure gaps longer than the cache lifetime.

## Cost of the measurement

805,891 input tokens (572,288 cached) and 1,974 output tokens through the proxy: about $0.08 with the 5% fee of Unified Billing. A few diagnostic calls of some tokens each ran outside the proxy.

Part D: 317,122 input tokens (304,960 cached) and 1,693 output tokens through the proxy: about $0.01 with the 5% fee. Outside the proxy, one check of the token used 7 input tokens. A test of the driver at about 08:20 to 08:21 UTC was meant to use a fake model. But a local values file was present and set the real gateway URL and token. So the Worker called the real gateway for 6 Owner messages, with no record and no stop. Estimated cost: less than $0.05. The run of Part D had no local values file.

## Notes for later work

- The local values file of `apps/agent` overrides the `vars` that `startLocalWorker` passes. An Eval run reads the same values from it, so it works, but a run that needs another gateway URL must turn the loading off. On 2026-11-25 `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` did not stop the loading in the wrangler test harness (wrangler 4.168). Put the values in the environment of the command, and make sure that no local values file exists.
- The gateway analytics of Cloudflare show the cost and the cached tokens for each request, with the Owner Id as metadata. They are a second source for [#27](https://github.com/kacperborowieckb/billy/issues/27). The Usage rows stay the source of truth (decision [0005](../decisions/0005-model-transport-and-billing.md)).
