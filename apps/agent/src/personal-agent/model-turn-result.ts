export type ModelTurnResult =
  | { readonly _tag: "Sent" }
  | { readonly _tag: "Silent" }
  | { readonly _tag: "Failed"; readonly reason: string }
  | { readonly _tag: "SendFailed"; readonly reason: string }
  | { readonly _tag: "Superseded" };

export const sent: ModelTurnResult = { _tag: "Sent" };
export const silentResult: ModelTurnResult = { _tag: "Silent" };
export const superseded: ModelTurnResult = { _tag: "Superseded" };
