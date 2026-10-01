/**
 * A minimal D-Bus client: SASL EXTERNAL over a unix socket, method calls with
 * serial-matched replies, and the wire marshalling of the basic type system.
 * Enough for AT-SPI; no signals, no fd passing, no server side.
 */
import type { Socket } from "node:net";
import { DesktopError } from "./errors.js";
import { ByteQueue, connectUnix, runtimeDir } from "./session.js";

export interface Variant {
  readonly signature: string;
  readonly value: DBusValue;
}

/** A dict (`a{..}`) is an array of `[key, value]` pairs; a struct is an array. */
export type DBusValue = number | bigint | boolean | string | Variant | DBusValue[];

export function variant(signature: string, value: DBusValue): Variant {
  return { signature, value };
}

function isVariant(value: unknown): value is Variant {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "signature" in value && "value" in value;
}

/** A D-Bus error reply, or a lost connection (`org.ghost.Disconnected`). */
export class DBusError extends Error {
  constructor(readonly dbusName: string, message: string) {
    super(message);
    this.name = "DBusError";
  }
}

// --- signatures -------------------------------------------------------------

function completeTypeEnd(sig: string, start: number): number {
  const c = sig[start];
  if (c === undefined) throw new Error(`signature ${JSON.stringify(sig)} ends early`);
  if (c === "a") return completeTypeEnd(sig, start + 1);
  if (c === "(" || c === "{") {
    const close = c === "(" ? ")" : "}";
    let i = start + 1;
    while (sig[i] !== close) {
      if (i >= sig.length) throw new Error(`signature ${JSON.stringify(sig)} is unbalanced`);
      i = completeTypeEnd(sig, i);
    }
    return i + 1;
  }
  if (!"ybnqiuxtdsoghv".includes(c)) throw new Error(`unsupported D-Bus type ${JSON.stringify(c)}`);
  return start + 1;
}

/** Split a signature into its complete types: `"sa{sv}(ii)"` → `["s", "a{sv}", "(ii)"]`. */
function splitSignature(sig: string): string[] {
  const types: string[] = [];
  for (let i = 0; i < sig.length;) {
    const end = completeTypeEnd(sig, i);
    types.push(sig.slice(i, end));
    i = end;
  }
  return types;
}

function alignOf(type: string): number {
  switch (type[0]) {
    case "y": case "g": case "v": return 1;
    case "n": case "q": return 2;
    case "x": case "t": case "d": case "(": case "{": return 8;
    default: return 4;
  }
}

// --- marshalling ------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Writer {
  bytes = new Uint8Array(256);
  view = new DataView(this.bytes.buffer);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  align(n: number): void {
    const pad = (n - (this.length % n)) % n;
    this.ensure(pad);
    this.bytes.fill(0, this.length, this.length + pad);
    this.length += pad;
  }

  raw(data: Uint8Array): void {
    this.ensure(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  put(size: number, set: (view: DataView, at: number) => void): void {
    this.align(size);
    this.ensure(size);
    set(this.view, this.length);
    this.length += size;
  }

  u32At(at: number, value: number): void {
    this.view.setUint32(at, value, true);
  }

  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function asBigInt(value: DBusValue): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  throw new TypeError(`expected an integer, got ${String(value)}`);
}

function asNumber(value: DBusValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new TypeError(`expected a number, got ${String(value)}`);
}

function writeString(w: Writer, value: DBusValue, lengthBytes: 1 | 4): void {
  if (typeof value !== "string") throw new TypeError(`expected a string, got ${String(value)}`);
  const data = encoder.encode(value);
  if (lengthBytes === 1) w.put(1, (v, at) => v.setUint8(at, data.length));
  else w.put(4, (v, at) => v.setUint32(at, data.length, true));
  w.raw(data);
  w.raw(new Uint8Array([0]));
}

function writeValue(w: Writer, type: string, value: DBusValue): void {
  switch (type[0]) {
    case "y": w.put(1, (v, at) => v.setUint8(at, asNumber(value))); return;
    case "b": w.put(4, (v, at) => v.setUint32(at, value ? 1 : 0, true)); return;
    case "n": w.put(2, (v, at) => v.setInt16(at, asNumber(value), true)); return;
    case "q": w.put(2, (v, at) => v.setUint16(at, asNumber(value), true)); return;
    case "i": w.put(4, (v, at) => v.setInt32(at, asNumber(value), true)); return;
    case "u": case "h": w.put(4, (v, at) => v.setUint32(at, asNumber(value), true)); return;
    case "x": w.put(8, (v, at) => v.setBigInt64(at, asBigInt(value), true)); return;
    case "t": w.put(8, (v, at) => v.setBigUint64(at, asBigInt(value), true)); return;
    case "d": w.put(8, (v, at) => v.setFloat64(at, asNumber(value), true)); return;
    case "s": case "o": writeString(w, value, 4); return;
    case "g": writeString(w, value, 1); return;
    case "v": {
      if (!isVariant(value)) throw new TypeError("a variant needs { signature, value }");
      writeString(w, value.signature, 1);
      writeValue(w, value.signature, value.value);
      return;
    }
    case "a": {
      if (!Array.isArray(value)) throw new TypeError(`expected an array for ${type}`);
      const element = type.slice(1);
      w.align(4);
      const lengthAt = w.length;
      w.put(4, () => {});
      w.align(alignOf(element));
      const start = w.length;
      for (const item of value) writeValue(w, element, item);
      w.u32At(lengthAt, w.length - start);
      return;
    }
    case "(": case "{": {
      if (!Array.isArray(value)) throw new TypeError(`expected an array for ${type}`);
      const fields = splitSignature(type.slice(1, -1));
      if (fields.length !== value.length) throw new TypeError(`${type} needs ${fields.length} fields, got ${value.length}`);
      w.align(8);
      for (const [i, field] of fields.entries()) writeValue(w, field, value[i] as DBusValue);
      return;
    }
    default:
      throw new TypeError(`unsupported D-Bus type ${type}`);
  }
}

/** Marshal `values` per `signature`, starting 8-aligned as a message body does. */
export function marshal(signature: string, values: readonly DBusValue[]): Uint8Array {
  const types = splitSignature(signature);
  if (types.length !== values.length) throw new TypeError(`signature ${signature} needs ${types.length} values, got ${values.length}`);
  const w = new Writer();
  for (const [i, type] of types.entries()) writeValue(w, type, values[i] as DBusValue);
  return w.result();
}

class Reader {
  readonly view: DataView;
  offset: number;

  constructor(readonly bytes: Uint8Array, readonly le: boolean, start = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = start;
  }

  align(n: number): void {
    this.offset += (n - (this.offset % n)) % n;
  }

  take(size: number): number {
    this.align(size);
    const at = this.offset;
    if (at + size > this.bytes.length) throw new RangeError("D-Bus message is truncated");
    this.offset += size;
    return at;
  }

  string(lengthBytes: 1 | 4): string {
    const length = lengthBytes === 1 ? this.view.getUint8(this.take(1)) : this.view.getUint32(this.take(4), this.le);
    const end = this.offset + length;
    if (end + 1 > this.bytes.length) throw new RangeError("D-Bus string is truncated");
    const text = decoder.decode(this.bytes.subarray(this.offset, end));
    this.offset = end + 1;
    return text;
  }
}

function readValue(r: Reader, type: string): DBusValue {
  const { view, le } = r;
  switch (type[0]) {
    case "y": return view.getUint8(r.take(1));
    case "b": return view.getUint32(r.take(4), le) !== 0;
    case "n": return view.getInt16(r.take(2), le);
    case "q": return view.getUint16(r.take(2), le);
    case "i": return view.getInt32(r.take(4), le);
    case "u": case "h": return view.getUint32(r.take(4), le);
    case "x": return view.getBigInt64(r.take(8), le);
    case "t": return view.getBigUint64(r.take(8), le);
    case "d": return view.getFloat64(r.take(8), le);
    case "s": case "o": return r.string(4);
    case "g": return r.string(1);
    case "v": {
      const signature = r.string(1);
      return variant(signature, readValue(r, signature));
    }
    case "a": {
      const length = view.getUint32(r.take(4), le);
      const element = type.slice(1);
      r.align(alignOf(element));
      const end = r.offset + length;
      if (end > r.bytes.length) throw new RangeError("D-Bus array is truncated");
      const items: DBusValue[] = [];
      while (r.offset < end) items.push(readValue(r, element));
      return items;
    }
    case "(": case "{": {
      r.align(8);
      return splitSignature(type.slice(1, -1)).map((field) => readValue(r, field));
    }
    default:
      throw new TypeError(`unsupported D-Bus type ${type}`);
  }
}

// --- messages ---------------------------------------------------------------

export const MessageType = { MethodCall: 1, MethodReturn: 2, Error: 3, Signal: 4 } as const;

export interface DBusMessage {
  readonly type: number;
  readonly serial: number;
  readonly path?: string;
  readonly interface?: string;
  readonly member?: string;
  readonly errorName?: string;
  readonly replySerial?: number;
  readonly destination?: string;
  readonly signature?: string;
  readonly body?: readonly DBusValue[];
}

/** The header fields this client writes or reads; others are skipped. */
const FIELDS = [
  [1, "path", "o"],
  [2, "interface", "s"],
  [3, "member", "s"],
  [4, "errorName", "s"],
  [5, "replySerial", "u"],
  [6, "destination", "s"],
  [8, "signature", "g"],
] as const;

export function encodeMessage(message: DBusMessage): Uint8Array {
  const signature = message.signature ?? "";
  const body = marshal(signature, message.body ?? []);
  const fields: DBusValue[] = [];
  for (const [code, key, sig] of FIELDS) {
    const value = key === "signature" ? (signature || undefined) : message[key];
    if (value !== undefined) fields.push([code, variant(sig, value)]);
  }
  const w = new Writer();
  w.raw(new Uint8Array([0x6c, message.type, 0, 1]));
  w.put(4, (v, at) => v.setUint32(at, body.length, true));
  w.put(4, (v, at) => v.setUint32(at, message.serial, true));
  writeValue(w, "a(yv)", fields);
  w.align(8);
  w.raw(body);
  return w.result();
}

/** Split complete messages off the front of `buffer`; `rest` is the incomplete tail, not copied. */
export function decodeMessages(buffer: Uint8Array): { messages: DBusMessage[]; rest: Uint8Array } {
  const messages: DBusMessage[] = [];
  let at = 0;
  while (buffer.length - at >= 16) {
    const le = buffer[at] === 0x6c;
    if (!le && buffer[at] !== 0x42) throw new Error("D-Bus message has an unknown byte order");
    const view = new DataView(buffer.buffer, buffer.byteOffset + at);
    const bodyLength = view.getUint32(4, le);
    const fieldsLength = view.getUint32(12, le);
    const bodyStart = Math.ceil((16 + fieldsLength) / 8) * 8;
    const total = bodyStart + bodyLength;
    if (buffer.length - at < total) break;
    const frame = buffer.subarray(at, at + total);
    const header = new Reader(frame, le, 12);
    const record: Record<string, unknown> = { type: frame[1], serial: view.getUint32(8, le) };
    for (const field of readValue(header, "a(yv)") as DBusValue[][]) {
      const code = field[0] as number;
      const named = FIELDS.find(([c]) => c === code);
      if (named) record[named[1]] = (field[1] as Variant).value;
    }
    const signature = (record.signature as string | undefined) ?? "";
    const bodyReader = new Reader(frame.subarray(bodyStart), le);
    record.body = splitSignature(signature).map((type) => readValue(bodyReader, type));
    messages.push(record as unknown as DBusMessage);
    at += total;
  }
  return { messages, rest: buffer.subarray(at) };
}

// --- connection -------------------------------------------------------------

/** The first `unix:` address in a D-Bus address list, as a socket path (abstract → leading NUL). */
export function socketPathOf(address: string): string {
  for (const entry of address.split(";")) {
    const colon = entry.indexOf(":");
    if (entry.slice(0, colon) !== "unix") continue;
    const params = new Map(entry.slice(colon + 1).split(",").map((pair) => {
      const eq = pair.indexOf("=");
      return [pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1))] as const;
    }));
    const path = params.get("path");
    if (path) return path;
    const abstract = params.get("abstract");
    if (abstract) return `\0${abstract}`;
  }
  throw new DesktopError("unavailable", `No usable unix socket in the D-Bus address ${JSON.stringify(address)}.`);
}

export function sessionBusAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir(env)}/bus`;
}

export interface CallOptions {
  readonly destination: string;
  readonly path: string;
  readonly interface: string;
  readonly member: string;
  readonly signature?: string;
  readonly body?: readonly DBusValue[];
  readonly timeoutMs?: number;
}

interface Pending {
  resolve(body: DBusValue[]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function uidHex(): string {
  const uid = String(process.getuid?.() ?? 0);
  return [...uid].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export class DBusConnection {
  private serial = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly received = new ByteQueue();
  private closedError: DBusError | null = null;

  private constructor(private readonly socket: Socket, private readonly defaultTimeoutMs: number) {}

  /** Connect, authenticate, and register with the bus (Hello). */
  static async connect(address: string, options: { timeoutMs?: number } = {}): Promise<DBusConnection> {
    const path = socketPathOf(address);
    const timeoutMs = options.timeoutMs ?? 3000;
    const abstract = path.startsWith("\0") ? " (an abstract socket, which this runtime may not support)" : "";
    const socket = await connectUnix(path, `The D-Bus socket${abstract}`, timeoutMs);
    const connection = new DBusConnection(socket, timeoutMs);
    await connection.authenticate(timeoutMs).catch((error: Error) => {
      socket.destroy();
      throw new DesktopError("unavailable", `D-Bus authentication failed on ${address}: ${error.message}.`, { address });
    });
    await connection.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "Hello" });
    return connection;
  }

  private authenticate(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => finish(new Error("no answer to AUTH")), timeoutMs);
      const finish = (error?: Error, leftover?: Buffer) => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        if (error) return reject(error);
        this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
        this.socket.on("error", (e) => this.fail(e.message));
        this.socket.on("close", () => this.fail("connection closed"));
        if (leftover?.length) this.receive(leftover);
        resolve();
      };
      const onError = (error: Error) => finish(error);
      const onData = (chunk: Buffer) => {
        text += chunk.toString("latin1");
        const end = text.indexOf("\r\n");
        if (end < 0) return;
        const line = text.slice(0, end);
        if (!line.startsWith("OK ")) return finish(new Error(`server said ${JSON.stringify(line)}`));
        this.socket.write("BEGIN\r\n");
        finish(undefined, Buffer.from(text.slice(end + 2), "latin1"));
      };
      this.socket.on("data", onData);
      this.socket.on("error", onError);
      this.socket.write(`\0AUTH EXTERNAL ${uidHex()}\r\n`);
    });
  }

  private receive(chunk: Uint8Array): void {
    const pending = this.received.push(chunk);
    let decoded: ReturnType<typeof decodeMessages>;
    try {
      decoded = decodeMessages(pending);
    } catch (error) {
      this.fail((error as Error).message);
      this.socket.destroy();
      return;
    }
    this.received.consume(pending.length - decoded.rest.length);
    for (const message of decoded.messages) {
      if (message.replySerial === undefined) continue;
      const waiter = this.pending.get(message.replySerial);
      if (!waiter) continue;
      this.pending.delete(message.replySerial);
      clearTimeout(waiter.timer);
      if (message.type === MessageType.Error) {
        const text = typeof message.body?.[0] === "string" ? message.body[0] : message.errorName ?? "error";
        waiter.reject(new DBusError(message.errorName ?? "org.freedesktop.DBus.Error.Failed", text));
      } else {
        waiter.resolve([...(message.body ?? [])]);
      }
    }
  }

  private fail(reason: string): void {
    if (this.closedError) return;
    this.closedError = new DBusError("org.ghost.Disconnected", `D-Bus connection lost: ${reason}`);
    for (const [serial, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(this.closedError);
      this.pending.delete(serial);
    }
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  call(options: CallOptions): Promise<DBusValue[]> {
    if (this.closedError) return Promise.reject(this.closedError);
    const serial = ++this.serial;
    const frame = encodeMessage({
      type: MessageType.MethodCall,
      serial,
      destination: options.destination,
      path: options.path,
      interface: options.interface,
      member: options.member,
      ...(options.signature ? { signature: options.signature, body: options.body ?? [] } : {}),
    });
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new DBusError("org.freedesktop.DBus.Error.Timeout", `${options.interface}.${options.member} got no reply within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(serial, { resolve, reject, timer });
      this.socket.write(frame);
    });
  }

  close(): void {
    this.fail("closed");
    this.socket.destroy();
  }
}
