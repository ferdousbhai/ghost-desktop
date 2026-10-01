import { connect } from "node:net";
import { join } from "node:path";
import type { Atspi, AxElement, AxWindow } from "./atspi.js";
import { parseRegion, type Capture, type Shot } from "./capture.js";
import { DesktopError } from "./errors.js";
import { resolveWindow, windowShown, type Hypr, type HyprClient } from "./hypr.js";
import { parseChord } from "./keys.js";
import type { DesktopLease } from "./lease.js";
import { runChecked, type Runner } from "./run.js";
import type { MouseButton, VirtualPointer } from "./wayland.js";

export const MAX_WINDOWS = 60;
export const MAX_TEXT = 160;
export const MAX_ELEMENTS = 200;
export const DEFAULT_ELEMENTS = 40;
export const MAX_FRAMES = 12;
export const MAX_STEPS = 30;

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
  event?: "open" | "close" | "title" | "workspace";
  match?: string;
  timeout_ms?: number;
  title?: string;
}

export interface ActArgs {
  steps: ActStep[];
  then?: "none" | "desktop" | "ui" | "image";
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

export interface DesktopDeps {
  readonly hypr: Hypr;
  readonly capture: Capture;
  readonly atspi: () => Atspi;
  readonly pointer: () => Promise<VirtualPointer>;
  readonly lease: DesktopLease;
  readonly run: Runner;
  readonly env: NodeJS.ProcessEnv;
  readonly sleep?: (ms: number) => Promise<void>;
}

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
  const box = element.x !== undefined && element.width !== undefined && element.y !== undefined && element.height !== undefined
    ? { at: [element.x + Math.round(element.width / 2), element.y + Math.round(element.height / 2)], size: [element.width, element.height] }
    : {};
  return {
    ref: element.ref,
    role: element.role,
    ...(element.name ? { name: clip(element.name) } : {}),
    ...box,
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
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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

  const axWindow = (client: HyprClient): AxWindow => ({ pid: client.pid, at: client.at, address: client.address, title: client.title });

  const window = async (query?: string) => {
    const [clients, active] = await Promise.all([hypr.clients(), hypr.activeAddress()]);
    return resolveWindow(clients, active, query);
  };

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
        size: [Math.round(monitor.width / monitor.scale), Math.round(monitor.height / monitor.scale)],
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

  async function shot(args: LookArgs, client: HyprClient | undefined): Promise<Shot> {
    const options = { ...(args.lossless ? { lossless: true } : {}), ...(args.scale !== undefined ? { scale: args.scale } : {}) };
    if (args.region) return capture.region(parseRegion(args.region), options);
    const monitors = await hypr.monitors();
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
    const wantsWindow = args.window !== undefined || args.ui === true;
    const client = wantsWindow ? await window(args.window) : undefined;
    if (!wantsWindow && !args.image && !args.clipboard) Object.assign(facts, await desktopFacts(caller));
    if (client) facts.window = windowFacts(client, await hypr.activeAddress());
    if (client && args.ui) {
      const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? DEFAULT_ELEMENTS)), MAX_ELEMENTS);
      const result = await ax().query(axWindow(client), {
        limit,
        actionable: !args.find && !args.role,
        ...(args.find ? { text: args.find } : {}),
        ...(args.role ? { role: args.role } : {}),
      });
      facts.ui = result.elements.map(elementFacts);
      if (result.total > result.elements.length) facts.uiOmitted = result.total - result.elements.length;
      if (result.elements.length === 0 && args.role && !result.roles[args.role]) facts.rolesPresent = result.roles;
    }
    if (args.image || args.region || args.monitor) {
      const frames = Math.min(Math.max(1, Math.trunc(args.frames ?? 1)), MAX_FRAMES);
      const interval = Math.min(Math.max(100, Math.trunc(args.interval_ms ?? 500)), 5000);
      for (let index = 0; index < frames; index += 1) {
        if (index) await sleep(interval);
        images.push(await shot(args, client));
      }
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

  async function elementFor(step: ActStep): Promise<{ element: AxElement; client: HyprClient | undefined }> {
    if (step.ref) return { element: await ax().element(step.ref), client: step.window ? await window(step.window) : undefined };
    if (!step.name) throw new DesktopError("invalid", `${step.do} needs ref or name (a control from look with ui), or x and y.`);
    const client = await window(step.window);
    const { elements } = await ax().query(axWindow(client), { text: step.name, limit: 20 });
    const folded = step.name.toLowerCase();
    const exact = elements.filter((element) => element.name.toLowerCase() === folded);
    const candidates = exact.length ? exact : elements;
    const [only] = candidates;
    if (only && candidates.length === 1) return { element: only, client };
    if (candidates.length === 0) throw new DesktopError("not_found", `No control named ${JSON.stringify(step.name)} in ${client.class}; look with ui to see what it offers, or use an image.`);
    throw new DesktopError(
      "invalid",
      `${candidates.length} controls match ${JSON.stringify(step.name)}; pass one ref: `
      + candidates.slice(0, 8).map((element) => `${element.ref} ${element.role} "${clip(element.name, 40)}"`).join(", "),
    );
  }

  const center = (element: AxElement): [number, number] => {
    if (element.x === undefined || element.y === undefined || element.width === undefined || element.height === undefined) {
      throw new DesktopError("unavailable", `${element.ref} reports no position; use perform, or click by x and y from an image.`);
    }
    return [element.x + element.width / 2, element.y + element.height / 2];
  };

  async function pointAt(step: ActStep): Promise<{ point: [number, number]; disturbed: string[] }> {
    if (step.x !== undefined && step.y !== undefined) return { point: [step.x, step.y], disturbed: [] };
    const { element, client } = await elementFor(step);
    const disturbed: string[] = [];
    // A pointer click lands on whatever is on top, so the window has to be.
    const { x, y } = element;
    const target = client ?? (x === undefined || y === undefined ? undefined : (await hypr.clients()).find((candidate) =>
      x >= candidate.at[0] && x < candidate.at[0] + candidate.size[0]
      && y >= candidate.at[1] && y < candidate.at[1] + candidate.size[1]));
    if (target && target.address !== await hypr.activeAddress()) {
      await hypr.dispatch({ kind: "focus", address: target.address });
      disturbed.push("focus");
      await sleep(60);
    }
    return { point: center(element), disturbed };
  }

  async function moveCursor(x: number, y: number): Promise<void> {
    await hypr.dispatch({ kind: "cursor", x, y });
  }

  async function focusIfNeeded(query: string | undefined, disturbed: string[]): Promise<HyprClient | undefined> {
    if (query === undefined) return undefined;
    const client = await window(query);
    if (client.address !== await hypr.activeAddress()) {
      await hypr.dispatch({ kind: "focus", address: client.address });
      disturbed.push("focus");
      await sleep(60);
    }
    return client;
  }

  async function waitFor(event: NonNullable<ActStep["event"]>, match: string | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
    const signature = deps.env.HYPRLAND_INSTANCE_SIGNATURE;
    const runtime = deps.env.XDG_RUNTIME_DIR;
    if (!signature || !runtime) throw new DesktopError("unavailable", "wait needs a Hyprland session (HYPRLAND_INSTANCE_SIGNATURE).");
    const wanted = { open: ["openwindow"], close: ["closewindow"], title: ["windowtitlev2", "windowtitle"], workspace: ["workspacev2", "workspace"] }[event];
    const folded = match?.toLowerCase();
    return new Promise((resolve, reject) => {
      const socket = connect(join(runtime, "hypr", signature, ".socket2.sock"));
      let buffer = "";
      const finish = (value: Record<string, unknown> | Error) => {
        clearTimeout(timer);
        socket.destroy();
        value instanceof Error ? reject(value) : resolve(value);
      };
      const timer = setTimeout(() => finish({ timedOut: true, event }), timeoutMs);
      socket.on("error", (error) => finish(new DesktopError("unavailable", `Hyprland's event socket is unreachable: ${error.message}`)));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const [name, data = ""] = line.split(">>", 2);
          if (!name || !wanted.includes(name)) continue;
          if (folded && !data.toLowerCase().includes(folded)) continue;
          finish({ event, data: clip(data) });
          return;
        }
      });
    });
  }

  async function step(step: ActStep): Promise<StepReport> {
    const disturbed: string[] = [];
    const report = (did: string, extra: Partial<StepReport> = {}): StepReport => ({ do: step.do, did, disturbed, ...extra });
    switch (step.do) {
      case "click": {
        const { point, disturbed: moved } = await pointAt(step);
        disturbed.push(...moved, "pointer");
        await moveCursor(point[0], point[1]);
        await sleep(20);
        const clicks = Math.min(Math.max(1, Math.trunc(step.clicks ?? 1)), 3);
        await withPointer((pointer) => pointer.click(step.button ?? "left", clicks));
        return report(`clicked ${step.button ?? "left"}${clicks > 1 ? ` x${clicks}` : ""} at ${Math.round(point[0])},${Math.round(point[1])}`);
      }
      case "perform": {
        const { element } = await elementFor(step);
        await ax().perform(element.ref, step.action);
        return report(`${step.action ?? "default action"} on ${element.ref} ${element.role} "${clip(element.name, 40)}"`);
      }
      case "set": {
        const { element } = await elementFor(step);
        if (step.value === undefined) {
          await ax().focus(element.ref);
          return report(`focused ${element.ref}`);
        }
        if (typeof step.value === "number") await ax().setValue(element.ref, step.value);
        else await ax().setText(element.ref, step.value);
        return report(`set ${element.ref} to ${JSON.stringify(clip(String(step.value), 40))}`);
      }
      case "type": {
        if (step.text === undefined) throw new DesktopError("invalid", "type needs text.");
        if (step.ref || step.name) {
          const { element } = await elementFor(step);
          await ax().focus(element.ref);
        }
        await focusIfNeeded(step.window, disturbed);
        // As an argument: wtype reading stdin drops characters first seen past ~100 in.
        await runChecked(run, ["wtype", "--", step.text], { timeoutMs: 15_000 });
        return report(`typed ${step.text.length} characters into the focused field`);
      }
      case "key": {
        if (!step.keys) throw new DesktopError("invalid", "key needs keys, such as ctrl+s or Return.");
        const chord = parseChord(step.keys);
        const client = await window(step.window);
        try {
          // Delivered to the window itself: no focus change, works on a covered window.
          await hypr.dispatch({ kind: "shortcut", mods: chord.mods.join(" "), key: chord.keysym, address: client.address });
          return report(`sent ${step.keys} to ${client.class}`);
        } catch {
          await focusIfNeeded(client.address, disturbed);
          const mods = chord.mods.map((mod) => ({ SHIFT: "shift", CTRL: "ctrl", ALT: "alt", SUPER: "logo" })[mod]);
          await runChecked(run, ["wtype", ...mods.flatMap((mod) => ["-M", mod]), "-k", chord.keysym, ...mods.flatMap((mod) => ["-m", mod])]);
          return report(`pressed ${step.keys} in the focused ${client.class}`);
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
        return report(`dragged from ${step.x},${step.y} to ${step.to_x},${step.to_y}`);
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
        const client = await window(step.window);
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
        const client = await window(step.window);
        await hypr.dispatch({ kind: "move", address: client.address, workspace: step.workspace });
        return report(`moved ${client.class} to workspace ${step.workspace}`);
      }
      case "close":
      case "fullscreen":
      case "float": {
        const client = await window(step.window);
        await hypr.dispatch({ kind: step.do, address: client.address });
        return report(`${step.do === "close" ? "closed" : `toggled ${step.do} on`} ${client.class}`);
      }
      case "launch": {
        if (!step.command) throw new DesktopError("invalid", "launch needs command.");
        const before = new Set((await hypr.clients()).map((client) => client.address));
        const rule = step.workspace ? `[workspace ${step.workspace} silent] ` : "";
        await hypr.dispatch({ kind: "exec", command: `${rule}${step.command}` });
        const deadline = Date.now() + Math.min(step.timeout_ms ?? 8000, 30_000);
        while (Date.now() < deadline) {
          await sleep(150);
          const opened = (await hypr.clients()).find((client) => !before.has(client.address) && client.mapped);
          if (opened) return report(`launched ${step.command}`, { window: windowFacts(opened, await hypr.activeAddress()) });
        }
        return report(`launched ${step.command}; no new window appeared yet`, { warnings: ["no window within the timeout; it may still be starting, or it reused an existing window"] });
      }
      case "wait": {
        const event = step.event ?? "open";
        const result = await waitFor(event, step.match, Math.min(Math.max(100, step.timeout_ms ?? 10_000), 60_000));
        return report(result.timedOut ? `no ${event} event within the timeout` : `saw ${event}`, { event: result });
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
    lease.claim(caller);
    const reports: StepReport[] = [];
    let lastWindow: string | undefined;
    for (const [index, item] of steps.entries()) {
      try {
        reports.push(await step(item));
        lastWindow = item.window ?? lastWindow;
        lease.claim(caller);
      } catch (error) {
        const failure = error instanceof DesktopError ? error : new DesktopError("failed", error instanceof Error ? error.message : String(error));
        return { steps: reports, failed: { index, error: failure } };
      }
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
    /** For callers that want to know, before acting, whether a window can be seen. */
    shown: async (query?: string) => windowShown(await window(query), await hypr.monitors()),
  };
}

export type Desktop = ReturnType<typeof createDesktop>;
