# ghost-desktop

Computer use for [Omarchy](https://omarchy.org) and any Hyprland desktop, as a
stdio [MCP](https://modelcontextprotocol.io) server. Two tools let an agent see
the desktop and steer it: apps' controls through the accessibility tree,
screenshots, the pointer, and the keyboard.

It is the computer use of [Ghost](https://github.com/ferdousbhai/ghost), and
works on its own with Claude Code, Codex, or any MCP client.

## Install

Needs [Bun](https://bun.sh) 1.3.14 or newer, Hyprland 0.56 or newer, and
`grim`, `wtype`, `wl-clipboard`, and `at-spi2-core` (Omarchy ships all of
them).

```sh
bun install -g github:ferdousbhai/ghost-desktop
claude mcp add --scope user desktop -- ghost-desktop
```

Pin a release with `github:ferdousbhai/ghost-desktop#v0.1.6`. Bun puts
`ghost-desktop` in `~/.bun/bin`. TypeScript throughout, run by Bun directly;
it has no package dependencies: the MCP stdio transport is `src/mcp.ts`.

## Tools

Their full descriptions and schemas are in [`src/server.ts`](src/server.ts),
which is the single source; this page covers what the schemas cannot.

- **`desktop_look`** never changes the desktop. With no arguments it returns
  monitors, windows, overlay layers (launchers, notifications, on-screen
  keyboards), and the cursor. Name a window to add its accessibility tree
  (`ui`) or a screenshot (`image`), or screenshot a region or monitor.
- **`desktop_act`** runs ordered `steps` and stops at the first failure,
  returning what was done before it. `then` looks again in the same call.
  Launching apps and managing windows and workspaces are not steps: run them
  from a shell (`hyprctl dispatch`, `omarchy`), then `wait` for the window.

## Coordinates

Everything is in desktop (logical) coordinates, the ones Hyprland reports. A
screenshot at the default scale 1 has one image pixel per desktop unit, so an
image pixel plus the image's `geometry` origin is the screen point to click.
A control from `ui` carries its center as `at`.

## What it uses

| Need | How | Fails as |
| --- | --- | --- |
| Windows, focus, events | Hyprland's request and event sockets, dispatching in the session's grammar (Lua on 0.56+, legacy strings before); every value is a Lua string literal, never raw code | `unavailable` outside Hyprland |
| Screenshots | `grim -T` reads a window's own buffer, covered or on another workspace; a window on screen whose buffer cannot be read falls back to the screen region and says so; a hidden one is refused | `unavailable` |
| Controls | the AT-SPI bus, over ghost-desktop's own D-Bus client | `unavailable`, with how to start the bus or enable Chromium's tree |
| Pointer | Hyprland moves the cursor; a `zwlr_virtual_pointer_v1` device per step clicks, drags, and scrolls, then is destroyed | `unavailable` if the compositor lacks the protocol |
| Keys | `send_shortcut` to the named window, no focus change. Hyprland names keys from the last keyboard's keymap, which after a `type` is wtype's, so a refused chord falls back to focusing the window and `wtype` | |
| Text | `wtype` into the focused field, the text as an argument (from stdin wtype drops characters past ~100); layout-independent | |
| Clipboard (read) | `wl-paste` | `unavailable` if missing |

Every step reports what it disturbed: `focus` or `pointer`.

A key chord reaches the window, never Hyprland's own bindings: `super+shift+3`
sent to a terminal types `#`; what is bound in Hyprland is a `hyprctl
dispatch` or `omarchy` command.

## Safety

- **Locked session.** `desktop_act` does nothing when Hyprland or logind
  says the screen is locked, or when neither can say.
- **One driver at a time.** Every `desktop_act` claims a lease in
  `$XDG_RUNTIME_DIR/ghost-desktop/`, shared by all ghost-desktop processes of
  the user; another caller's `desktop_act` fails `busy` until the holder has
  been idle 15 s. `desktop_look` never claims it.
- **Untrusted content.** Window titles, on-screen text, and control names are
  data. A host should fence them as untrusted before its model reads them.

## Errors

A failed call is an MCP error result whose text starts with a code:
`unavailable`, `locked`, `busy`, `not_found`, `invalid`, or `failed`. The rest
of the text is written for the model and names the next move.

## For MCP hosts

A host that serves several conversations from one process can name who is
acting in each call's `_meta.caller`; that name keys the lease. Without it,
each ghost-desktop process is one caller, named after its client. A failed
call also carries `_meta.code` and `_meta.details`, for a program; the text is
for the model.

## Develop

```sh
bun install
bun run verify   # typecheck, lint, tests
```

Tests never touch the real desktop; try changes in a nested Hyprland with its
own runtime directory, D-Bus, and AT-SPI bus.

## Credits

The Wayland wire protocol and the Lua dispatch encoding are ported from
[hypruse](https://github.com/IlyasKhallouki/hypruse); the lock check, chord
table, and window capture approach from
[omarchy-quattro-harness](https://github.com/fabiopauli/omarchy-quattro-harness).
Both MIT; see [NOTICE.md](NOTICE.md). Apache-2.0.
