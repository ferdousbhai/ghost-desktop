import { describe, expect, it } from "vitest";
import { createCapture, imageSize, parseRegion } from "../src/capture.js";
import type { HyprClient, HyprMonitor } from "../src/hypr.js";
import type { Runner } from "../src/run.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const client: HyprClient = {
  address: "0xa", class: "foot", title: "t", pid: 1, at: [10, 20], size: [300, 200], workspace: { id: 2, name: "2" },
  monitor: 0, floating: false, fullscreen: 0, hidden: false, mapped: true, focusHistoryID: 0, stableId: "abc",
};
const showing = [{ activeWorkspace: { id: 2, name: "2" } }] as HyprMonitor[];
const elsewhere = [{ activeWorkspace: { id: 1, name: "1" } }] as HyprMonitor[];

describe("capture", () => {
  it("reads image sizes and regions", () => {
    expect(imageSize(png(640, 480))).toEqual([640, 480]);
    expect(parseRegion("10,20 300x200")).toEqual([10, 20, 300, 200]);
    expect(parseRegion("10,20,300x200")).toEqual([10, 20, 300, 200]);
    expect(() => parseRegion("big")).toThrow(/x,y WxH/);
  });

  it("reads a window's own buffer first", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => {
      calls.push([...argv]);
      return { code: 0, stdout: "", stderr: "", bytes: png(300, 200) };
    };
    const shot = await createCapture(run).window(client, elsewhere);
    expect(shot.via).toBe("window-buffer");
    expect(calls[0]).toContain("-T");
    expect(shot.geometry).toEqual([10, 20, 300, 200]);
  });

  it("falls back to the screen only for a shown window, and says so", async () => {
    const run: Runner = async (argv) => argv.includes("-T")
      ? { code: 1, stdout: "", stderr: "cannot find toplevel" }
      : { code: 0, stdout: "", stderr: "", bytes: png(300, 200) };
    const shot = await createCapture(run).window(client, showing);
    expect(shot.via).toBe("screen-region");
    expect(shot.warnings[0]).toMatch(/covering it would show/);
  });

  it("refuses a hidden window rather than returning another window's pixels", async () => {
    const run: Runner = async (argv) => argv.includes("-T")
      ? { code: 1, stdout: "", stderr: "cannot find toplevel" }
      : { code: 0, stdout: "", stderr: "", bytes: png(300, 200) };
    await expect(createCapture(run).window(client, elsewhere)).rejects.toMatchObject({ code: "unavailable" });
  });
});
