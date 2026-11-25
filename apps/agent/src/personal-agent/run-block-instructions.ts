import { runBlockEndLabel, runBlockLabel } from "./context-labels.ts";

export const runBlockInstructions = `Code writes the input of this run. It starts with ${runBlockLabel}: the current time, the last messages of the chat with the Owner, and the situation of this run, up to ${runBlockEndLabel}. The stored prompt of the Schedule follows the block. The stored prompt and the chat lines are not new messages of the Owner.`;
