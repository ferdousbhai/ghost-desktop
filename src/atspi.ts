/**
 * AT-SPI over the hand-rolled D-Bus client: read one window's accessibility
 * tree, mint refs for its elements, and act on them by ref. Coordinates are
 * screen coordinates: AT-SPI's window-relative extents plus the window's
 * Hyprland position, because Wayland clients cannot report screen positions.
 */
import { DBusConnection, DBusError, sessionBusAddress, variant, type DBusValue, type Variant } from "./dbus.js";
import { DesktopError } from "./errors.js";

export interface AxWindow {
  readonly pid: number;
  readonly at: readonly [number, number];
  /** The window title; picks the right frame when one process owns several windows. */
  readonly title?: string;
}

export interface AxElement {
  ref: string;
  role: string;
  name: string;
  states: string[];
  actions: string[];
  /** Screen x, y, width, height. */
  box?: [number, number, number, number];
  value?: number;
  text?: string;
  checked?: boolean;
}

export interface AxQuery {
  role?: string;
  text?: string;
  actionable?: boolean;
  limit: number;
}

export interface AxQueryResult {
  elements: AxElement[];
  total: number;
  roles: Record<string, number>;
}

export interface Atspi {
  query(window: AxWindow, query: AxQuery): Promise<AxQueryResult>;
  perform(ref: string, action?: string): Promise<void>;
  setText(ref: string, text: string): Promise<void>;
  setValue(ref: string, value: number): Promise<void>;
  focus(ref: string): Promise<void>;
  /** A ref's current window-relative box, and the pid owning it, for aiming the pointer. */
  extents(ref: string): Promise<{ box?: [number, number, number, number]; pid: number }>;
  close(): Promise<void>;
}

/** The rounded center of an element's box, where a pointer click lands. */
export function centerOf(element: Pick<AxElement, "box">): [number, number] | undefined {
  if (!element.box) return undefined;
  const [x, y, width, height] = element.box;
  return [Math.round(x + width / 2), Math.round(y + height / 2)];
}

const ACCESSIBLE = "org.a11y.atspi.Accessible";
const COMPONENT = "org.a11y.atspi.Component";
const ACTION = "org.a11y.atspi.Action";
const VALUE = "org.a11y.atspi.Value";
const TEXT = "org.a11y.atspi.Text";
const EDITABLE_TEXT = "org.a11y.atspi.EditableText";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const REGISTRY = "org.a11y.atspi.Registry";
const ROOT_PATH = "/org/a11y/atspi/accessible/root";
const COORD_WINDOW = 1;
const MAX_NODES = 4000;
const MAX_DEPTH = 60;
const CALL_TIMEOUT_MS = 2000;
/** Calls in flight at once, so a big tree never queues thousands of pending calls and timers. */
const MAX_IN_FLIGHT = 32;
/** A safety bound on text transferred per element; the caller trims for display. */
const MAX_TEXT = 4000;
const MAX_REFS = 5000;

/** AT-SPI's StateType enum, in bit order. */
export const STATE_NAMES = [
  "invalid", "active", "armed", "busy", "checked", "collapsed", "defunct", "editable",
  "enabled", "expandable", "expanded", "focusable", "focused", "has_tooltip", "horizontal", "iconified",
  "modal", "multi_line", "multiselectable", "opaque", "pressed", "resizable", "selectable", "selected",
  "sensitive", "showing", "single_line", "stale", "transient", "vertical", "visible", "manages_descendants",
  "indeterminate", "required", "truncated", "animated", "invalid_entry", "supports_autocompletion", "selectable_text", "is_default",
  "visited", "checkable", "has_popup", "read_only",
] as const;

const INTERACTIVE_ROLES = new Set([
  "push button", "button", "toggle button", "check box", "radio button", "menu item", "check menu item",
  "radio menu item", "combo box", "entry", "text", "password text", "link", "slider", "spin button",
  "page tab", "list item", "tree item", "table cell", "grid cell", "switch", "scroll bar", "menu", "tab", "search box",
]);

/** Roles whose actions are a container's application actions, not a control's. */
const PASSIVE_ROLES = new Set(["generic", "label", "panel", "filler", "grouping", "section", "tool bar", "frame", "application"]);

const CHECKABLE_ROLES = new Set(["check box", "toggle button", "radio button", "check menu item", "radio menu item", "switch"]);
const DEFAULT_ACTIONS = ["click", "press", "activate", "toggle", "open", "jump"];

const CHROMIUM_HINT =
  "Chromium and Electron apps expose their tree only when relaunched with --force-renderer-accessibility=complete";

function unreachableBus(detail: string): DesktopError {
  return new DesktopError(
    "unavailable",
    `The accessibility bus is not reachable (${detail}). Start it with \`/usr/lib/at-spi-bus-launcher --launch-immediately &\`, `
    + "or restart it with `systemctl --user restart at-spi-dbus-bus.service`, then relaunch the app. "
    + `${CHROMIUM_HINT}.`,
  );
}

function stateNames(words: DBusValue): string[] {
  const list = Array.isArray(words) ? words.map((w) => Number(w)) : [];
  const names: string[] = [];
  for (const [i, word] of list.entries()) {
    for (let bit = 0; bit < 32; bit++) {
      if (word & (2 ** bit)) {
        const name = STATE_NAMES[i * 32 + bit];
        if (name && name !== "invalid") names.push(name);
      }
    }
  }
  return names;
}

function unwrap(value: DBusValue | undefined): DBusValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Variant).value : (value as DBusValue);
}

interface Target {
  readonly bus: string;
  readonly path: string;
}

interface Node extends Target {
  readonly depth: number;
  readonly element: Omit<AxElement, "ref">;
  readonly hasText: boolean;
  readonly children: Node[];
}

function flatten(roots: Node[]): Node[] {
  const out: Node[] = [];
  const visit = (node: Node) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

export function createAtspi(env: NodeJS.ProcessEnv = process.env): Atspi {
  let connecting: Promise<DBusConnection> | null = null;
  // A connection's PID per unique bus name; unique names are never reused, so
  // it holds for the life of the connection and is dropped with it.
  let pids = new Map<string, number>();
  const refs = new Map<string, Target>();
  const refByKey = new Map<string, string>();
  let nextRef = 1;
  let inFlight = 0;
  const waiting: Array<() => void> = [];

  async function openBus(): Promise<DBusConnection> {
    let address = env.AT_SPI_BUS_ADDRESS;
    if (!address) {
      let session: DBusConnection;
      try {
        session = await DBusConnection.connect(sessionBusAddress(env), { timeoutMs: CALL_TIMEOUT_MS });
      } catch (error) {
        throw unreachableBus(`no session bus: ${(error as Error).message}`);
      }
      try {
        const [value] = await session.call({ destination: "org.a11y.Bus", path: "/org/a11y/bus", interface: "org.a11y.Bus", member: "GetAddress" });
        address = String(value);
      } catch (error) {
        throw unreachableBus(`org.a11y.Bus did not answer: ${(error as Error).message}`);
      } finally {
        session.close();
      }
    }
    try {
      const conn = await DBusConnection.connect(address, { timeoutMs: CALL_TIMEOUT_MS });
      pids = new Map();
      return conn;
    } catch (error) {
      throw unreachableBus((error as Error).message);
    }
  }

  async function bus(): Promise<DBusConnection> {
    if (connecting) {
      const existing = await connecting.catch(() => null);
      if (existing && !existing.closed) return existing;
    }
    connecting = openBus();
    return connecting;
  }

  async function call(conn: DBusConnection, target: { bus: string; path: string }, iface: string, member: string, signature = "", body: DBusValue[] = []): Promise<DBusValue[]> {
    if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight++;
    try {
      return await conn.call({ destination: target.bus, path: target.path, interface: iface, member, ...(signature ? { signature, body } : {}) });
    } finally {
      inFlight--;
      waiting.shift()?.();
    }
  }

  async function actionNames(conn: DBusConnection, target: Target): Promise<string[]> {
    const [list] = await call(conn, target, ACTION, "GetActions");
    return (list as DBusValue[][]).map((entry) => String(entry[0]));
  }

  async function text(conn: DBusConnection, target: Target): Promise<string> {
    const [value] = await call(conn, target, TEXT, "GetText", "ii", [0, MAX_TEXT]);
    return String(value);
  }

  async function property(conn: DBusConnection, target: { bus: string; path: string }, iface: string, name: string): Promise<DBusValue> {
    const [value] = await call(conn, target, PROPERTIES, "Get", "ss", [iface, name]);
    return unwrap(value);
  }

  function mint(target: Target): string {
    const key = `${target.bus}\u0000${target.path}`;
    const existing = refByKey.get(key);
    if (existing) {
      refs.delete(existing);
      refs.set(existing, target);
      return existing;
    }
    const ref = `e${nextRef++}`;
    refs.set(ref, target);
    refByKey.set(key, ref);
    while (refs.size > MAX_REFS) {
      const [oldest, old] = refs.entries().next().value as [string, Target];
      refs.delete(oldest);
      refByKey.delete(`${old.bus}\u0000${old.path}`);
    }
    return ref;
  }

  function resolve(ref: string): Target {
    const target = refs.get(ref);
    if (!target) throw new DesktopError("not_found", `Unknown ref ${JSON.stringify(ref)}; run look with ui again.`, { ref });
    return target;
  }

  /**
   * Read one element at window origin `at`; `children` is its child list for
   * the walk. Text is read only when `withText`, since it can be a document.
   */
  async function read(conn: DBusConnection, target: Target, at: readonly [number, number], withText: boolean): Promise<{ element: Omit<AxElement, "ref">; hasText: boolean; children: Array<[string, string]> }> {
    // Extents need no interface check (a non-component just errors), so they ride the first round.
    const [[role], name, [state], [children], [interfaces], extents] = await Promise.all([
      call(conn, target, ACCESSIBLE, "GetRoleName"),
      property(conn, target, ACCESSIBLE, "Name").catch(() => ""),
      call(conn, target, ACCESSIBLE, "GetState"),
      call(conn, target, ACCESSIBLE, "GetChildren").catch(() => [[]] as DBusValue[]),
      call(conn, target, ACCESSIBLE, "GetInterfaces").catch(() => [[]] as DBusValue[]),
      call(conn, target, COMPONENT, "GetExtents", "u", [COORD_WINDOW]).then(([ext]) => ext as number[], () => undefined),
    ]);
    const has = new Set((interfaces as DBusValue[]).map(String));
    const roleName = String(role);
    const states = stateNames(state as DBusValue);
    const element: Omit<AxElement, "ref"> = { role: roleName, name: String(name ?? ""), states, actions: [] };
    if (extents) {
      const [x, y, width, height] = extents.map(Number) as [number, number, number, number];
      if (width > 0 || height > 0) element.box = [x + at[0], y + at[1], width, height];
    }
    const extras: Promise<unknown>[] = [];
    if (has.has(ACTION)) {
      extras.push(actionNames(conn, target).then((names) => {
        element.actions = names;
      }, () => undefined));
    }
    if (has.has(VALUE)) {
      extras.push(property(conn, target, VALUE, "CurrentValue").then((value) => {
        element.value = Number(value);
      }, () => undefined));
    }
    const hasText = has.has(TEXT) && roleName !== "password text";
    if (hasText && withText) {
      extras.push(text(conn, target).then((value) => {
        if (value && value !== element.name) element.text = value;
      }, () => undefined));
    }
    await Promise.all(extras);
    // GTK4 reports a toggle's on state as `pressed`, not `checked`.
    if (CHECKABLE_ROLES.has(roleName) || states.includes("checkable")) element.checked = states.includes("checked") || states.includes("pressed");
    return { element, hasText, children: (children as DBusValue[][]).map((c) => [String(c[0]), String(c[1])]) };
  }

  async function walk(conn: DBusConnection, roots: Target[], at: readonly [number, number], withText: boolean): Promise<Node[]> {
    let budget = MAX_NODES;
    const visit = async (target: Target, depth: number): Promise<Node | null> => {
      if (budget <= 0) return null;
      budget--;
      let read_: Awaited<ReturnType<typeof read>>;
      try {
        read_ = await read(conn, target, at, withText);
      } catch (error) {
        if (error instanceof DBusError && error.dbusName === "org.ghost.Disconnected") throw error;
        return null;
      }
      // A hidden element's subtree is not on screen; skip it.
      const expand = depth < MAX_DEPTH && !(depth > 0 && !read_.element.states.includes("showing"));
      const children = expand
        ? (await Promise.all(read_.children.map(([b, p]) => visit({ bus: b, path: p }, depth + 1)))).filter((n): n is Node => n !== null)
        : [];
      return { ...target, depth, element: read_.element, hasText: read_.hasText, children };
    };
    return (await Promise.all(roots.map((root) => visit(root, 0)))).filter((n): n is Node => n !== null);
  }

  async function pidOf(conn: DBusConnection, name: string): Promise<number> {
    const known = pids.get(name);
    if (known !== undefined) return known;
    try {
      const [value] = await call(conn, { bus: "org.freedesktop.DBus", path: "/org/freedesktop/DBus" }, "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", [name]);
      const pid = Number(value);
      pids.set(name, pid);
      return pid;
    } catch {
      return -1;
    }
  }

  /** The application's frames for this window, as walk roots. */
  async function windowRoots(conn: DBusConnection, window: AxWindow): Promise<Target[]> {
    let apps: DBusValue[][];
    try {
      [apps] = await call(conn, { bus: REGISTRY, path: ROOT_PATH }, ACCESSIBLE, "GetChildren") as [DBusValue[][]];
    } catch (error) {
      throw unreachableBus(`the registry did not answer: ${(error as Error).message}`);
    }
    const appPids = await Promise.all(apps.map(([name]) => pidOf(conn, String(name))));
    const app = apps[appPids.indexOf(window.pid)];
    if (!app) {
      throw new DesktopError(
        "unavailable",
        `No accessibility tree is registered for this window (pid ${window.pid}). ${CHROMIUM_HINT}; otherwise use look with image.`,
        { pid: window.pid },
      );
    }
    const appTarget = { bus: String(app[0]), path: String(app[1]) };
    const [frames] = await call(conn, appTarget, ACCESSIBLE, "GetChildren") as [DBusValue[][]];
    const targets = frames.map(([b, p]) => ({ bus: String(b), path: String(p) }));
    if (targets.length <= 1 || !window.title) return targets.length ? targets : [appTarget];
    const names = await Promise.all(targets.map((t) => property(conn, t, ACCESSIBLE, "Name").then(String, () => "")));
    const exact = targets.filter((_, i) => names[i] === window.title);
    if (exact.length) return exact;
    const title = window.title;
    const partial = targets.filter((_, i) => {
      const name = names[i];
      return !!name && (title.includes(name) || name.includes(title));
    });
    return partial.length ? partial : targets;
  }

  function matches(node: Node, query: AxQuery): boolean {
    const { element } = node;
    if (query.role) {
      const role = query.role.toLowerCase();
      if (!element.role.toLowerCase().includes(role)) return false;
    }
    if (query.text) {
      const needle = query.text.toLowerCase();
      const hay = [element.name, element.text ?? "", element.value === undefined ? "" : String(element.value)];
      if (!hay.some((h) => h.toLowerCase().includes(needle))) return false;
    }
    if (query.actionable) {
      const interactive = INTERACTIVE_ROLES.has(element.role)
        || element.states.includes("editable")
        || (element.actions.length > 0 && element.name !== "" && !PASSIVE_ROLES.has(element.role));
      if (!interactive) return false;
    }
    return true;
  }

  /** Run an op on a ref; `instead` is what to do when the element lacks the interface. */
  async function withTarget<T>(ref: string, instead: string, run: (conn: DBusConnection, target: Target) => Promise<T>): Promise<T> {
    const target = resolve(ref);
    const conn = await bus();
    try {
      return await run(conn, target);
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      if (error instanceof DBusError) {
        const detail = error.message || error.dbusName;
        const gone = /UnknownObject|ServiceUnknown/.test(error.dbusName) || /no such object|unknown object/i.test(error.message);
        if (gone) throw new DesktopError("not_found", `Element ${ref} is gone (${detail}); run look with ui again.`, { ref });
        if (/UnknownMethod|UnknownInterface|NotSupported/.test(error.dbusName)) {
          throw new DesktopError("invalid", `Element ${ref} does not support that (${detail}); ${instead}.`, { ref });
        }
      }
      throw new DesktopError("failed", `Accessibility call on ${ref} failed: ${(error as Error).message}.`, { ref });
    }
  }

  return {
    async query(window, query) {
      const conn = await bus();
      // Text is matched only when the query asks; otherwise it is read for the returned few.
      const nodes = flatten(await walk(conn, await windowRoots(conn, window), window.at, !!query.text));
      const roles: Record<string, number> = {};
      for (const node of nodes) roles[node.element.role] = (roles[node.element.role] ?? 0) + 1;
      const matched = nodes.filter((node) => node.depth > 0 || nodes.length === 1).filter((node) => matches(node, query));
      const shown = matched.slice(0, query.limit);
      if (!query.text) {
        await Promise.all(shown.filter((node) => node.hasText).map((node) => text(conn, node).then((value) => {
          if (value && value !== node.element.name) node.element.text = value;
        }, () => undefined)));
      }
      return { elements: shown.map((node) => ({ ref: mint(node), ...node.element })), total: matched.length, roles };
    },

    perform: (ref, action) => withTarget(ref, "click its coordinates instead", async (conn, target) => {
      const names = await actionNames(conn, target).catch(() => [] as string[]);
      if (!names.length) throw new DesktopError("invalid", `Element ${ref} has no actions; click its coordinates instead.`, { ref });
      let index: number;
      if (action) {
        index = names.findIndex((n) => n.toLowerCase() === action.toLowerCase());
        if (index < 0) throw new DesktopError("invalid", `Element ${ref} has no action ${JSON.stringify(action)}; it has ${names.join(", ")}.`, { ref, actions: names });
      } else {
        index = Math.max(0, names.findIndex((n) => DEFAULT_ACTIONS.includes(n.toLowerCase())));
      }
      const [ok] = await call(conn, target, ACTION, "DoAction", "i", [index]);
      if (ok === false) throw new DesktopError("failed", `Element ${ref} refused action ${names[index]}.`, { ref });
    }),

    setText: (ref, text) => withTarget(ref, "focus it and type instead", async (conn, target) => {
      const [ok] = await call(conn, target, EDITABLE_TEXT, "SetTextContents", "s", [text]);
      if (ok === false) throw new DesktopError("failed", `Element ${ref} refused the new text; it may be read-only.`, { ref });
    }),

    setValue: (ref, value) => withTarget(ref, "use keys or drag it instead", async (conn, target) => {
      await call(conn, target, PROPERTIES, "Set", "ssv", [VALUE, "CurrentValue", variant("d", value)]);
    }),

    focus: (ref) => withTarget(ref, "click it instead", async (conn, target) => {
      const [ok] = await call(conn, target, COMPONENT, "GrabFocus");
      if (ok === false) throw new DesktopError("failed", `Element ${ref} would not take focus.`, { ref });
    }),

    extents: (ref) => withTarget(ref, "click by x and y from an image instead", async (conn, target) => {
      const [[extents], pid] = await Promise.all([call(conn, target, COMPONENT, "GetExtents", "u", [COORD_WINDOW]), pidOf(conn, target.bus)]);
      const [x, y, width, height] = (extents as number[]).map(Number) as [number, number, number, number];
      return { pid, ...(width > 0 || height > 0 ? { box: [x, y, width, height] as [number, number, number, number] } : {}) };
    }),

    async close() {
      const pending = connecting;
      connecting = null;
      const conn = await pending?.catch(() => null);
      conn?.close();
    },
  };
}
