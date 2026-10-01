import { describe, expect, it } from "vitest";
import { parseChord } from "../src/keys.js";

describe("parseChord", () => {
  it("names modifiers and keysyms the way Hyprland and wtype take them", () => {
    expect(parseChord("ctrl+shift+T")).toEqual({ mods: ["CTRL", "SHIFT"], keysym: "t" });
    expect(parseChord("Return")).toEqual({ mods: [], keysym: "Return" });
    expect(parseChord("esc")).toEqual({ mods: [], keysym: "Escape" });
    expect(parseChord("super+f12")).toEqual({ mods: ["SUPER"], keysym: "F12" });
    expect(parseChord("ctrl++")).toEqual({ mods: ["CTRL"], keysym: "plus" });
    expect(parseChord("XF86AudioMute")).toEqual({ mods: [], keysym: "XF86AudioMute" });
  });

  it("refuses an unknown modifier rather than sending a wrong key", () => {
    expect(() => parseChord("hyper+a")).toThrow(/Unknown modifier/);
    expect(() => parseChord(" ")).toThrow(/must name a key/);
  });
});
