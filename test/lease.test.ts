import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopLease, LEASE_IDLE_MS } from "../src/lease.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lease(clock: { now: number }) {
  const dir = mkdtempSync(join(tmpdir(), "ghost-desktop-lease-"));
  dirs.push(dir);
  return [new DesktopLease(dir, () => clock.now), new DesktopLease(dir, () => clock.now)] as const;
}

describe("DesktopLease", () => {
  it("is shared through the file, so two processes take turns", async () => {
    const clock = { now: 1000 };
    const [a, b] = lease(clock);
    await a.claim("ghost dous");
    await expect(b.claim("claude-code 1234")).rejects.toThrow(/ghost dous\) is steering/);
    expect(b.peek()).toMatchObject({ holder: "ghost dous" });
    clock.now += LEASE_IDLE_MS - 1;
    await a.claim("ghost dous");
    clock.now += LEASE_IDLE_MS;
    await b.claim("claude-code 1234");
    await expect(a.claim("ghost dous")).rejects.toMatchObject({ code: "busy" });
  });
});
