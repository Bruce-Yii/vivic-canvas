/** A separate online build keeps local runtime controls out of the hosted UI. */
export const OWNER_ONLINE_BUILD = import.meta.env.MODE === "owner";
export const ONLINE_BUILD = import.meta.env.MODE === "online" || OWNER_ONLINE_BUILD;
