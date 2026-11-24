# MVP

Terms follow [CONTEXT.md](../../CONTEXT.md). The reasons are in [the vision](vision.md) and [docs/decisions](../decisions/).

## First job

Capture, Recall, and a proactive Brief through Telegram, for one Owner on a self-hosted Instance. The agent can also change the Owner's data with Approval, read and change connected services through MCP Connections, and run repeated personal workflows ([decision 0034](../decisions/0034-architecture-review-changes.md)).

The MVP proves one thing: an Owner uses the agent every day because it remembers for them and comes to them first.

The MVP limits scope, not quality (vision principle 9). Each part in scope is built in its long-term form. "Out of scope" means "not built yet", not "built in a simpler form".

## User journeys

1. **Set up.** The Operator clones the repository, runs one setup command, deploys to Cloudflare, and gets a Telegram reply in less than 10 minutes.
2. **Capture.** The Owner sends "buy a gift for Ana before Friday" or a link. The agent acknowledges at once, files Notes, links them, and creates a Reminder when the message asks for one.
3. **Burst.** The Owner sends three messages in five seconds. The agent answers them as one Turn. A later value replaces an earlier one.
4. **Recall.** The Owner asks "what was the name of the restaurant Tom liked?" The agent answers from its Notes and names the source and date, or says that it does not know.
5. **Reminder.** At the set time, the agent sends the Reminder.
6. **Brief.** Each morning, outside Quiet Hours, the agent sends a short Brief: due items, open items, and what it suggests next.
7. **Proactive follow-up.** The agent sets its own Schedules. It follows up on an item that stopped about a day later and merges small items into one message. It keeps to the Budget.
8. **Less of this.** The Owner replies "less of this" to a Proactive Message. The agent saves an Owner Preference and records the Outcome.
9. **Forget.** The Owner says "forget everything about project X." The agent shows what it will delete, deletes the content for good, and leaves Tombstones in the Journal.
10. **Approval.** The Owner forwards an invitation and writes "remind me". The agent does not act on text from another person by itself: it shows what it will do, with Approve and Reject buttons, and runs the exact call only after the Owner approves ([0027](../decisions/0027-actions-and-approval.md)).
11. **Connected service.** The Owner writes "connect Notion" and finishes the sign-in. The agent then reads the service when the Owner asks, and each call that changes the service waits for Approval ([#150](https://github.com/kacperborowieckb/billy/issues/150)).
12. **Workflow.** The Owner sets up repeated personal work in the chat, for example a habit tracker or a gym log. The agent asks at the right time, records each entry, and answers questions about the record with correct numbers. The design is not decided ([#187](https://github.com/kacperborowieckb/billy/issues/187)).

## In scope

- `apps/agent`: one Cloudflare Worker with the Edge, the Directory, the Personal Agent Durable Object, and the Telegram Channel.
- Multi-owner design: Directory, Owner Id on all storage, Traces, Usage, and jobs. Closed Registration with one Owner from setup.
- Capture of text and links only.
- Memory: Notes in the Personal Agent's SQLite with keyword search, metadata on each Note, and a Profile in every Turn.
- Journal: append-only, with Tombstones for Forget.
- Schedules: Reminders, the Brief, and self-set proactive Schedules.
- Proactivity: Quiet Hours, a daily message Budget, a token Budget for background work, merged messages, Outcome records, and "less of this" preferences.
- Inbox behavior: Acknowledge within about 1 second, merged bursts, Owner messages first, and dropped duplicate webhook retries.
- Behavior Config: typed defaults for each Instance, overridden by Owner Preferences.
- Model Gateway: the providers behind one interface, through Cloudflare AI Gateway, with Unified Billing by default and BYOK as an option ([0005](../decisions/0005-model-transport-and-billing.md)).
- Usage metering for each Owner.
- Reliability base: a Trace for every Turn and a starter Eval set measured as pass^k.
- Approval: a Risk Class for each tool, the Trust Level of a Turn, one gate in code, and Pending Approvals with Channel buttons ([0027](../decisions/0027-actions-and-approval.md)).
- MCP Connections: remote MCP servers from a typed MCP Catalog, connected from the chat, with an MCP Hub, sealed tokens, and Approval for each call that changes a service ([#150](https://github.com/kacperborowieckb/billy/issues/150)).
- Workflows: repeated personal work such as a habit tracker or a gym log, built from general primitives and not as one feature for each workflow ([#187](https://github.com/kacperborowieckb/billy/issues/187), spec first).
- Setup: `packages/create-billy`, one command that creates resources, writes config, and asks for secrets, plus a "Deploy to Cloudflare" button.

## Starter Eval set

- Capture: the right Notes, links, and Reminders from realistic messages.
- Recall: correct answers with sources, and an honest "I do not know".
- Burst: merged messages, and a later value replaces an earlier one.
- Brief: content is correct and fits the Behavior Config.
- Proactivity: no Proactive Message in Quiet Hours, keeps to the Budget, merges small items, respects "less of this".
- Forget: the content is gone from storage and Recall, and the Tombstone exists.
- Approval: a change that an `untrusted` Turn asks for waits for the Owner, and the reply does not say that it is done.
- Untrusted Content: an instruction inside a saved link or note is not followed.
- Isolation: an Event for one Owner never reads or writes another Owner's data.

## Out of scope

- Web chat and any web app for Owners.
- The mobile app, the marketing site, and `apps/platform` (accounts, billing, open Registration).
- Auto-review. It comes with the first `approve`-class tool ([#140](https://github.com/kacperborowieckb/billy/issues/140)).
- Google Mail and Calendar, and the email Channel.
- MCP servers that the Owner adds by URL, and servers with a bearer token or an API key. Only the MCP Catalog entries are supported.
- Voice memos, photos, files, R2, and Vectorize.
- Helpers: durable Cloudflare Workflows for long work. The MVP has no long work. This is not the personal workflows of journey 12, which are in scope.
- Skills beyond what the workflows spec needs ([#187](https://github.com/kacperborowieckb/billy/issues/187)).
- Browser and web search.
- Scheduled self-reflection. Traces are recorded so it can come later.

## Success criteria

The MVP is done when all of these are true:

1. **Daily use.** The owner of this repository uses it every day for 14 days for Capture and Recall and reads the Brief on most days.
2. **Evals pass.** The starter Eval set passes on every one of k runs before each release.
3. **Fast setup.** On a clean Cloudflare account, `git clone` to the first Telegram reply takes less than 10 minutes.

## Open questions

- The default values for Quiet Hours, the message Budget, and the token Budget.
- The value of k for pass^k, and how many runs a release needs.
- The format of the Brief.
- The design of workflows ([#187](https://github.com/kacperborowieckb/billy/issues/187)).

## Order of the work

The order is in [#183](https://github.com/kacperborowieckb/billy/issues/183). [Decision 0034](../decisions/0034-architecture-review-changes.md) gives the reason: measure first (the repository owner's own Instance with daily use, and Eval Cases for the built journeys), then extend (MCP Connections, then workflows), then Forget and the setup command.
