import { Clock, Effect, Option } from "effect";

import {
  approvalPressFrom,
  detailsPressFrom,
  textMessageFrom,
} from "../channels/telegram/update.ts";
import type { TelegramDetailsPress } from "../channels/telegram/update.ts";
import { telegramIdentity } from "../directory/channel-identity.ts";
import { Directory } from "../directory/directory.ts";
import type { Event } from "../event.ts";
import type { OwnerId } from "../owner-id.ts";
import { personalAgentFor } from "../personal-agent/personal-agent.ts";
import { OperatorMetrics } from "../tracing/operator-metrics.ts";
import type { OperatorMetric } from "../tracing/operator-metrics.ts";
import { matchesSecret } from "./secret.ts";

const telegramSecretHeader = "X-Telegram-Bot-Api-Secret-Token";

const accepted = () => new Response(null, { status: 200 });

type TelegramInput =
  | { readonly _tag: "Event"; readonly event: Event }
  | { readonly _tag: "Details"; readonly press: TelegramDetailsPress };

interface TelegramEvent {
  readonly senderId: number;
  readonly input: TelegramInput;
}

const telegramEventFrom = (body: unknown): Option.Option<TelegramEvent> =>
  textMessageFrom(body).pipe(
    Option.map(({ senderId, message }): TelegramEvent => ({
      senderId,
      input: { _tag: "Event", event: message },
    })),
    Option.orElse(() =>
      approvalPressFrom(body).pipe(
        Option.map(({ senderId, answered }): TelegramEvent => ({
          senderId,
          input: { _tag: "Event", event: answered },
        }))
      )
    ),
    Option.orElse(() =>
      detailsPressFrom(body).pipe(
        Option.map((press): TelegramEvent => ({
          senderId: press.senderId,
          input: { _tag: "Details", press },
        }))
      )
    )
  );

const readJson = (request: Request) =>
  Effect.tryPromise(() => request.json<unknown>()).pipe(Effect.option);

const recordRefusal = (
  result: Extract<OperatorMetric, { kind: "refused" }>["result"],
  ownerId: OwnerId | undefined,
  startedAt: number
) =>
  Effect.gen(function* recordRefusalEffect() {
    const metrics = yield* OperatorMetrics;
    const now = yield* Clock.currentTimeMillis;
    yield* metrics.record({
      kind: "refused",
      ownerId,
      result,
      latencyMillis: now - startedAt,
    });
  });

export const handleTelegramUpdate = (request: Request, env: Env) =>
  Effect.gen(function* handleTelegramUpdateEffect() {
    const startedAt = yield* Clock.currentTimeMillis;
    if (
      !matchesSecret(
        request.headers.get(telegramSecretHeader),
        env.TELEGRAM_WEBHOOK_SECRET
      )
    ) {
      yield* recordRefusal("bad_secret_token", undefined, startedAt);
      return new Response(null, { status: 401 });
    }
    const body = yield* readJson(request);
    const telegramEvent = body.pipe(Option.flatMap(telegramEventFrom));
    if (Option.isNone(telegramEvent)) {
      return accepted();
    }
    const directory = yield* Directory;
    const owner = yield* directory.findOwner(
      telegramIdentity(telegramEvent.value.senderId)
    );
    if (Option.isNone(owner)) {
      yield* recordRefusal("unknown_sender", undefined, startedAt);
      return accepted();
    }
    if (owner.value.status !== "active") {
      yield* recordRefusal("owner_not_active", owner.value.ownerId, startedAt);
      return accepted();
    }
    const personalAgent = yield* Effect.tryPromise(() =>
      personalAgentFor(env.PERSONAL_AGENT, owner.value.ownerId)
    );
    const { input } = telegramEvent.value;
    yield* Effect.tryPromise(async () => {
      if (input._tag === "Event") {
        await personalAgent.receive(input.event);
        return;
      }
      await personalAgent.showApprovalDetails({
        pressId: input.press.pressId,
        conversationId: input.press.conversationId,
        pendingApprovalId: input.press.pendingApprovalId,
      });
    });
    return accepted();
  });
