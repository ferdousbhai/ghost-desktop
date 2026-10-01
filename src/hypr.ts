import type { Socket } from "node:net";
import { join } from "node:path";
import { DesktopError } from "./errors.js";
import { runCommand, type Runner } from "./run.js";
import { connectUnix, runtimeDir } from "./session.js";

/** One window as Hyprland reports it, trimmed to what we use. */
export interface HyprClient {
  address: string;
  class: string;
  title: string;
  pid: number;
  at: [number, number];
  size: [number, number];
  workspace: { id: number; name: string };
  floating: boolean;
  fullscreen: number;
  hidden: boolean;
  mapped: boolean;
  focusHistoryID: number;
  /** Hyprland 0.56+ spells it stableId; earlier builds stable_id. */
  stableId?: string;
  stable_id?: string;
}

export interface HyprMonitor {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  focused: boolean;
  activeWorkspace: { id: number; name: string };
  specialWorkspace?: { id: number; name: string };
}

export interface HyprLayer {
  namespace: string;
  x: number;
  y: number;
  w: number;
  h: number;
  level: number;
  monitor: string;
}

const LUA_LITERAL = (byte: number) => byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c;

/**
 * A Lua string literal, byte for byte. Under the Lua config manager
 * `hyprctl dispatch` evaluates its argument as code inside the compositor,
 * so every value goes through here and never through raw interpolation.
 */
export function luaString(text: string): string {
  if (text.includes("\0")) throw new DesktopError("invalid", "A NUL byte cannot be sent to Hyprland.");
  let body = "";
  for (const byte of new TextEncoder().encode(text)) {
    body += LUA_LITERAL(byte) ? String.fromCharCode(byte) : `\\${byte.toString().padStart(3, "0")}`;
  }
  return `"${body}"`;
}

function luaTable(fields: Record<string, string | number | boolean>): string {
  const body = Object.entries(fields).map(([name, value]) => `${name} = ${typeof value === "string" ? luaString(value) : String(value)}`);
  return `{ ${body.join(", ")} }`;
}

function windowSelector(address: string): string {
  return address.includes(":") ? address : `address:${address}`;
}

function workspaceValue(workspace: string): string | number {
  return /^-?\d+$/.test(workspace) ? Number(workspace) : workspace;
}

/** A desktop intent in both dispatch grammars: Lua (0.56+) and the legacy strings. */
export type Intent =
  | { kind: "focus"; address: string }
  | { kind: "workspace"; workspace: string }
  | { kind: "move"; address: string; workspace: string }
  | { kind: "close"; address: string }
  | { kind: "fullscreen"; address: string }
  | { kind: "float"; address: string }
  | { kind: "exec"; command: string }
  | { kind: "cursor"; x: number; y: number }
  | { kind: "shortcut"; mods: string; key: string; address: string };

/** The argument of `dispatch`: one Lua call, or a legacy dispatcher and its argument. */
export function encodeIntent(intent: Intent, lua: boolean): string {
  const call = (fn: string, fields: Record<string, string | number | boolean>) => `hl.dsp.${fn}(${luaTable(fields)})`;
  switch (intent.kind) {
    case "focus": {
      const window = windowSelector(intent.address);
      return lua ? call("focus", { window }) : `focuswindow ${window}`;
    }
    case "workspace":
      return lua ? call("focus", { workspace: workspaceValue(intent.workspace) }) : `workspace ${intent.workspace}`;
    case "move": {
      const window = windowSelector(intent.address);
      // follow = false is the silent move; anything else drags the owner's view along.
      return lua
        ? call("window.move", { workspace: workspaceValue(intent.workspace), window, follow: false })
        : `movetoworkspacesilent ${intent.workspace},${window}`;
    }
    case "close": {
      const window = windowSelector(intent.address);
      return lua ? call("window.close", { window }) : `closewindow ${window}`;
    }
    case "fullscreen":
      return lua ? call("window.fullscreen", { mode: "fullscreen", action: "toggle", window: windowSelector(intent.address) }) : "fullscreen 0";
    case "float": {
      const window = windowSelector(intent.address);
      return lua ? call("window.float", { action: "toggle", window }) : `togglefloating ${window}`;
    }
    case "exec":
      return lua ? `hl.dsp.exec_cmd(${luaString(intent.command)})` : `exec ${intent.command}`;
    case "cursor": {
      const [x, y] = [Math.round(intent.x), Math.round(intent.y)];
      return lua ? call("cursor.move", { x, y }) : `movecursor ${x} ${y}`;
    }
    case "shortcut": {
      const window = windowSelector(intent.address);
      return lua ? call("send_shortcut", { mods: intent.mods, key: intent.key, window }) : `sendshortcut ${intent.mods},${intent.key},${window}`;
    }
  }
}

export interface HyprEvent {
  readonly name: string;
  readonly data: string;
}

export interface Hypr {
  clients(): Promise<HyprClient[]>;
  monitors(): Promise<HyprMonitor[]>;
  activeAddress(): Promise<string | null>;
  layers(): Promise<HyprLayer[]>;
  cursor(): Promise<[number, number]>;
  /** True locked, false unlocked, null when nothing could tell. */
  locked(): Promise<boolean | null>;
  dispatch(intent: Intent): Promise<void>;
  /**
   * The first event named in `names` whose data contains `match`, or null at
   * the timeout. `after` runs once the listener is connected, so an event it
   * causes cannot be missed.
   */
  waitEvent(names: readonly string[], options: { match?: string; timeoutMs: number; after?: () => Promise<void> }): Promise<HyprEvent | null>;
}

/** Sends one request on Hyprland's request socket and returns the whole reply. */
export type HyprRequest = (command: string) => Promise<string>;

function socketDir(env: NodeJS.ProcessEnv): string {
  const signature = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!signature) throw new DesktopError("unavailable", "HYPRLAND_INSTANCE_SIGNATURE is unset; this is not a Hyprland session.");
  return join(runtimeDir(env), "hypr", signature);
}

/** Hyprland's own request socket: what `hyprctl` speaks, without a process per call. */
export function socketRequest(env: NodeJS.ProcessEnv): HyprRequest {
  return async (command) => {
    const socket = await connectUnix(join(socketDir(env), ".socket.sock"), "Hyprland");
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DesktopError("failed", `Hyprland did not answer ${command.split(" ", 1)[0]}.`));
      }, 5000);
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.once("close", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      socket.end(command);
    });
  };
}

/** `hyprctl locked` and logind's LockedHint each answer yes, no, or nothing. */
const verdict = (text: string | null, yes: RegExp, no: RegExp): boolean | null =>
  text === null ? null : yes.test(text.trim()) ? true : no.test(text.trim()) ? false : null;

export function createHypr(options: { env?: NodeJS.ProcessEnv; request?: HyprRequest; run?: Runner } = {}): Hypr {
  const env = options.env ?? process.env;
  const request = options.request ?? socketRequest(env);
  const run = options.run ?? runCommand;
  let lua: boolean | undefined;

  const json = async <T>(what: string): Promise<T> => {
    const reply = await request(`j/${what}`);
    try {
      return JSON.parse(reply) as T;
    } catch {
      throw new DesktopError("unavailable", `Hyprland answered ${what} without JSON: ${reply.slice(0, 120)}`);
    }
  };

  // `status` names the config manager; before 0.56 it is an unknown request, which means legacy strings.
  const provider = async (): Promise<boolean> => {
    if (lua === undefined) {
      try {
        lua = (await json<{ configProvider?: string }>("status")).configProvider === "lua";
      } catch {
        lua = false;
      }
    }
    return lua;
  };

  return {
    clients: () => json<HyprClient[]>("clients"),
    monitors: () => json<HyprMonitor[]>("monitors"),
    async activeAddress() {
      return (await json<{ address?: string }>("activewindow")).address ?? null;
    },
    async layers() {
      const raw = await json<Record<string, { levels: Record<string, Array<Omit<HyprLayer, "level" | "monitor">>> }>>("layers");
      return Object.entries(raw).flatMap(([monitor, { levels }]) =>
        Object.entries(levels).flatMap(([level, items]) => items.map((item) => ({ ...item, level: Number(level), monitor }))));
    },
    async cursor() {
      const pos = await json<{ x: number; y: number }>("cursorpos");
      return [pos.x, pos.y];
    },
    async locked() {
      const session = env.XDG_SESSION_ID ? [env.XDG_SESSION_ID] : [];
      const [hypr, logind] = await Promise.all([
        request("locked").catch(() => null),
        run(["loginctl", "show-session", ...session, "-p", "LockedHint", "--value"], { timeoutMs: 3000 })
          .then((result) => (result.code === 0 ? result.stdout : null), () => null),
      ]);
      const fromHypr = verdict(hypr, /^true$/i, /^false$/i);
      const fromLogind = verdict(logind, /^(yes|true|1)$/i, /^(no|false|0)$/i);
      if (fromHypr === true || fromLogind === true) return true;
      return fromHypr === null && fromLogind === null ? null : false;
    },
    async dispatch(intent) {
      const reply = (await request(`dispatch ${encodeIntent(intent, await provider())}`)).trim();
      if (reply !== "ok") throw new DesktopError("failed", `Hyprland refused ${intent.kind}: ${reply.slice(0, 200)}`);
    },
    async waitEvent(names, { match, timeoutMs, after }) {
      const socket: Socket = await connectUnix(join(socketDir(env), ".socket2.sock"), "Hyprland's event socket");
      const folded = match?.toLowerCase();
      const seen = new Promise<HyprEvent | null>((resolve) => {
        let buffer = "";
        const finish = (event: HyprEvent | null) => {
          clearTimeout(timer);
          socket.destroy();
          resolve(event);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.on("close", () => finish(null));
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const [name = "", data = ""] = line.split(">>", 2);
            if (names.includes(name) && (!folded || data.toLowerCase().includes(folded))) return finish({ name, data });
          }
        });
      });
      try {
        await after?.();
      } catch (error) {
        socket.destroy();
        throw error;
      }
      return seen;
    },
  };
}

/** Find one window by address, exact class, or title fragment; "active" is the focused one. */
export function resolveWindow(clients: readonly HyprClient[], active: string | null, query?: string): HyprClient {
  const target = query?.trim();
  if (!target || target === "active") {
    const found = clients.find((client) => client.address === active);
    if (!found) throw new DesktopError("not_found", "No window has focus; name one by address, class, or title.");
    return found;
  }
  if (/^0x[0-9a-f]+$/i.test(target)) {
    const byAddress = clients.find((client) => client.address.toLowerCase() === target.toLowerCase());
    if (!byAddress) throw new DesktopError("not_found", `No window has address ${target}; it may have closed. Look at the desktop again.`);
    return byAddress;
  }
  const folded = target.toLowerCase();
  const byClass = clients.filter((client) => client.class.toLowerCase() === folded);
  const byTitle = byClass.length ? byClass : clients.filter((client) => client.title.toLowerCase().includes(folded) || client.class.toLowerCase().includes(folded));
  if (byTitle.length === 0) throw new DesktopError("not_found", `No open window matches ${JSON.stringify(target)}.`);
  // Several matches: the most recently focused one, which is what a person means by "the terminal".
  return byTitle.reduce((best, client) => (client.focusHistoryID < best.focusHistoryID ? client : best));
}

/** Whether any monitor currently shows the window's workspace. */
export function windowShown(client: HyprClient, monitors: readonly HyprMonitor[]): boolean {
  if (client.hidden || !client.mapped) return false;
  return monitors.some((monitor) => monitor.activeWorkspace.id === client.workspace.id || monitor.specialWorkspace?.id === client.workspace.id);
}
