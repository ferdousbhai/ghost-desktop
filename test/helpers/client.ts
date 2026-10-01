import type { HyprClient } from "../../src/hypr.js";

/** A Hyprland window for tests; override what the test is about. */
export function client(over: Partial<HyprClient> = {}): HyprClient {
  return {
    address: "0xa", class: "foot", title: "foot", pid: 1, at: [0, 0], size: [100, 100],
    workspace: { id: 1, name: "1" }, floating: false, fullscreen: 0, hidden: false, mapped: true, focusHistoryID: 0, ...over,
  };
}
