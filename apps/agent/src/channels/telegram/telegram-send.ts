import { Effect, Schema } from "effect";

import type {
  ApprovalDelivery,
  ApprovalMessage,
  Delivery,
  OutgoingApprovalMessage,
  OutgoingMessage,
} from "../channel.ts";
import { approvalBlocksOf } from "./approval-keyboard.ts";
import type { InlineKeyboard } from "./approval-keyboard.ts";

export interface TelegramConfig {
  readonly apiUrl: string;
  readonly botToken: string;
  readonly fetch?: typeof fetch;
}

const SendMessageResponseSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({ message_id: Schema.Int }),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    description: Schema.optionalKey(Schema.String),
  }),
]);

export const failed = (reason: string): Delivery => ({
  _tag: "Failed",
  reason,
});

const approvalsNotSent = (reason: string): ApprovalDelivery => ({
  _tag: "Failed",
  reason,
});

export const telegramTextLimit = 4096;

const cutPosition = (text: string) => {
  const window = text.slice(0, telegramTextLimit);
  const lastBreak = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  const cut = lastBreak > 0 ? lastBreak : telegramTextLimit;
  const splitsSurrogatePair = /[\uD800-\uDBFF]/u.test(text.charAt(cut - 1));
  return splitsSurrogatePair ? cut - 1 : cut;
};

const splitAtLimit = (text: string): readonly string[] => {
  if (text.length <= telegramTextLimit) {
    return [text];
  }
  const cut = cutPosition(text);
  return [
    text.slice(0, cut).trimEnd(),
    ...splitAtLimit(text.slice(cut).trimStart()),
  ];
};

const hasText = (part: string) => part.trim().length > 0;

export const telegramParts = (text: string): readonly string[] =>
  splitAtLimit(text).filter(hasText);

interface TelegramPart extends OutgoingMessage {
  readonly keyboard?: InlineKeyboard;
}

const sendMessageRequest = (config: TelegramConfig, message: TelegramPart) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(message.conversationId),
      text: message.text,
      ...(message.inReplyTo === undefined
        ? {}
        : {
            reply_parameters: {
              message_id: Number(message.inReplyTo),
              allow_sending_without_reply: true,
            },
          }),
      ...(message.keyboard === undefined
        ? {}
        : { reply_markup: { inline_keyboard: message.keyboard } }),
    }),
  });

const deliveryFrom = (response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SendMessageResponseSchema)),
    Effect.map((answer): Delivery => {
      if (answer.ok) {
        return {
          _tag: "Confirmed",
          channelMessageId: String(answer.result.message_id),
        };
      }
      return failed(
        `Telegram refused the message (${response.status}): ${answer.description ?? "no description"}`
      );
    }),
    Effect.orElseSucceed(() =>
      failed(`Telegram answered ${response.status} without a result`)
    )
  );

const sendPart = (config: TelegramConfig, message: TelegramPart) =>
  Effect.tryPromise(() =>
    (config.fetch ?? fetch)(sendMessageRequest(config, message))
  ).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(failed("Telegram could not be reached")),
      onSuccess: deliveryFrom,
    })
  );

const sendParts = Effect.fnUntraced(function* sendParts(
  config: TelegramConfig,
  parts: readonly TelegramPart[]
) {
  const [first, ...rest] = parts;
  if (first === undefined) {
    return failed("The reply has no text");
  }
  let delivery = yield* sendPart(config, first);
  let sentParts = 1;
  for (const part of rest) {
    if (delivery._tag === "Failed") {
      break;
    }
    delivery = yield* sendPart(config, part);
    sentParts += 1;
  }
  if (delivery._tag === "Failed" && parts.length > 1) {
    return failed(`Part ${sentParts} of ${parts.length}: ${delivery.reason}`);
  }
  return delivery;
});

const textPartsOf = (message: OutgoingMessage): TelegramPart[] =>
  telegramParts(message.text).map((text) => ({ ...message, text }));

export const send = (config: TelegramConfig) => (message: OutgoingMessage) =>
  sendParts(config, textPartsOf(message));

export const approvalNotSentStatus =
  "Cancelled: the reply did not send in full, so nothing waits for your Approval.";

interface SentApprovalMessage {
  readonly conversationId: string;
  readonly channelMessageId: string;
  readonly text: string;
}

const editMessageTextRequest = (
  config: TelegramConfig,
  message: SentApprovalMessage
) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(message.conversationId),
      message_id: Number(message.channelMessageId),
      text: `${message.text}\n\n${approvalNotSentStatus}`,
    }),
  });

const cancelApprovalMessage = (
  config: TelegramConfig,
  message: SentApprovalMessage
) =>
  Effect.tryPromise(() =>
    (config.fetch ?? fetch)(editMessageTextRequest(config, message))
  ).pipe(Effect.ignore);

export const sendWithApprovals = (config: TelegramConfig) =>
  Effect.fnUntraced(function* sendWithApprovalsEffect(
    message: OutgoingApprovalMessage
  ) {
    const textParts = textPartsOf(message);
    if (textParts.length > 0) {
      const sentText = yield* sendParts(config, textParts);
      if (sentText._tag === "Failed") {
        return approvalsNotSent(sentText.reason);
      }
    }
    const blocks = approvalBlocksOf(message.approvals, telegramTextLimit);
    const approvalMessages: ApprovalMessage[] = [];
    const sentMessages: SentApprovalMessage[] = [];
    let channelMessageId = "";
    for (const [index, block] of blocks.entries()) {
      const sent = yield* sendPart(config, {
        conversationId: message.conversationId,
        ...(message.inReplyTo === undefined
          ? {}
          : { inReplyTo: message.inReplyTo }),
        text: block.text,
        keyboard: block.keyboard,
      });
      if (sent._tag === "Failed") {
        yield* Effect.forEach(
          sentMessages,
          (sentMessage) => cancelApprovalMessage(config, sentMessage),
          { discard: true }
        );
        return approvalsNotSent(
          `Approval message ${index + 1} of ${blocks.length}: ${sent.reason}`
        );
      }
      ({ channelMessageId } = sent);
      sentMessages.push({
        conversationId: message.conversationId,
        channelMessageId,
        text: block.text,
      });
      approvalMessages.push(
        ...block.pendingApprovalIds.map((pendingApprovalId) => ({
          pendingApprovalId,
          channelMessageId: sent.channelMessageId,
        }))
      );
    }
    return {
      _tag: "Confirmed",
      channelMessageId,
      approvalMessages,
    } satisfies ApprovalDelivery;
  });
