import { Option, Schema } from "effect";

import type { ApprovalAnswered, OwnerMessage } from "../../event.ts";
import {
  approvalPressDataOf,
  detailsPressDataOf,
} from "./approval-keyboard.ts";

const ForwardOriginSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    sender_user: Schema.Struct({
      first_name: Schema.String,
      last_name: Schema.optionalKey(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("hidden_user"),
    sender_user_name: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("chat"),
    sender_chat: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
  }),
  Schema.Struct({
    type: Schema.Literal("channel"),
    chat: Schema.Struct({ title: Schema.optionalKey(Schema.String) }),
  }),
  Schema.Struct({ type: Schema.String }),
]);

type ForwardOrigin = typeof ForwardOriginSchema.Type;

const unknownForwardOrigin = "an unknown sender";

const maxForwardOriginLength = 100;

const singleLine = (name: string) =>
  name.replaceAll(/\s+/gu, " ").trim().slice(0, maxForwardOriginLength);

const forwardOriginName = (origin: ForwardOrigin): string => {
  if ("sender_user" in origin) {
    return [origin.sender_user.first_name, origin.sender_user.last_name]
      .filter((part) => part !== undefined && part !== "")
      .join(" ");
  }
  if ("sender_user_name" in origin) {
    return origin.sender_user_name;
  }
  if ("sender_chat" in origin) {
    return origin.sender_chat.title ?? unknownForwardOrigin;
  }
  if ("chat" in origin) {
    return origin.chat.title ?? unknownForwardOrigin;
  }
  return unknownForwardOrigin;
};

const TelegramUpdateSchema = Schema.Struct({
  update_id: Schema.Int,
  message: Schema.optionalKey(
    Schema.Struct({
      message_id: Schema.Int,
      date: Schema.Int,
      chat: Schema.Struct({ id: Schema.Int, type: Schema.String }),
      from: Schema.optionalKey(
        Schema.Struct({ id: Schema.Int, is_bot: Schema.Boolean })
      ),
      text: Schema.optionalKey(Schema.String),
      forward_origin: Schema.optionalKey(ForwardOriginSchema),
    })
  ),
  callback_query: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      from: Schema.Struct({ id: Schema.Int, is_bot: Schema.Boolean }),
      message: Schema.optionalKey(
        Schema.Struct({
          message_id: Schema.Int,
          chat: Schema.Struct({ id: Schema.Int, type: Schema.String }),
        })
      ),
      data: Schema.optionalKey(Schema.String),
    })
  ),
});

export interface TelegramTextMessage {
  readonly senderId: number;
  readonly message: OwnerMessage;
}

const millisecondsPerSecond = 1000;

export const textMessageFrom = (
  body: unknown
): Option.Option<TelegramTextMessage> =>
  Schema.decodeUnknownOption(TelegramUpdateSchema)(body).pipe(
    Option.flatMap(({ update_id: updateId, message }) => {
      if (
        message?.text === undefined ||
        message.from === undefined ||
        message.from.is_bot ||
        message.chat.type !== "private"
      ) {
        return Option.none();
      }
      return Option.some({
        senderId: message.from.id,
        message: {
          _tag: "OwnerMessage",
          channel: "telegram",
          channelUpdateId: String(updateId),
          conversationId: String(message.chat.id),
          channelMessageId: String(message.message_id),
          text: message.text,
          sentAt: new Date(message.date * millisecondsPerSecond).toISOString(),
          ...(message.forward_origin === undefined
            ? {}
            : {
                forwardOrigin:
                  singleLine(forwardOriginName(message.forward_origin)) ||
                  unknownForwardOrigin,
              }),
        },
      });
    })
  );

export interface TelegramApprovalPress {
  readonly senderId: number;
  readonly answered: ApprovalAnswered;
}

export const approvalPressFrom = (
  body: unknown
): Option.Option<TelegramApprovalPress> =>
  Schema.decodeUnknownOption(TelegramUpdateSchema)(body).pipe(
    Option.flatMap(({ callback_query: press }) => {
      const data =
        press?.data === undefined ? undefined : approvalPressDataOf(press.data);
      if (
        press?.message === undefined ||
        data === undefined ||
        press.from.is_bot ||
        press.message.chat.type !== "private"
      ) {
        return Option.none();
      }
      return Option.some({
        senderId: press.from.id,
        answered: {
          _tag: "ApprovalAnswered",
          channel: "telegram",
          pressId: press.id,
          conversationId: String(press.message.chat.id),
          channelMessageId: String(press.message.message_id),
          pendingApprovalId: data.pendingApprovalId,
          answer: data.answer,
        },
      });
    })
  );

export interface TelegramDetailsPress {
  readonly senderId: number;
  readonly pressId: string;
  readonly conversationId: string;
  readonly pendingApprovalId: string;
}

export const detailsPressFrom = (
  body: unknown
): Option.Option<TelegramDetailsPress> =>
  Schema.decodeUnknownOption(TelegramUpdateSchema)(body).pipe(
    Option.flatMap(({ callback_query: press }) => {
      const pendingApprovalId =
        press?.data === undefined ? undefined : detailsPressDataOf(press.data);
      if (
        press?.message === undefined ||
        pendingApprovalId === undefined ||
        press.from.is_bot ||
        press.message.chat.type !== "private"
      ) {
        return Option.none();
      }
      return Option.some({
        senderId: press.from.id,
        pressId: press.id,
        conversationId: String(press.message.chat.id),
        pendingApprovalId,
      });
    })
  );
