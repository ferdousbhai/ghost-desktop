import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopError } from "../src/errors.js";
import {
  encodeMessage,
  MANAGER_INTERFACE,
  openVirtualPointer,
  parseEvents,
  PTR_AXIS,
  PTR_AXIS_DISCRETE,
  PTR_AXIS_SOURCE,
  PTR_BUTTON,
  PTR_FRAME,
  PTR_MOTION,
  scrollMessages,
  toFixed,
  wlString,
} from "../src/wayland.js";

describe("wire encoding", () => {
  it("pads strings to four bytes and counts the NUL", () => {
    expect([...wlString("abc")]).toEqual([4, 0, 0, 0, 97, 98, 99, 0]);
    expect(wlString("abcd").length).toBe(4 + 8);
    expect(wlString("abcd").readUInt32LE(0)).toBe(5);
  });

  it("encodes 24.8 fixed point", () => {
    expect(toFixed(1)).toBe(256);
    expect(toFixed(-2.5)).toBe(-640);
  });

  it("packs size and opcode into the header and splits a stream back", () => {
    const message = encodeMessage(7, 3, Buffer.from([1, 2, 3, 4]));
    expect(message.readUInt32LE(0)).toBe(7);
    expect(message.readUInt32LE(4)).toBe((12 << 16) | 3);
    const { events, rest } = parseEvents(Buffer.concat([message, message.subarray(0, 5)]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ objectId: 7, opcode: 3 });
    expect(rest.length).toBe(5);
  });

  it("sends whole notches as axis_discrete and fractions as plain axis", () => {
    const whole = scrollMessages(2, 0, true, 9);
    expect(whole.map(([opcode]) => opcode)).toEqual([PTR_AXIS_SOURCE, PTR_AXIS_DISCRETE, PTR_FRAME]);
    expect(whole[1]![1].readInt32LE(8)).toBe(toFixed(30));
    expect(whole[1]![1].readInt32LE(12)).toBe(2);
    expect(scrollMessages(0.5, 0, true).map(([opcode]) => opcode)).toEqual([PTR_AXIS_SOURCE, PTR_AXIS, PTR_FRAME]);
    expect(scrollMessages(1, -1, false).map(([opcode]) => opcode)).toEqual([PTR_AXIS_SOURCE, PTR_AXIS, PTR_AXIS, PTR_FRAME]);
  });
});

interface Recorded {
  readonly objectId: number;
  readonly opcode: number;
  readonly body: Buffer;
}

/** A compositor that speaks just enough Wayland to host one virtual pointer. */
class FakeCompositor {
  readonly requests: Recorded[] = [];
  readonly dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "wl-fake-"));
  readonly path = join(this.dir, "wayland-test");
  private readonly server: Server;
  private sockets: Socket[] = [];
  registry = 0;
  pointer = 0;
  manager = 0;
  /** Send wl_display.error in reply to this pointer opcode. */
  failOn: number | undefined;

  constructor(private readonly globals: Array<[string, number]> = [["wl_seat", 7], [MANAGER_INTERFACE, 2]]) {
    this.server = createServer((socket) => {
      this.sockets.push(socket);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        const { events, rest } = parseEvents(Buffer.concat([buffer, chunk]));
        buffer = Buffer.from(rest);
        for (const event of events) this.handle(socket, event);
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve));
  }

  private handle(socket: Socket, event: Recorded): void {
    this.requests.push(event);
    const { objectId, opcode, body } = event;
    if (objectId === 1 && opcode === 1) {
      this.registry = body.readUInt32LE(0);
      this.globals.forEach(([iface, version], index) => {
        const tail = Buffer.alloc(4);
        tail.writeUInt32LE(version);
        const name = Buffer.alloc(4);
        name.writeUInt32LE(index + 1);
        socket.write(encodeMessage(this.registry, 0, Buffer.concat([name, wlString(iface), tail])));
      });
    } else if (objectId === 1 && opcode === 0) {
      socket.write(encodeMessage(body.readUInt32LE(0), 0, Buffer.alloc(4)));
    } else if (objectId === this.registry && opcode === 0) {
      const length = body.readUInt32LE(4);
      this.manager = body.readUInt32LE(8 + length + ((4 - (length % 4)) % 4) + 4);
    } else if (objectId === this.manager && opcode === 0) {
      this.pointer = body.readUInt32LE(4);
    } else if (objectId === this.pointer && opcode === this.failOn) {
      const message = wlString("bad button");
      const head = Buffer.alloc(8);
      head.writeUInt32LE(this.pointer, 0);
      head.writeUInt32LE(3, 4);
      socket.write(encodeMessage(1, 0, Buffer.concat([head, message])));
    }
  }

  pointerOps(): number[] {
    return this.requests.filter((request) => request.objectId === this.pointer).map((request) => request.opcode);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

describe("openVirtualPointer against a fake compositor", () => {
  let fake: FakeCompositor | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function start(globals?: Array<[string, number]>): Promise<FakeCompositor> {
    fake = new FakeCompositor(globals);
    await fake.listen();
    return fake;
  }

  it("binds the manager, creates a pointer, and sends button, wheel, and motion frames", async () => {
    const compositor = await start();
    const pointer = await openVirtualPointer({ WAYLAND_DISPLAY: compositor.path });
    await pointer.click("right", 2);
    await pointer.scroll(1, 0);
    await pointer.motion(3, -4);
    await pointer.close();
    expect(compositor.pointerOps()).toEqual([
      PTR_BUTTON, PTR_FRAME, PTR_BUTTON, PTR_FRAME, PTR_BUTTON, PTR_FRAME, PTR_BUTTON, PTR_FRAME,
      PTR_AXIS_SOURCE, PTR_AXIS_DISCRETE, PTR_FRAME,
      PTR_MOTION, PTR_FRAME,
      8,
    ]);
    const buttons = compositor.requests.filter((request) => request.objectId === compositor.pointer && request.opcode === PTR_BUTTON);
    expect(buttons.map((request) => [request.body.readUInt32LE(4), request.body.readUInt32LE(8)])).toEqual([
      [0x111, 1], [0x111, 0], [0x111, 1], [0x111, 0],
    ]);
    const motion = compositor.requests.find((request) => request.opcode === PTR_MOTION && request.objectId === compositor.pointer)!;
    expect([motion.body.readInt32LE(4), motion.body.readInt32LE(8)]).toEqual([768, -1024]);
    // The manager is destroyed after the pointer.
    expect(compositor.requests.at(-2)).toMatchObject({ objectId: compositor.manager, opcode: 1 });
  });

  it("stays on the continuous axis when only version 1 is offered", async () => {
    const compositor = await start([[MANAGER_INTERFACE, 1]]);
    const pointer = await openVirtualPointer({ WAYLAND_DISPLAY: compositor.path });
    await pointer.scroll(2, 0);
    await pointer.close();
    expect(compositor.pointerOps()).toContain(PTR_AXIS);
    expect(compositor.pointerOps()).not.toContain(PTR_AXIS_DISCRETE);
  });

  it("is unavailable when the compositor lacks the manager", async () => {
    const compositor = await start([["wl_seat", 7]]);
    const opened = openVirtualPointer({ WAYLAND_DISPLAY: compositor.path });
    await expect(opened).rejects.toBeInstanceOf(DesktopError);
    await expect(opened).rejects.toMatchObject({ code: "unavailable" });
  });

  it("turns wl_display.error into a failed DesktopError", async () => {
    const compositor = await start();
    compositor.failOn = PTR_BUTTON;
    const pointer = await openVirtualPointer({ WAYLAND_DISPLAY: compositor.path });
    await expect(pointer.button("left", true)).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("bad button") });
    await pointer.close();
  });

  it("is unavailable when nothing listens on the socket", async () => {
    await expect(openVirtualPointer({ WAYLAND_DISPLAY: "/nonexistent/wayland-9" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
