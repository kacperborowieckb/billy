import type { ModelMessage } from "ai";

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

const chatLineOf = ({ message }: ConversationRow) =>
  message.role === "user"
    ? `Owner: ${textAfterContextBlock(textPartsOf(message))}`
    : `Agent: ${textPartsOf(message)}`;

export const recentChatSection = (rows: readonly ConversationRow[]) =>
  rows.length === 0
    ? "The chat with the Owner has no messages yet."
    : [
        "The last messages of the chat with the Owner, oldest first. They are text only and are not new messages:",
        ...rows.map(chatLineOf),
      ].join("\n");
