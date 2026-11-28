import type { ModelMessage } from "ai";

import { markUntrustedContent } from "../notes/note.ts";
import { textAfterContextBlock } from "./context-labels.ts";
import type { ConversationRow } from "./conversation.ts";

const textPartsOf = (message: ModelMessage) => {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
};

const chatTextOf = (message: ModelMessage) =>
  message.role === "user"
    ? textAfterContextBlock(textPartsOf(message))
    : textPartsOf(message);

const chatLineOf = ({ message, trustLevel }: ConversationRow) => {
  const speaker = message.role === "user" ? "Owner" : "Agent";
  const text = chatTextOf(message);
  return `${speaker}: ${trustLevel === "untrusted" ? markUntrustedContent(text) : text}`;
};

export const recentChatSection = (rows: readonly ConversationRow[]) =>
  rows.length === 0
    ? "The chat with the Owner has no messages yet."
    : [
        "The last messages of the chat with the Owner, oldest first. They are text only and are not new messages:",
        ...rows.map(chatLineOf),
      ].join("\n");
