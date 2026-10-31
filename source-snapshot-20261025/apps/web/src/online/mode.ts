/** A separate online build keeps local runtime controls out of the hosted UI. */
export const ONLINE_BUILD = import.meta.env.MODE === "online";
