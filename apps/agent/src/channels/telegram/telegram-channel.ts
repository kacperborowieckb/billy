import { Effect, Layer, Schema } from "effect";

import { Channel } from "../channel.ts";
import type { OutgoingReaction, ReactionDelivery } from "../channel.ts";
import { TypingNotShown } from "../typing-not-shown.ts";
import {
  answerPress,
  editApprovalMessage,
} from "./telegram-approval-answer.ts";
import { telegramReactionFor } from "./telegram-reactions.ts";
import { failed, send, sendWithApprovals } from "./telegram-send.ts";
import type { TelegramConfig } from "./telegram-send.ts";

const TrueResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    description: Schema.optionalKey(Schema.String),
  }),
]);

const sendChatActionRequest = (
  config: TelegramConfig,
  conversationId: string
) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(conversationId), action: "typing" }),
  });

const notShown = (reason: string) => new TypingNotShown({ reason });

const typingAnswerOf = (response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TrueResponseSchema)),
    Effect.mapError(() =>
      notShown(`Telegram answered ${response.status} without a result`)
    ),
    Effect.flatMap((answer) =>
      answer.ok
        ? Effect.void
        : Effect.fail(
            notShown(
              `Telegram refused the chat action (${response.status}): ${answer.description ?? "no description"}`
            )
          )
    )
  );

const showTyping = (config: TelegramConfig) => (conversationId: string) =>
  Effect.tryPromise({
    try: (signal) =>
      (config.fetch ?? fetch)(
        new Request(sendChatActionRequest(config, conversationId), { signal })
      ),
    catch: () => notShown("Telegram could not be reached"),
  }).pipe(Effect.flatMap(typingAnswerOf));

const setMessageReactionRequest = (
  config: TelegramConfig,
  reaction: OutgoingReaction
) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/setMessageReaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(reaction.conversationId),
      message_id: Number(reaction.channelMessageId),
      reaction: [{ type: "emoji", emoji: reaction.emoji }],
    }),
  });

const reactionDeliveryFrom = (response: Response, reaction: OutgoingReaction) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TrueResponseSchema)),
    Effect.map((answer): ReactionDelivery =>
      answer.ok
        ? { _tag: "Confirmed", channelMessageId: reaction.channelMessageId }
        : failed(
            `Telegram refused the reaction (${response.status}): ${answer.description ?? "no description"}`
          )
    ),
    Effect.orElseSucceed((): ReactionDelivery => ({
      _tag: "Unconfirmed",
      reason: `Telegram answered ${response.status} without a result`,
    }))
  );

const react = (config: TelegramConfig) => (reaction: OutgoingReaction) =>
  Effect.tryPromise(() =>
    (config.fetch ?? fetch)(setMessageReactionRequest(config, reaction))
  ).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.succeed<ReactionDelivery>({
          _tag: "Unconfirmed",
          reason: "Telegram could not be reached",
        }),
      onSuccess: (response) => reactionDeliveryFrom(response, reaction),
    })
  );

export const telegramChannel = (config: TelegramConfig) =>
  Layer.succeed(Channel, {
    send: send(config),
    sendWithApprovals: sendWithApprovals(config),
    editApprovalMessage: editApprovalMessage(config),
    answerPress: answerPress(config),
    react: react(config),
    allowedReaction: telegramReactionFor,
    showTyping: showTyping(config),
  });
