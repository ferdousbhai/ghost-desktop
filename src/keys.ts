import { DesktopError } from "./errors.js";

const MODIFIERS: Record<string, "SHIFT" | "CTRL" | "ALT" | "SUPER"> = {
  shift: "SHIFT",
  ctrl: "CTRL",
  control: "CTRL",
  alt: "ALT",
  super: "SUPER",
  meta: "SUPER",
  win: "SUPER",
  mod: "SUPER",
  cmd: "SUPER",
};

const KEYSYMS: Record<string, string> = {
  esc: "Escape", escape: "Escape", enter: "Return", return: "Return", tab: "Tab", space: "space",
  backspace: "BackSpace", delete: "Delete", del: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "Prior", pgup: "Prior", pagedown: "Next", pgdn: "Next",
  up: "Up", down: "Down", left: "Left", right: "Right",
  "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", "\\": "backslash",
  ";": "semicolon", "'": "apostrophe", "`": "grave", "[": "bracketleft", "]": "bracketright", "+": "plus",
  print: "Print", menu: "Menu",
};

export interface Chord {
  /** Hyprland modifier names, e.g. ["CTRL", "SHIFT"]. */
  readonly mods: readonly ("SHIFT" | "CTRL" | "ALT" | "SUPER")[];
  /** An XKB keysym name, e.g. "t", "Return", "F5". */
  readonly keysym: string;
}

/** "ctrl+shift+t" → CTRL SHIFT + t. A trailing "+" is the plus key ("ctrl++"). */
export function parseChord(chord: string): Chord {
  const text = chord.trim();
  if (!text) throw new DesktopError("invalid", "keys must name a key, such as ctrl+s or Return.");
  const parts = text.split(/\s*\+\s*/).filter((part) => part !== "");
  if (text.endsWith("+") && parts.at(-1) !== "+") parts.push("+");
  const base = parts.pop() ?? text;
  const mods: Chord["mods"][number][] = [];
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) throw new DesktopError("invalid", `Unknown modifier ${JSON.stringify(part)} in ${JSON.stringify(chord)}; use ctrl, shift, alt, or super.`);
    if (!mods.includes(mod)) mods.push(mod);
  }
  const lower = base.toLowerCase();
  const keysym = KEYSYMS[lower]
    ?? (/^f([1-9]|1\d|2[0-4])$/.test(lower) ? lower.toUpperCase() : undefined)
    ?? (base.length === 1 ? lower : base);
  return { mods, keysym };
}
