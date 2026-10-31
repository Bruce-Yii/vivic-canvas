export const DEFINITION_CHANGE_EVENT = "vivic:card-packages-changed";
export const DEFINITION_CHANGE_CHANNEL = "vivic.card-packages.v1";

/** Contains no account data. Every listener reloads its own authenticated scope. */
export function announceDefinitionChange() {
  window.dispatchEvent(new Event(DEFINITION_CHANGE_EVENT));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(DEFINITION_CHANGE_CHANNEL);
    channel.postMessage("changed");
    channel.close();
  }
}
