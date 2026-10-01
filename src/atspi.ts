/**
 * AT-SPI over the hand-rolled D-Bus client: read one window's accessibility
 * tree, mint refs for its elements, and act on them by ref. Coordinates are
 * screen coordinates: AT-SPI's window-relative extents plus the window's
 * Hyprland position, because Wayland clients cannot report screen positions.
 */
import { DBusConnection, DBusError, sessionBusAddress, variant, type DBusValue } from "./dbus.js";
import { DesktopError } from "./errors.js";

export interface AxWindow {
  readonly pid: number;
  readonly at: readonly [number, number];
  readonly address: string;
  /** The window title; picks the right frame when one process owns several windows. */
  readonly title?: string;
}

export interface AxElement {
  ref: string;
  role: string;
  name: string;
  states: string[];
  actions: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  value?: number;
  text?: string;
  checked?: boolean;
}

export interface AxQuery {
  role?: string;
  text?: string;
  states?: string[];
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
  element(ref: string): Promise<AxElement>;
  at(window: AxWindow, x: number, y: number): Promise<AxElement | null>;
  focusedEditable(window: AxWindow): Promise<AxElement | null>;
  close(): Promise<void>;
}

export interface AtspiOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Skip the children of elements that are not `showing` (default true). */
  readonly showingOnly?: boolean;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly callTimeoutMs?: number;
}

const ACCESSIBLE = "org.a11y.atspi.Accessible";
const COMPONENT = "org.a11y.atspi.Component";
const ACTION = "org.a11y.atspi.Action";
const VALUE = "org.a11y.atspi.Value";
const TEXT = "org.a11y.atspi.Text";
const EDITABLE_TEXT = "org.a11y.atspi.EditableText";
const REGISTRY = "org.a11y.atspi.Registry";
const ROOT_PATH = "/org/a11y/atspi/accessible/root";
const COORD_WINDOW = 1;
const MAX_TEXT = 500;
const MAX_REFS = 5000;

/** AT-SPI's StateType enum, in bit order. */
const STATES = [
  "invalid", "active", "armed", "busy", "checked", "collapsed", "defunct", "editable",
  "enabled", "expandable", "expanded", "focusable", "focused", "has_tooltip", "horizontal", "iconified",
  "modal", "multi_line", "multiselectable", "opaque", "pressed", "resizable", "selectable", "selected",
  "sensitive", "showing", "single_line", "stale", "transient", "vertical", "visible", "manages_descendants",
  "indeterminate", "required", "truncated", "animated", "invalid_entry", "supports_autocompletion", "selectable_text", "is_default",
  "visited", "checkable", "has_popup", "read_only",
];

const INTERACTIVE_ROLES = new Set([
  "push button", "button", "toggle button", "check box", "radio button", "menu item", "check menu item",
  "radio menu item", "combo box", "entry", "text", "password text", "link", "slider", "spin button",
  "page tab", "list item", "tree item", "table cell", "grid cell", "switch", "scroll bar", "menu", "tab", "search box",
]);

/** Roles whose actions are a container's application actions, not a control's. */
const PASSIVE_ROLES = new Set(["generic", "label", "panel", "filler", "grouping", "section", "tool bar", "frame", "application"]);

const CHECKABLE_ROLES = new Set(["check box", "toggle button", "radio button", "check menu item", "radio menu item", "switch"]);
const DEFAULT_ACTIONS = ["click", "press", "activate", "toggle", "open", "jump"];

export const CHROMIUM_HINT =
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
  list.forEach((word, i) => {
    for (let bit = 0; bit < 32; bit++) {
      if (word & (2 ** bit)) {
        const name = STATES[i * 32 + bit];
        if (name && name !== "invalid") names.push(name);
      }
    }
  });
  return names;
}

interface Target {
  readonly bus: string;
  readonly path: string;
  readonly at: readonly [number, number];
}

interface Node extends Target {
  readonly depth: number;
  readonly element: Omit<AxElement, "ref">;
  readonly children: Node[];
}

function contains(element: Omit<AxElement, "ref">, x: number, y: number): boolean {
  const { x: ex, y: ey, width, height } = element;
  if (ex === undefined || ey === undefined || width === undefined || height === undefined) return false;
  if (width <= 0 || height <= 0) return false;
  return x >= ex && y >= ey && x < ex + width && y < ey + height;
}

function flatten(roots: Node[]): Node[] {
  const out: Node[] = [];
  const visit = (node: Node) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  roots.forEach(visit);
  return out;
}

export function createAtspi(options: AtspiOptions = {}): Atspi {
  const env = options.env ?? process.env;
  const showingOnly = options.showingOnly ?? true;
  const maxNodes = options.maxNodes ?? 4000;
  const maxDepth = options.maxDepth ?? 60;
  const timeoutMs = options.callTimeoutMs ?? 2000;

  let connecting: Promise<DBusConnection> | null = null;
  const refs = new Map<string, Target>();
  const refByKey = new Map<string, string>();
  let nextRef = 1;

  async function openBus(): Promise<DBusConnection> {
    let address = env.AT_SPI_BUS_ADDRESS;
    if (!address) {
      let session: DBusConnection;
      try {
        session = await DBusConnection.connect(sessionBusAddress(env), { timeoutMs });
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
      return await DBusConnection.connect(address, { timeoutMs });
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

  function call(conn: DBusConnection, target: { bus: string; path: string }, iface: string, member: string, signature = "", body: DBusValue[] = []) {
    return conn.call({ destination: target.bus, path: target.path, interface: iface, member, ...(signature ? { signature, body } : {}), timeoutMs });
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

  /** Read one element; `children` is its child list for the walk. */
  async function read(conn: DBusConnection, target: Target): Promise<{ element: Omit<AxElement, "ref">; children: Array<[string, string]> }> {
    const [[role], name, [state], [children], [interfaces]] = await Promise.all([
      call(conn, target, ACCESSIBLE, "GetRoleName"),
      conn.getProperty(target.bus, target.path, ACCESSIBLE, "Name").catch(() => ""),
      call(conn, target, ACCESSIBLE, "GetState"),
      call(conn, target, ACCESSIBLE, "GetChildren").catch(() => [[]] as DBusValue[]),
      call(conn, target, ACCESSIBLE, "GetInterfaces").catch(() => [[]] as DBusValue[]),
    ]);
    const has = new Set((interfaces as DBusValue[]).map(String));
    const roleName = String(role);
    const states = stateNames(state as DBusValue);
    const element: Omit<AxElement, "ref"> = { role: roleName, name: String(name ?? ""), states, actions: [] };
    const extras: Promise<unknown>[] = [];
    if (has.has(COMPONENT)) {
      extras.push(call(conn, target, COMPONENT, "GetExtents", "u", [COORD_WINDOW]).then(([ext]) => {
        const [x, y, width, height] = (ext as number[]).map(Number) as [number, number, number, number];
        if (width > 0 || height > 0) Object.assign(element, { x: x + target.at[0], y: y + target.at[1], width, height });
      }, () => undefined));
    }
    if (has.has(ACTION)) {
      extras.push(call(conn, target, ACTION, "GetActions").then(([list]) => {
        element.actions = (list as DBusValue[][]).map((entry) => String(entry[0]));
      }, () => undefined));
    }
    if (has.has(VALUE)) {
      extras.push(conn.getProperty(target.bus, target.path, VALUE, "CurrentValue").then((value) => {
        element.value = Number(value);
      }, () => undefined));
    }
    if (has.has(TEXT) && roleName !== "password text") {
      extras.push(call(conn, target, TEXT, "GetText", "ii", [0, -1]).then(([text]) => {
        const value = String(text);
        if (value && value !== element.name) element.text = value.slice(0, MAX_TEXT);
      }, () => undefined));
    }
    await Promise.all(extras);
    // GTK4 reports a toggle's on state as `pressed`, not `checked`.
    if (CHECKABLE_ROLES.has(roleName) || states.includes("checkable")) element.checked = states.includes("checked") || states.includes("pressed");
    return { element, children: (children as DBusValue[][]).map((c) => [String(c[0]), String(c[1])]) };
  }

  async function walk(conn: DBusConnection, roots: Target[]): Promise<Node[]> {
    let budget = maxNodes;
    const visit = async (target: Target, depth: number): Promise<Node | null> => {
      if (budget <= 0) return null;
      budget--;
      let read_: Awaited<ReturnType<typeof read>>;
      try {
        read_ = await read(conn, target);
      } catch (error) {
        if (error instanceof DBusError && error.dbusName === "org.ghost.Disconnected") throw error;
        return null;
      }
      const expand = depth < maxDepth && !(showingOnly && depth > 0 && !read_.element.states.includes("showing"));
      const children = expand
        ? (await Promise.all(read_.children.map(([b, p]) => visit({ bus: b, path: p, at: target.at }, depth + 1)))).filter((n): n is Node => n !== null)
        : [];
      return { ...target, depth, element: read_.element, children };
    };
    return (await Promise.all(roots.map((root) => visit(root, 0)))).filter((n): n is Node => n !== null);
  }

  /** The application's frames for this window, as walk roots. */
  async function windowRoots(conn: DBusConnection, window: AxWindow): Promise<Target[]> {
    let apps: DBusValue[][];
    try {
      [apps] = await call(conn, { bus: REGISTRY, path: ROOT_PATH }, ACCESSIBLE, "GetChildren") as [DBusValue[][]];
    } catch (error) {
      throw unreachableBus(`the registry did not answer: ${(error as Error).message}`);
    }
    const pids = await Promise.all(apps.map(async ([name]) => {
      try {
        const [pid] = await conn.call({
          destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus",
          member: "GetConnectionUnixProcessID", signature: "s", body: [String(name)], timeoutMs,
        });
        return Number(pid);
      } catch {
        return -1;
      }
    }));
    const index = pids.indexOf(window.pid);
    const app = apps[index];
    if (!app) {
      throw new DesktopError(
        "unavailable",
        `No accessibility tree is registered for this window (pid ${window.pid}). ${CHROMIUM_HINT}; otherwise use look with image.`,
        { pid: window.pid },
      );
    }
    const appTarget = { bus: String(app[0]), path: String(app[1]), at: window.at };
    const [frames] = await call(conn, appTarget, ACCESSIBLE, "GetChildren") as [DBusValue[][]];
    const targets = frames.map(([b, p]) => ({ bus: String(b), path: String(p), at: window.at }));
    if (targets.length <= 1 || !window.title) return targets.length ? targets : [appTarget];
    const names = await Promise.all(targets.map((t) => conn.getProperty(t.bus, t.path, ACCESSIBLE, "Name").then(String, () => "")));
    const exact = targets.filter((_, i) => names[i] === window.title);
    if (exact.length) return exact;
    const title = window.title;
    const partial = targets.filter((_, i) => {
      const name = names[i];
      return !!name && (title.includes(name) || name.includes(title));
    });
    return partial.length ? partial : targets;
  }

  async function tree(window: AxWindow): Promise<Node[]> {
    const conn = await bus();
    return flatten(await walk(conn, await windowRoots(conn, window)));
  }

  function toElement(node: Node): AxElement {
    return { ref: mint(node), ...node.element };
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
    if (query.states?.length && !query.states.every((s) => element.states.includes(s.toLowerCase()))) return false;
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
      const nodes = await tree(window);
      const roles: Record<string, number> = {};
      for (const node of nodes) roles[node.element.role] = (roles[node.element.role] ?? 0) + 1;
      const matched = nodes.filter((node) => node.depth > 0 || nodes.length === 1).filter((node) => matches(node, query));
      return { elements: matched.slice(0, query.limit).map(toElement), total: matched.length, roles };
    },

    perform: (ref, action) => withTarget(ref, "click its coordinates instead", async (conn, target) => {
      const [list] = await call(conn, target, ACTION, "GetActions").catch(() => [[]] as DBusValue[]);
      const names = (list as DBusValue[][]).map((entry) => String(entry[0]));
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
      await conn.setProperty(target.bus, target.path, VALUE, "CurrentValue", variant("d", value));
    }),

    focus: (ref) => withTarget(ref, "click it instead", async (conn, target) => {
      const [ok] = await call(conn, target, COMPONENT, "GrabFocus");
      if (ok === false) throw new DesktopError("failed", `Element ${ref} would not take focus.`, { ref });
    }),

    element: (ref) => withTarget(ref, "run look with ui again", async (conn, target) => {
      const { element } = await read(conn, target);
      return { ref, ...element };
    }),

    async at(window, x, y) {
      let best: Node | null = null;
      for (const node of await tree(window)) {
        if (!contains(node.element, x, y)) continue;
        const area = (node.element.width ?? 0) * (node.element.height ?? 0);
        const bestArea = best ? (best.element.width ?? 0) * (best.element.height ?? 0) : Infinity;
        if (!best || area < bestArea || (area === bestArea && node.depth > best.depth)) best = node;
      }
      return best ? toElement(best) : null;
    },

    async focusedEditable(window) {
      const node = (await tree(window)).find((n) =>
        n.element.states.includes("focused")
        && (n.element.states.includes("editable") || n.element.role === "password text"));
      return node ? toElement(node) : null;
    },

    async close() {
      const pending = connecting;
      connecting = null;
      const conn = await pending?.catch(() => null);
      conn?.close();
    },
  };
}
