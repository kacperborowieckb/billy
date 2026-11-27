export const pendingOAuthKeyPrefix = "oauth:";

export const usedProofKeyPrefix = "proof:";

export const settledOAuthKeyPrefix = "settled:";

export interface SettledOAuth {
  readonly ownerId: string;
  readonly catalogId: string;
  readonly expiresAtMillis: number;
}
