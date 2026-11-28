export const fakeOAuthAccountName = "Pat Reader";

export const identityFieldsOf = ({
  withAccountName,
  workspaceName,
}: {
  readonly withAccountName: boolean;
  readonly workspaceName: string | undefined;
}) => ({
  ...(withAccountName ? { account_name: fakeOAuthAccountName } : {}),
  ...(workspaceName === undefined ? {} : { workspace_name: workspaceName }),
});
