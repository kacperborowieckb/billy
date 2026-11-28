import { isDeepStrictEqual } from "node:util";

import { Console, Effect } from "effect";

import { startLocalFakes } from "../local-fakes.ts";
import type { FakeTelegramMessage } from "../local-fakes.ts";
import { startLocalWorker, temporarySecrets } from "../local-worker.ts";
import { addOwner, renderAddedOwner } from "../operator.ts";
import { fakeNotionPageIds, fakeNotionWorkspaceName } from "./fake-notion.ts";
import { flowCheck } from "./flow-checks.ts";
import { detailsShowTheCall } from "./flow-details.ts";
import { checkFlowJournal } from "./flow-journal.ts";
import { readFlowObservation } from "./flow-observation.ts";
import { flowOwner } from "./flow-owner.ts";
import type { FlowOwner } from "./flow-owner.ts";
import { signInThroughEdge } from "./flow-sign-in.ts";

const flowWorkerMain = "mcp-flow/worker.ts";
const flowEdgePublicUrl = "https://edge.mcp-flow.invalid";
const flowTelegramUserId = 535_353;

const createdTitle = "Project Hail Mary";

const approvedArguments = {
  parent: { page_id: fakeNotionPageIds.readingList },
  pages: [
    {
      properties: { title: createdTitle },
      content: `Notes about ${createdTitle}`,
    },
  ],
};

interface FlowRun {
  readonly owner: FlowOwner;
  readonly workerUrl: URL;
  readonly botToken: string;
  readonly observe: ReturnType<typeof readFlowObservation>;
}

const expectText = (
  step: string,
  message: FakeTelegramMessage,
  wanted: string
) =>
  flowCheck(
    step,
    message.text.includes(wanted),
    `the message does not contain "${wanted}": ${message.text}`
  );

const createCallsOf = ({ observe }: FlowRun) =>
  observe.pipe(
    Effect.map(({ serverCalls }) =>
      serverCalls.filter(({ tool }) => tool === "notion-create-pages")
    )
  );

const connect = Effect.fnUntraced(function* connect(run: FlowRun) {
  const { owner, workerUrl, botToken } = run;
  yield* Console.log("\n== 1. Connect");
  yield* owner.say("notion connect");
  yield* owner.nextMessage("connect reply");
  const invitation = yield* owner.nextMessage("Connect button");
  const loginUrl = invitation.buttons?.[0]?.login_url?.url;
  yield* flowCheck(
    "Connect button",
    loginUrl?.startsWith(`${flowEdgePublicUrl}/mcp/connect?c=notion`) === true,
    `no login_url button: ${invitation.text}`
  );
  yield* signInThroughEdge({
    workerUrl,
    botToken,
    telegramUserId: flowTelegramUserId,
    buttonUrl: new URL(loginUrl ?? flowEdgePublicUrl),
  });
  const connected = yield* owner.nextMessage("connected message");
  yield* expectText(
    "connected message",
    connected,
    `Connected Notion (account ${fakeNotionWorkspaceName})`
  );
});

const findAndRead = Effect.fnUntraced(function* findAndRead({
  owner,
}: FlowRun) {
  yield* Console.log("\n== 2. Find");
  yield* owner.say("notion find create pages");
  yield* expectText(
    "find",
    yield* owner.nextMessage("find"),
    "notion-create-pages"
  );
  yield* Console.log("\n== 3. Read");
  yield* owner.say("notion read reading list");
  const read = yield* owner.nextMessage("read");
  yield* expectText("read", read, "Project Hail Mary, Piranesi");
  yield* flowCheck(
    "read",
    (read.buttons ?? []).length === 0,
    "a read asked for Approval"
  );
});

const proposeAndApprove = Effect.fnUntraced(function* proposeAndApprove(
  run: FlowRun
) {
  const { owner } = run;
  yield* Console.log("\n== 4. Propose a create");
  yield* owner.say(`notion create ${createdTitle}`);
  yield* owner.nextMessage("create reply");
  const approval = yield* owner.nextMessage("Approval request");
  yield* expectText(
    "Approval request",
    approval,
    `Notion: create page "${createdTitle}" in "${fakeNotionPageIds.readingList}"`
  );
  const beforeApprove = yield* createCallsOf(run);
  yield* flowCheck(
    "Approval request",
    beforeApprove.length === 0,
    "the create ran before Approve"
  );

  yield* Console.log("\n== 5. Details");
  yield* owner.press(approval, "Details");
  const details = yield* owner.nextDocument("Details");
  yield* flowCheck(
    "Details",
    detailsShowTheCall(details.content, {
      connection: "notion",
      tool: "notion-create-pages",
      arguments: approvedArguments,
    }),
    "the file does not hold the full arguments"
  );

  yield* Console.log("\n== 6. Approve");
  yield* owner.press(approval, "Approve");
  yield* owner.nextEdit("Approve");
  const calls = yield* createCallsOf(run);
  yield* flowCheck(
    "Approve",
    calls.length === 1 &&
      isDeepStrictEqual(calls[0]?.arguments, approvedArguments),
    `the server got ${JSON.stringify(calls)}`
  );
  yield* Console.log(
    "The fake Notion server ran notion-create-pages one time with the approved arguments."
  );
});

const disconnect = Effect.fnUntraced(function* disconnect({ owner }: FlowRun) {
  yield* Console.log("\n== 7. Disconnect");
  yield* owner.say("notion disconnect");
  yield* expectText(
    "disconnect",
    yield* owner.nextMessage("disconnect"),
    "Notion is disconnected"
  );
});

export const runMcpFlow = Effect.gen(function* runMcpFlowEffect() {
  const fakes = yield* startLocalFakes();
  const secrets = temporarySecrets();
  const workerUrl = yield* startLocalWorker({
    main: flowWorkerMain,
    vars: {
      TELEGRAM_API_URL: fakes.telegramApiUrl,
      AI_GATEWAY_URL: fakes.aiGatewayUrl,
      EDGE_PUBLIC_URL: flowEdgePublicUrl,
    },
    secrets,
  });
  yield* Console.log(
    `Local Worker: ${workerUrl.origin} (temporary storage, fake Telegram, fake model, fake Notion, no network)`
  );
  const added = yield* addOwner({
    workerUrl: workerUrl.origin,
    token: secrets.OPERATOR_TOKEN,
    telegramUserId: flowTelegramUserId,
  });
  yield* Console.log(renderAddedOwner(added));
  const owner = yield* flowOwner({
    workerUrl,
    webhookSecret: secrets.TELEGRAM_WEBHOOK_SECRET,
    telegramUserId: flowTelegramUserId,
    fakes,
  });
  const observe = readFlowObservation({
    workerUrl,
    token: secrets.OPERATOR_TOKEN,
    ownerId: added.ownerId,
  });
  const run: FlowRun = {
    owner,
    workerUrl,
    botToken: secrets.TELEGRAM_BOT_TOKEN,
    observe,
  };

  yield* connect(run);
  yield* findAndRead(run);
  yield* proposeAndApprove(run);
  yield* disconnect(run);

  yield* Console.log("\n== 8. Journal");
  yield* checkFlowJournal(yield* observe, owner.seen);
  yield* Console.log("\nResult: the MCP flow passed.");
}).pipe(Effect.scoped);
