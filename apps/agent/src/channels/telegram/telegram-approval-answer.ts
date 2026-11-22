import { Effect, Schema } from "effect";

import type {
  ApprovalMessageEdit,
  ApprovalPressAnswer,
  Delivery,
} from "../channel.ts";
import { editedApprovalBlockOf } from "./approval-keyboard.ts";
import { failed, telegramTextLimit } from "./telegram-send.ts";
import type { TelegramConfig } from "./telegram-send.ts";

const telegramRequest = (
  config: TelegramConfig,
  method: string,
  body: object
) =>
  new Request(`${config.apiUrl}/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const AnswerResponseSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    description: Schema.optionalKey(Schema.String),
  }),
]);

const editDeliveryFrom = (response: Response, channelMessageId: string) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AnswerResponseSchema)),
    Effect.map((answer): Delivery =>
      answer.ok
        ? { _tag: "Confirmed", channelMessageId }
        : failed(
            `Telegram refused the edit (${response.status}): ${answer.description ?? "no description"}`
          )
    ),
    Effect.orElseSucceed(() =>
      failed(`Telegram answered ${response.status} without a result`)
    )
  );

export const editApprovalMessage =
  (config: TelegramConfig) => (edit: ApprovalMessageEdit) => {
    const block = editedApprovalBlockOf(
      edit.turnApprovals,
      edit.channelMessageId,
      telegramTextLimit
    );
    return Effect.tryPromise((signal) =>
      (config.fetch ?? fetch)(
        new Request(
          telegramRequest(config, "editMessageText", {
            chat_id: Number(edit.conversationId),
            message_id: Number(edit.channelMessageId),
            text: block.text,
            reply_markup: { inline_keyboard: block.keyboard },
          }),
          { signal }
        )
      )
    ).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.succeed(failed("Telegram could not be reached")),
        onSuccess: (response) =>
          editDeliveryFrom(response, edit.channelMessageId),
      })
    );
  };

export const answerPress =
  (config: TelegramConfig) => (answer: ApprovalPressAnswer) =>
    Effect.tryPromise((signal) =>
      (config.fetch ?? fetch)(
        new Request(
          telegramRequest(config, "answerCallbackQuery", {
            callback_query_id: answer.pressId,
            ...(answer.notice === undefined ? {} : { text: answer.notice }),
          }),
          { signal }
        )
      )
    ).pipe(Effect.ignore);
