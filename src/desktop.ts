import { centerOf, type Atspi, type AxElement } from "./atspi.js";
import { parseRegion, type Capture, type Shot } from "./capture.js";
import { DesktopError } from "./errors.js";
import { logicalSize, resolveWindow, type Hypr, type HyprClient, type HyprMonitor } from "./hypr.js";
import { parseChord, WTYPE_MODS } from "./keys.js";
import type { DesktopLease } from "./lease.js";
import { runChecked, type Runner } from "./run.js";
import type { MouseButton, VirtualPointer } from "./wayland.js";

/** Bounds the schema advertises and the steps enforce: [min, max, default]. */
export const BOUNDS = {
  elements: [1, 200, 40],
  frames: [1, 12, 1],
  interval_ms: [100, 5000, 500],
  clicks: [1, 3, 1],
  wait_ms: [100, 60_000, 10_000],
  launch_ms: [100, 60_000, 8000],
} as const;
export const MAX_STEPS = 30;
const MAX_WINDOWS = 60;
const MAX_TEXT = 160;

const clampInt = (value: number | undefined, [min, max, fallback]: readonly [number, number, number]) =>
  Math.min(Math.max(min, Math.trunc(value ?? fallback)), max);

export interface LookArgs {
  window?: string;
  ui?: boolean;
  find?: string;
  role?: string;
  limit?: number;
  image?: boolean;
  region?: string;
  monitor?: string;
  scale?: number;
  lossless?: boolean;
  frames?: number;
  interval_ms?: number;
  clipboard?: boolean;
}

export const ACT_VERBS = [
  "click", "type", "key", "set", "perform", "drag", "scroll", "move",
  "focus", "workspace", "send", "close", "fullscreen", "float", "launch", "wait", "notify", "copy",
] as const;
export type ActVerb = (typeof ACT_VERBS)[number];

export interface ActStep {
  do: ActVerb;
  window?: string;
  ref?: string;
  name?: string;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  button?: MouseButton;
  clicks?: number;
  text?: string;
  keys?: string;
  value?: string | number;
  action?: string;
  dy?: number;
  dx?: number;
  workspace?: string;
  command?: string;
  event?: keyof typeof EVENTS;
  match?: string;
  timeout_ms?: number;
  title?: string;
}

export interface ActArgs {
  steps: ActStep[];
  then?: (typeof THEN_LOOKS)[number];
}

export interface Observation {
  /** JSON-ready facts; every string in it came from the desktop and is data. */
  readonly facts: Record<string, unknown>;
  readonly images: readonly Shot[];
}

export interface StepReport {
  do: ActVerb;
  did: string;
  disturbed: string[];
  warnings?: string[];
  window?: Record<string, unknown>;
  event?: Record<string, unknown>;
}

/** A control found for a step: its ref, its window, and its screen box if it has one. */
interface Located {
  ref: string;
  client: HyprClient;
  active: string | null;
  box?: [number, number, number, number] | undefined;
}

export interface DesktopDeps {
  readonly hypr: Hypr;
  readonly capture: Capture;
  readonly atspi: () => Atspi;
  readonly pointer: () => Promise<VirtualPointer>;
  readonly lease: DesktopLease;
  readonly run: Runner;
  readonly sleep?: (ms: number) => Promise<void>;
}

const EVENTS = { open: ["openwindow"], close: ["closewindow"], title: ["windowtitlev2", "windowtitle"], workspace: ["workspacev2", "workspace"] } as const;
export const WAIT_EVENTS = Object.keys(EVENTS) as Array<keyof typeof EVENTS>;
export const THEN_LOOKS = ["none", "desktop", "ui", "image"] as const;

const clip = (text: string | undefined, max = MAX_TEXT) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? "");

function windowFacts(client: HyprClient, active: string | null): Record<string, unknown> {
  return {
    address: client.address,
    class: clip(client.class),
    title: clip(client.title),
    workspace: client.workspace.name,
    at: client.at,
    size: client.size,
    ...(client.address === active ? { focused: true } : {}),
    ...(client.floating ? { floating: true } : {}),
    ...(client.fullscreen ? { fullscreen: true } : {}),
    ...(client.hidden || !client.mapped ? { hidden: true } : {}),
  };
}

function elementFacts(element: AxElement): Record<string, unknown> {
  const at = centerOf(element);
  return {
    ref: element.ref,
    role: element.role,
    ...(element.name ? { name: clip(element.name) } : {}),
    ...(at && element.box ? { at, size: [element.box[2], element.box[3]] } : {}),
    ...(element.value !== undefined ? { value: element.value } : {}),
    ...(element.text ? { text: clip(element.text, 400) } : {}),
    ...(element.checked !== undefined ? { checked: element.checked } : {}),
    ...(element.actions.length ? { actions: element.actions } : {}),
    ...(element.states.includes("focused") ? { focused: true } : {}),
    ...(element.states.includes("sensitive") || element.actions.length === 0 ? {} : { disabled: true }),
  };
}

export function createDesktop(deps: DesktopDeps) {
  const { hypr, capture, lease, run } = deps;
  const sleep = deps.sleep ?? Bun.sleep;
  let atspi: Atspi | undefined;
  const ax = () => (atspi ??= deps.atspi());
  // A pointer device per step, closed after it: nothing lingers in the
  // compositor's device list, and no idle connection goes stale.
  const withPointer = async <T>(body: (pointer: VirtualPointer) => Promise<T>): Promise<T> => {
    const pointer = await deps.pointer();
    try {
      return await body(pointer);
    } finally {
      await pointer.close().catch(() => {});
    }
  };

  const window = async (query?: string) => {
    const [clients, active] = await Promise.all([hypr.clients(), hypr.activeAddress()]);
    return { client: resolveWindow(clients, active, query), active };
  };

  /** Focus a window unless it already has focus; a pointer or a keystroke lands on whatever does. */
  async function focus(client: HyprClient, active: string | null, disturbed: string[]): Promise<void> {
    if (client.address === active) return;
    await hypr.dispatch({ kind: "focus", address: client.address });
    disturbed.push("focus");
    await sleep(60);
  }

  async function desktopFacts(caller: string): Promise<Record<string, unknown>> {
    const [clients, active, monitors, layers, cursor] = await Promise.all([
      hypr.clients(), hypr.activeAddress(), hypr.monitors(), hypr.layers(), hypr.cursor(),
    ]);
    const shown = clients.filter((client) => client.mapped);
    const held = lease.peek();
    return {
      monitors: monitors.map((monitor) => ({
        name: monitor.name,
        workspace: monitor.activeWorkspace.name,
        at: [monitor.x, monitor.y],
        size: logicalSize(monitor),
        ...(monitor.scale !== 1 ? { scale: monitor.scale } : {}),
        ...(monitor.focused ? { focused: true } : {}),
      })),
      windows: shown.slice(0, MAX_WINDOWS).map((client) => windowFacts(client, active)),
      ...(shown.length > MAX_WINDOWS ? { windowsOmitted: shown.length - MAX_WINDOWS } : {}),
      // Launchers, notifications, and on-screen keyboards are layers, not windows.
      layers: layers
        .filter((layer) => layer.level >= 2 && layer.w > 1 && layer.h > 1)
        .map((layer) => ({ namespace: clip(layer.namespace), monitor: layer.monitor, at: [layer.x, layer.y], size: [layer.w, layer.h] })),
      cursor,
      ...(held && held.holder !== caller ? { heldBy: held.holder } : {}),
    };
  }

  function shot(args: LookArgs, client: HyprClient | undefined, monitors: readonly HyprMonitor[]): Promise<Shot> {
    const options = { ...(args.lossless ? { lossless: true } : {}), ...(args.scale !== undefined ? { scale: args.scale } : {}) };
    if (args.region) return capture.region(parseRegion(args.region), options);
    if (client) return capture.window(client, monitors, options);
    const monitor = args.monitor
      ? monitors.find((candidate) => candidate.name === args.monitor)
      : monitors.find((candidate) => candidate.focused) ?? monitors[0];
    if (!monitor) throw new DesktopError("not_found", `No monitor is named ${JSON.stringify(args.monitor)}.`);
    return capture.monitor(monitor, options);
  }

  async function look(args: LookArgs, caller: string): Promise<Observation> {
    const facts: Record<string, unknown> = {};
    const images: Shot[] = [];
    const wantsImage = !!(args.image || args.region || args.monitor);
    const [target, monitors] = await Promise.all([
      args.window !== undefined || args.ui === true ? window(args.window) : undefined,
      wantsImage && !args.region ? hypr.monitors() : [],
    ]);
    const client = target?.client;
    if (target) facts.window = windowFacts(target.client, target.active);
    else if (!args.image && !args.clipboard) Object.assign(facts, await desktopFacts(caller));
    const frames = clampInt(args.frames, BOUNDS.frames);
    const interval = clampInt(args.interval_ms, BOUNDS.interval_ms);
    const takeShots = async () => {
      for (let index = 0; index < frames; index += 1) {
        if (index) await sleep(interval);
        images.push(await shot(args, client, monitors));
      }
    };
    const [result] = await Promise.all([
      client && args.ui
        ? ax().query(client, {
          limit: clampInt(args.limit, BOUNDS.elements),
          actionable: !args.find && !args.role,
          ...(args.find ? { text: args.find } : {}),
          ...(args.role ? { role: args.role } : {}),
        })
        : undefined,
      wantsImage ? takeShots() : undefined,
    ]);
    if (result) {
      facts.ui = result.elements.map(elementFacts);
      if (result.total > result.elements.length) facts.uiOmitted = result.total - result.elements.length;
      if (result.elements.length === 0 && args.role && !result.roles[args.role]) facts.rolesPresent = result.roles;
    }
    if (wantsImage) {
      const [first] = images;
      if (!first) throw new DesktopError("failed", "No screenshot was taken.");
      facts.image = {
        geometry: first.geometry,
        size: [first.width, first.height],
        ...(first.scale !== 1 ? { scale: first.scale } : {}),
        via: first.via,
        ...(frames > 1 ? { frames, interval_ms: interval } : {}),
        ...(first.warnings.length ? { warnings: first.warnings } : {}),
      };
    }
    if (args.clipboard) {
      const result = await run(["wl-paste", "--no-newline", "--type", "text"], { timeoutMs: 3000 });
      facts.clipboard = result.code === 0 ? clip(result.stdout, 4000) : null;
    }
    return { facts, images };
  }

  /** The one control a step's name picks in its window; an ambiguous name lists refs instead. */
  /** The one control a step's name picks in its window; an ambiguous name lists refs instead. */
  async function named(step: ActStep): Promise<Located & { element: AxElement }> {
    if (!step.name) throw new DesktopError("invalid", `${step.do} needs ref or name (a control from look with ui), or x and y.`);
    const { client, active } = await window(step.window);
    const { elements } = await ax().query(client, { name: step.name, limit: 20 });
    const folded = step.name.toLowerCase();
    const exact = elements.filter((element) => element.name.toLowerCase() === folded);
    const candidates = exact.length ? exact : elements;
    const [only] = candidates;
    if (only && candidates.length === 1) return { element: only, ref: only.ref, client, active, box: only.box };
    if (candidates.length === 0) throw new DesktopError("not_found", `No control named ${JSON.stringify(step.name)} in ${client.class}; look with ui to see what it offers, or use an image.`);
    throw new DesktopError(
      "invalid",
      `${candidates.length} controls match ${JSON.stringify(step.name)}; pass one ref: `
      + candidates.slice(0, 8).map((element) => `${element.ref} ${element.role} "${clip(element.name, 40)}"`).join(", "),
    );
  }

  /**
   * A step's control by ref or name, with the window that owns it and its
   * screen box now: a ref's extents are read fresh against the window's
   * current position, not where it was when the ref was minted.
   */
  async function locate(step: ActStep): Promise<Located> {
    if (!step.ref) return named(step);
    const [{ box, pid }, clients, active] = await Promise.all([ax().extents(step.ref), hypr.clients(), hypr.activeAddress()]);
    const owners = clients.filter((client) => client.pid === pid);
    const client = step.window ? resolveWindow(clients, active, step.window) : owners.find((owner) => owner.address === active) ?? owners[0];
    if (!client) throw new DesktopError("not_found", `${step.ref} belongs to no open window; look with ui again.`);
    return { ref: step.ref, client, active, box: box && [box[0] + client.at[0], box[1] + client.at[1], box[2], box[3]] };
  }

  const refOf = async (step: ActStep) => step.ref ?? (await named(step)).ref;

  const moveCursor = (x: number, y: number) => hypr.dispatch({ kind: "cursor", x, y });

  async function step(step: ActStep): Promise<StepReport> {
    const disturbed: string[] = [];
    const report = (did: string, extra: Partial<StepReport> = {}): StepReport => ({ do: step.do, did, disturbed, ...extra });
    switch (step.do) {
      case "click": {
        let x = step.x;
        let y = step.y;
        if (x === undefined || y === undefined) {
          const found = await locate(step);
          const point = centerOf(found);
          if (!point) throw new DesktopError("unavailable", `${found.ref} reports no position; use perform, or click by x and y from an image.`);
          [x, y] = point;
          // A pointer click lands on whatever is on top, so the window has to be.
          await focus(found.client, found.active, disturbed);
        }
        disturbed.push("pointer");
        await moveCursor(x, y);
        await sleep(20);
        const clicks = clampInt(step.clicks, BOUNDS.clicks);
        await withPointer((pointer) => pointer.click(step.button ?? "left", clicks));
        return report(`clicked ${step.button ?? "left"}${clicks > 1 ? ` x${clicks}` : ""} at ${Math.round(x)},${Math.round(y)}`);
      }
      case "perform": {
        const ref = await refOf(step);
        await ax().perform(ref, step.action);
        return report(`${step.action ?? "default action"} on ${ref}`);
      }
      case "set": {
        const ref = await refOf(step);
        if (step.value === undefined) {
          await ax().focus(ref);
          return report(`focused ${ref}`);
        }
        if (typeof step.value === "number") await ax().setValue(ref, step.value);
        else await ax().setText(ref, step.value);
        return report(`set ${ref} to ${JSON.stringify(clip(String(step.value), 40))}`);
      }
      case "type": {
        if (step.text === undefined) throw new DesktopError("invalid", "type needs text.");
        // The window first, then the field inside it: keystrokes go to the focused window.
        if (step.ref || step.name) {
          const found = await locate(step);
          await focus(found.client, found.active, disturbed);
          await ax().focus(found.ref);
        } else if (step.window !== undefined) {
          const { client, active } = await window(step.window);
          await focus(client, active, disturbed);
        }
        // As an argument: wtype reading stdin drops characters first seen past ~100 in.
        await runChecked(run, ["wtype", "--", step.text], { timeoutMs: 15_000 });
        return report(`typed ${step.text.length} characters into the focused field`);
      }
      case "key": {
        if (!step.keys) throw new DesktopError("invalid", "key needs keys, such as ctrl+s or Return.");
        const chord = parseChord(step.keys);
        const { client, active } = await window(step.window);
        try {
          // Delivered to the window itself: no focus change, works on a covered window.
          await hypr.dispatch({ kind: "shortcut", mods: chord.mods.join(" "), key: chord.keysym, address: client.address });
          return report(`sent ${step.keys} to ${client.class}`);
        } catch (error) {
          // Hyprland names keys from the last keyboard's keymap; after a type that is wtype's,
          // so it may not know this key. Any other refusal is the step's failure.
          if (!(error instanceof DesktopError && /key not found|keysym/i.test(String(error.details.refused ?? "")))) throw error;
          await focus(client, active, disturbed);
          const mods = chord.mods.map((mod) => WTYPE_MODS[mod]);
          await runChecked(run, ["wtype", ...mods.flatMap((mod) => ["-M", mod]), "-k", chord.keysym, ...mods.flatMap((mod) => ["-m", mod])]);
          return report(`pressed ${step.keys} in the focused ${client.class}`, { warnings: [error.message] });
        }
      }
      case "drag": {
        const { x, y, to_x: toX, to_y: toY } = step;
        if (x === undefined || y === undefined || toX === undefined || toY === undefined) {
          throw new DesktopError("invalid", "drag needs x, y (press) and to_x, to_y (release).");
        }
        disturbed.push("pointer");
        const button = step.button ?? "left";
        await moveCursor(x, y);
        await sleep(30);
        await withPointer(async (pointer) => {
          await pointer.button(button, true);
          try {
            // Intermediate motion: drop targets and canvases need the path, not just the ends.
            for (let index = 1; index <= 12; index += 1) {
              await moveCursor(x + ((toX - x) * index) / 12, y + ((toY - y) * index) / 12);
              await sleep(15);
            }
          } finally {
            await pointer.button(button, false);
          }
        });
        return report(`dragged from ${x},${y} to ${toX},${toY}`);
      }
      case "scroll": {
        if (!step.dy && !step.dx) throw new DesktopError("invalid", "scroll needs dy (positive scrolls down) or dx.");
        if (step.x !== undefined && step.y !== undefined) {
          disturbed.push("pointer");
          await moveCursor(step.x, step.y);
          await sleep(20);
        }
        await withPointer((pointer) => pointer.scroll(step.dy ?? 0, step.dx ?? 0));
        return report(`scrolled ${step.dy ?? 0} down, ${step.dx ?? 0} right`);
      }
      case "move": {
        if (step.x === undefined || step.y === undefined) throw new DesktopError("invalid", "move needs x and y.");
        disturbed.push("pointer");
        await moveCursor(step.x, step.y);
        return report(`pointer at ${step.x},${step.y}`);
      }
      case "focus": {
        const { client } = await window(step.window);
        await hypr.dispatch({ kind: "focus", address: client.address });
        disturbed.push("focus");
        return report(`focused ${client.class}`, { window: windowFacts(client, client.address) });
      }
      case "workspace": {
        if (!step.workspace) throw new DesktopError("invalid", "workspace needs workspace, such as 3 or name:web.");
        await hypr.dispatch({ kind: "workspace", workspace: step.workspace });
        disturbed.push("workspace");
        return report(`on workspace ${step.workspace}`);
      }
      case "send": {
        if (!step.workspace) throw new DesktopError("invalid", "send needs workspace.");
        const { client } = await window(step.window);
        await hypr.dispatch({ kind: "move", address: client.address, workspace: step.workspace });
        return report(`moved ${client.class} to workspace ${step.workspace}`);
      }
      case "close":
      case "fullscreen":
      case "float": {
        const { client } = await window(step.window);
        await hypr.dispatch({ kind: step.do, address: client.address });
        return report(`${step.do === "close" ? "closed" : `toggled ${step.do} on`} ${client.class}`);
      }
      case "launch": {
        const { command } = step;
        if (!command) throw new DesktopError("invalid", "launch needs command.");
        const rule = step.workspace ? `[workspace ${step.workspace} silent] ` : "";
        const opened = await hypr.waitEvent(EVENTS.open, {
          timeoutMs: clampInt(step.timeout_ms, BOUNDS.launch_ms),
          after: () => hypr.dispatch({ kind: "exec", command: `${rule}${command}` }),
        });
        if (!opened) return report(`launched ${command}; no window appeared`, { warnings: ["no window within the timeout; it may still be starting, or it reused an existing window"] });
        const { client, active } = await window(`0x${opened.data.split(",", 1)[0]}`);
        return report(`launched ${command}`, { window: windowFacts(client, active) });
      }
      case "wait": {
        const event = step.event ?? "open";
        const seen = await hypr.waitEvent(EVENTS[event], {
          timeoutMs: clampInt(step.timeout_ms, BOUNDS.wait_ms),
          ...(step.match ? { match: step.match } : {}),
        });
        return seen ? report(`saw ${event}`, { event: { event, data: clip(seen.data) } }) : report(`no ${event} event within the timeout`);
      }
      case "notify": {
        if (!step.text) throw new DesktopError("invalid", "notify needs text.");
        await runChecked(run, ["notify-send", "--app-name=ghost-desktop", "--", step.title || "ghost-desktop", step.text]);
        return report("notification shown");
      }
      case "copy": {
        if (step.text === undefined) throw new DesktopError("invalid", "copy needs text.");
        await runChecked(run, ["wl-copy", "--", step.text], { timeoutMs: 3000, detached: true });
        return report(`copied ${step.text.length} characters to the clipboard`);
      }
    }
  }

  async function act(args: ActArgs, caller: string): Promise<{ steps: StepReport[]; failed?: { index: number; error: DesktopError }; then?: Observation }> {
    const steps = args.steps ?? [];
    if (!Array.isArray(steps) || steps.length === 0) throw new DesktopError("invalid", "steps needs at least one step.");
    if (steps.length > MAX_STEPS) throw new DesktopError("invalid", `At most ${MAX_STEPS} steps per call.`);
    const locked = await hypr.locked();
    if (locked !== false) {
      throw new DesktopError("locked", locked
        ? "The screen is locked; nothing was done. Wait for the owner to unlock it."
        : "Neither Hyprland nor logind could say whether the screen is locked, so nothing was done.");
    }
    await lease.claim(caller);
    const reports: StepReport[] = [];
    let lastWindow: string | undefined;
    try {
      for (const [index, item] of steps.entries()) {
        try {
          reports.push(await step(item));
          lastWindow = item.window ?? lastWindow;
        } catch (error) {
          return { steps: reports, failed: { index, error: DesktopError.from(error) } };
        }
      }
    } finally {
      // The idle clock starts when the input ends, not when it began.
      await lease.claim(caller);
    }
    if (!args.then || args.then === "none") return { steps: reports };
    await sleep(150);
    const then = args.then === "desktop"
      ? await look({}, caller)
      : await look({ window: lastWindow ?? "active", ...(args.then === "ui" ? { ui: true } : { image: true }) }, caller);
    return { steps: reports, then };
  }

  return {
    look,
    act,
    async close() {
      await atspi?.close().catch(() => {});
    },
  };
}

export type Desktop = ReturnType<typeof createDesktop>;
