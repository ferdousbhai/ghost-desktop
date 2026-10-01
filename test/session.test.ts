import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionEnv } from "../src/session.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sessionEnv", () => {
  it("finds the Hyprland instance and its display when the host passed neither", () => {
    const runtime = mkdtempSync(join(tmpdir(), "ghost-desktop-session-"));
    dirs.push(runtime);
    const instance = join(runtime, "hypr", "sig1");
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, ".socket.sock"), "");
    writeFileSync(join(instance, "hyprland.lock"), "1944\nwayland-1\n");
    expect(sessionEnv({ XDG_RUNTIME_DIR: runtime })).toEqual({
      XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: "sig1", WAYLAND_DISPLAY: "wayland-1",
    });
  });

  it("keeps what the host passed", () => {
    expect(sessionEnv({ XDG_RUNTIME_DIR: "/r", HYPRLAND_INSTANCE_SIGNATURE: "mine", WAYLAND_DISPLAY: "wayland-9" }))
      .toEqual({ XDG_RUNTIME_DIR: "/r", HYPRLAND_INSTANCE_SIGNATURE: "mine" });
  });
});
