const pendingApprovalIdBytes = 9;

export const newPendingApprovalId = () =>
  btoa(
    String.fromCodePoint(
      ...crypto.getRandomValues(new Uint8Array(pendingApprovalIdBytes))
    )
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_");
