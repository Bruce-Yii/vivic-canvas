/** `/` is the user page, `/control` the settings page; both are the same owner window. */
export type ControlView = "chat" | "settings";
export const viewForPath = (pathname: string): ControlView =>
  pathname.replace(/\/+$/, "") === "/control" ? "settings" : "chat";
export const pathForView = (view: ControlView) => view === "settings" ? "/control" : "/";
