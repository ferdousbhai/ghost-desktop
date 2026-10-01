import { DesktopError } from "./errors.js";
import { runCommand, type Runner } from "./run.js";

/** One window as `hyprctl -j clients` reports it, trimmed to what we use. */
export interface HyprClient {
  address: string;
  class: string;
  title: string;
  pid: number;
  at: [number, number];
  size: [number, number];
  workspace: { id: number; name: string };
  monitor: number;
  floating: boolean;
  fullscreen: number;
  hidden: boolean;
  mapped: boolean;
  focusHistoryID: number;
  /** Hyprland 0.56+ spells it stableId; earlier builds stable_id. */
  stableId?: string;
  stable_id?: string;
  xwayland?: boolean;
}

export interface HyprMonitor {
  id: number;
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
  address: string;
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

function luaTable(fields: Record<string, string | number | boolean | undefined>): string {
  const body = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name} = ${typeof value === "string" ? luaString(value) : String(value)}`)
    .join(", ");
  return `{ ${body} }`;
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

export function encodeIntent(intent: Intent, lua: boolean): string[] {
  switch (intent.kind) {
    case "focus":
      return lua ? [`hl.dsp.focus(${luaTable({ window: windowSelector(intent.address) })})`] : ["focuswindow", windowSelector(intent.address)];
    case "workspace": {
      const value = workspaceValue(intent.workspace);
      return lua ? [`hl.dsp.focus({ workspace = ${typeof value === "number" ? value : luaString(value)} })`] : ["workspace", intent.workspace];
    }
    case "move": {
      const value = workspaceValue(intent.workspace);
      // follow = false is the silent move; anything else drags the owner's view along.
      return lua
        ? [`hl.dsp.window.move({ workspace = ${typeof value === "number" ? value : luaString(value)}, window = ${luaString(windowSelector(intent.address))}, follow = false })`]
        : ["movetoworkspacesilent", `${intent.workspace},${windowSelector(intent.address)}`];
    }
    case "close":
      return lua ? [`hl.dsp.window.close(${luaTable({ window: windowSelector(intent.address) })})`] : ["closewindow", windowSelector(intent.address)];
    case "fullscreen":
      return lua
        ? [`hl.dsp.window.fullscreen(${luaTable({ mode: "fullscreen", action: "toggle", window: windowSelector(intent.address) })})`]
        : ["fullscreen", "0"];
    case "float":
      return lua ? [`hl.dsp.window.float(${luaTable({ action: "toggle", window: windowSelector(intent.address) })})`] : ["togglefloating", windowSelector(intent.address)];
    case "exec":
      return lua ? [`hl.dsp.exec_cmd(${luaString(intent.command)})`] : ["exec", intent.command];
    case "cursor":
      return lua
        ? [`hl.dsp.cursor.move({ x = ${Math.round(intent.x)}, y = ${Math.round(intent.y)} })`]
        : ["movecursor", String(Math.round(intent.x)), String(Math.round(intent.y))];
    case "shortcut":
      return lua
        ? [`hl.dsp.send_shortcut(${luaTable({ mods: intent.mods, key: intent.key, window: windowSelector(intent.address) })})`]
        : ["sendshortcut", `${intent.mods},${intent.key},${windowSelector(intent.address)}`];
  }
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
}

export function createHypr(run: Runner = runCommand, env: NodeJS.ProcessEnv = process.env): Hypr {
  let lua: boolean | undefined;

  const json = async <T>(what: string): Promise<T> => {
    const result = await run(["hyprctl", "-j", what], { timeoutMs: 5000 });
    if (result.code !== 0) {
      throw new DesktopError("unavailable", `hyprctl ${what} failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}. Is this a Hyprland session?`);
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new DesktopError("unavailable", `hyprctl ${what} did not answer with JSON; this is not a Hyprland session.`);
    }
  };

  // `-j status` names the config manager; pre-0.56 answers "unknown request", which means legacy strings.
  const provider = async (): Promise<boolean> => {
    if (lua === undefined) {
      const result = await run(["hyprctl", "-j", "status"], { timeoutMs: 5000 });
      try {
        lua = (JSON.parse(result.stdout) as { configProvider?: string }).configProvider === "lua";
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
      const active = await json<{ address?: string }>("activewindow");
      return active.address ?? null;
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
      const [hypr, logind] = await Promise.all([
        run(["hyprctl", "locked"], { timeoutMs: 3000 }).then(
          (result) => (result.code === 0 ? /^true$/i.test(result.stdout.trim()) ? true : /^false$/i.test(result.stdout.trim()) ? false : null : null),
          () => null,
        ),
        run(["loginctl", "show-session", ...(env.XDG_SESSION_ID ? [env.XDG_SESSION_ID] : []), "-p", "LockedHint", "--value"], { timeoutMs: 3000 }).then(
          (result) => (result.code === 0 ? /^(yes|true|1)$/i.test(result.stdout.trim()) ? true : /^(no|false|0)$/i.test(result.stdout.trim()) ? false : null : null),
          () => null,
        ),
      ]);
      if (hypr === true || logind === true) return true;
      if (hypr === null && logind === null) return null;
      return false;
    },
    async dispatch(intent) {
      const argv = ["hyprctl", "dispatch", ...encodeIntent(intent, await provider())];
      const result = await run(argv, { timeoutMs: 5000 });
      const out = result.stdout.trim();
      if (result.code !== 0 || out !== "ok") {
        throw new DesktopError("failed", `Hyprland refused ${intent.kind}: ${(out || result.stderr).slice(0, 200)}`);
      }
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
