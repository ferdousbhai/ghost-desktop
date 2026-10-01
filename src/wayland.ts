// Wire protocol ported from hypruse (MIT, Ilyas Khallouki).
/**
 * A minimal Wayland client that owns one `zwlr_virtual_pointer_v1` device:
 * button, click, and wheel as a regular client of the compositor, so pointer
 * input needs no root, no uinput, and no daemon.
 * Absolute positioning stays with Hyprland's cursor-move dispatch.
 *
 * Wire format, little-endian: u32 object id, u32 (size << 16 | opcode), args;
 * strings are u32 length (with NUL), bytes, NUL, padding to 4; fixed is 24.8.
 */
import type { Socket } from "node:net";
import { join } from "node:path";
import { DesktopError } from "./errors.js";
import { ByteQueue, connectUnix, runtimeDir } from "./session.js";

export type MouseButton = "left" | "right" | "middle";

export interface VirtualPointer {
  button(button: MouseButton, pressed: boolean): Promise<void>;
  click(button: MouseButton, clicks: number): Promise<void>;
  scroll(dy: number, dx: number): Promise<void>;
  close(): Promise<void>;
}

const DISPLAY_ID = 1;
const REQ_SYNC = 0;
const REQ_GET_REGISTRY = 1;
const EV_ERROR = 0;
const REGISTRY_BIND = 0;
const REGISTRY_GLOBAL = 0;
const CALLBACK_DONE = 0;
const MGR_CREATE_POINTER = 0;
const MGR_DESTROY = 1;
export const PTR_BUTTON = 2;
export const PTR_AXIS = 3;
export const PTR_FRAME = 4;
export const PTR_AXIS_SOURCE = 5;
export const PTR_AXIS_DISCRETE = 7;
export const PTR_DESTROY = 8;

export const MANAGER_INTERFACE = "zwlr_virtual_pointer_manager_v1";
const BUTTON_CODES: Record<MouseButton, number> = { left: 0x110, right: 0x111, middle: 0x112 };
const AXIS_VERTICAL = 0;
const AXIS_HORIZONTAL = 1;
const AXIS_SOURCE_WHEEL = 0;
/** Continuous-axis length of one wheel notch. */
const SCROLL_UNITS_PER_NOTCH = 15;
const ROUNDTRIP_TIMEOUT_MS = 3_000;

export function wlString(value: string): Buffer {
  const raw = Buffer.concat([Buffer.from(value, "utf8"), Buffer.alloc(1)]);
  const padding = (4 - (raw.length % 4)) % 4;
  const length = Buffer.alloc(4);
  length.writeUInt32LE(raw.length);
  return Buffer.concat([length, raw, Buffer.alloc(padding)]);
}

export function toFixed(value: number): number {
  return Math.round(value * 256);
}

export function encodeMessage(objectId: number, opcode: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(objectId, 0);
  header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
  return Buffer.concat([header, body]);
}

export interface WireEvent {
  readonly objectId: number;
  readonly opcode: number;
  readonly body: Buffer;
}

/** Split a byte stream into complete events plus the unparsed remainder. */
export function parseEvents(buffer: Buffer): { events: WireEvent[]; rest: Buffer } {
  const events: WireEvent[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const objectId = buffer.readUInt32LE(offset);
    const header = buffer.readUInt32LE(offset + 4);
    const size = header >>> 16;
    if (size < 8 || buffer.length - offset < size) break;
    events.push({ objectId, opcode: header & 0xffff, body: buffer.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return { events, rest: buffer.subarray(offset) };
}

function readString(body: Buffer, offset: number): { value: string; next: number } {
  const length = body.readUInt32LE(offset);
  const value = body.subarray(offset + 4, offset + 4 + Math.max(0, length - 1)).toString("utf8");
  return { value, next: offset + 4 + length + ((4 - (length % 4)) % 4) };
}

function u32s(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) out.writeUInt32LE(value >>> 0, index * 4);
  return out;
}

function nowMs(): number {
  return Math.floor(performance.now()) >>> 0;
}

/** The (opcode, body) requests for one wheel scroll, ending in a frame. */
export function scrollMessages(dy: number, dx: number, discreteOk: boolean, time = nowMs()): Array<[number, Buffer]> {
  const messages: Array<[number, Buffer]> = [[PTR_AXIS_SOURCE, u32s(AXIS_SOURCE_WHEEL)]];
  for (const [axis, notchesWanted] of [[AXIS_VERTICAL, dy], [AXIS_HORIZONTAL, dx]] as const) {
    if (!notchesWanted) continue;
    const value = toFixed(notchesWanted * SCROLL_UNITS_PER_NOTCH);
    const notches = Math.round(notchesWanted);
    const body = Buffer.alloc(discreteOk && notches && Math.abs(notchesWanted - notches) < 1e-6 ? 16 : 12);
    body.writeUInt32LE(time, 0);
    body.writeUInt32LE(axis, 4);
    body.writeInt32LE(value, 8);
    if (body.length === 16) {
      body.writeInt32LE(notches, 12);
      messages.push([PTR_AXIS_DISCRETE, body]);
    } else {
      messages.push([PTR_AXIS, body]);
    }
  }
  messages.push([PTR_FRAME, Buffer.alloc(0)]);
  return messages;
}

function socketPath(env: NodeJS.ProcessEnv): string {
  const display = env.WAYLAND_DISPLAY || "wayland-0";
  return display.startsWith("/") ? display : join(runtimeDir(env), display);
}

class Connection {
  private readonly received = new ByteQueue();
  private nextId = 2;
  private failure: DesktopError | undefined;
  private readonly waiters = new Set<() => void>();
  readonly globals: Array<{ name: number; iface: string; version: number }> = [];
  registry = 0;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      const pending = this.received.push(chunk);
      const { events, rest } = parseEvents(pending);
      for (const event of events) this.handle(event);
      this.received.consume(pending.length - rest.length);
      this.wake();
    });
    socket.on("close", () => {
      this.failure ??= new DesktopError("failed", "The compositor closed the Wayland connection.");
      this.wake();
    });
    socket.on("error", (error) => {
      this.failure ??= new DesktopError("failed", `The Wayland connection failed: ${error.message}.`);
      this.wake();
    });
  }

  private readonly doneCallbacks = new Set<number>();

  private handle({ objectId, opcode, body }: WireEvent): void {
    if (objectId === DISPLAY_ID && opcode === EV_ERROR) {
      const object = body.readUInt32LE(0);
      const code = body.readUInt32LE(4);
      const message = readString(body, 8).value;
      this.failure ??= new DesktopError("failed", `The compositor rejected a pointer request (object ${object}, code ${code}): ${message}.`);
    } else if (objectId === this.registry && opcode === REGISTRY_GLOBAL) {
      const name = body.readUInt32LE(0);
      const iface = readString(body, 4);
      this.globals.push({ name, iface: iface.value, version: body.readUInt32LE(iface.next) });
    } else if (this.doneCallbacks.has(objectId) && opcode === CALLBACK_DONE) {
      this.doneCallbacks.delete(objectId);
    }
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }

  newId(): number {
    return this.nextId++;
  }

  send(objectId: number, opcode: number, body?: Buffer): void {
    if (this.failure) throw this.failure;
    this.socket.write(encodeMessage(objectId, opcode, body));
  }

  /** Resolve once the compositor has processed everything sent so far. */
  async roundtrip(): Promise<void> {
    const callback = this.newId();
    this.doneCallbacks.add(callback);
    this.send(DISPLAY_ID, REQ_SYNC, u32s(callback));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new DesktopError("failed", "The compositor did not answer a Wayland sync.")), ROUNDTRIP_TIMEOUT_MS);
      const finish = (error?: DesktopError) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.failure) finish(this.failure);
        else if (!this.doneCallbacks.has(callback)) finish();
      };
      this.waiters.add(check);
      check();
    });
  }

  end(): void {
    this.socket.destroy();
  }
}

/** Connect to the session's compositor and create one virtual pointer device. */
export async function openVirtualPointer(env: NodeJS.ProcessEnv = process.env): Promise<VirtualPointer> {
  const wire = new Connection(await connectUnix(socketPath(env), "The Wayland display"));
  try {
    wire.registry = wire.newId();
    wire.send(DISPLAY_ID, REQ_GET_REGISTRY, u32s(wire.registry));
    await wire.roundtrip();
    const manager = wire.globals.find((global) => global.iface === MANAGER_INTERFACE);
    if (!manager) {
      throw new DesktopError(
        "unavailable",
        `The compositor does not offer ${MANAGER_INTERFACE}, so pointer clicks, drags, and scrolls are unavailable; act on elements by ref instead.`,
      );
    }
    // axis_discrete exists from v2; remember what was actually bound.
    const version = Math.min(manager.version, 2);
    const managerId = wire.newId();
    wire.send(wire.registry, REGISTRY_BIND, Buffer.concat([u32s(manager.name), wlString(MANAGER_INTERFACE), u32s(version, managerId)]));
    const pointerId = wire.newId();
    wire.send(managerId, MGR_CREATE_POINTER, u32s(0, pointerId));
    await wire.roundtrip();
    return pointerFor(wire, managerId, pointerId, version);
  } catch (error) {
    wire.end();
    throw error;
  }
}

function pointerFor(wire: Connection, managerId: number, pointerId: number, version: number): VirtualPointer {
  let closed = false;
  const button = async (name: MouseButton, pressed: boolean) => {
    wire.send(pointerId, PTR_BUTTON, u32s(nowMs(), BUTTON_CODES[name], pressed ? 1 : 0));
    wire.send(pointerId, PTR_FRAME);
    await wire.roundtrip();
  };
  return {
    button,
    async click(name, clicks) {
      for (let index = 0; index < clicks; index += 1) {
        if (index) await Bun.sleep(60);
        await button(name, true);
        await Bun.sleep(20);
        await button(name, false);
      }
    },
    async scroll(dy, dx) {
      for (const [opcode, body] of scrollMessages(dy, dx, version >= 2)) wire.send(pointerId, opcode, body);
      await wire.roundtrip();
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        wire.send(pointerId, PTR_DESTROY);
        wire.send(managerId, MGR_DESTROY);
        await wire.roundtrip();
      } catch {
        // A dead connection already took the device with it.
      } finally {
        wire.end();
      }
    },
  };
}
