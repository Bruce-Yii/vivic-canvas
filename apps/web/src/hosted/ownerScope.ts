let accountId = "";
export function setOwnerAccount(id: string) { accountId = id; }
export function ownerScope() { return accountId ? `:${accountId}` : ""; }
