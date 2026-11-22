import { quoted } from "../approval/approval-summary.ts";
import { localDueTimeText } from "../time/local-time-text.ts";
import type { Note } from "./notes.ts";
import type { OpenLoopInput } from "./open-loop-input.ts";

export const noteText = ({ text }: Pick<Note, "text">) =>
  `Note ${quoted(text)}`;

export const openLoopText = ({ kind, localDueTime }: OpenLoopInput) =>
  localDueTime === undefined
    ? `Open Loop ${quoted(kind)}`
    : `Open Loop ${quoted(kind)} due ${localDueTimeText(localDueTime)}`;
