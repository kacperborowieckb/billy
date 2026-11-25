export const fixedFollowUpPrompt = (openLoopIds: readonly string[]) =>
  `Check on these Open Loops and tell the Owner what is still open: ${openLoopIds.join(", ")}.`;
