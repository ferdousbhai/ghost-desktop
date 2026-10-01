import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessages, encodeMessage, MessageType, type DBusMessage, type DBusValue } from "../../src/dbus.js";

/** A reply, an error reply, or null for no reply at all. */
export type FakeReply = { signature?: string; body?: DBusValue[] } | { error: string; text: string } | null;

export interface FakeBus {
  readonly address: string;
  close(): void;
}

/**
 * A D-Bus peer on a temp unix socket: accepts any SASL AUTH, answers Hello,
 * and answers every other call from `handler`.
 */
export async function fakeBus(handler: (message: DBusMessage) => FakeReply): Promise<FakeBus> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dbus-"));
  const path = join(dir, "bus");
  let serial = 1000;
  const server = net.createServer((socket) => {
    let authed = false;
    let buffer: Uint8Array = new Uint8Array(0);
    socket.on("data", (data: Buffer) => {
      let chunk: Uint8Array = data;
      if (!authed) {
        const text = data.toString("latin1");
        if (text.includes("AUTH")) socket.write("OK 0123456789abcdef\r\n");
        if (!text.includes("BEGIN")) return;
        authed = true;
        chunk = Buffer.from(text.slice(text.indexOf("BEGIN\r\n") + 7), "latin1");
      }
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      const { messages, rest } = decodeMessages(joined);
      buffer = rest.slice();
      for (const message of messages) {
        const reply = message.member === "Hello" ? { signature: "s", body: [":1.42"] } : handler(message);
        if (reply === null) continue;
        socket.write("error" in reply
          ? encodeMessage({ type: MessageType.Error, serial: ++serial, replySerial: message.serial, errorName: reply.error, signature: "s", body: [reply.text] })
          : encodeMessage({ type: MessageType.MethodReturn, serial: ++serial, replySerial: message.serial, ...(reply.signature ? { signature: reply.signature, body: reply.body ?? [] } : {}) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    address: `unix:path=${path}`,
    close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
