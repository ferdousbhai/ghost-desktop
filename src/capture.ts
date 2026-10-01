import { DesktopError } from "./errors.js";
import { logicalSize, windowShown, type HyprClient, type HyprMonitor } from "./hypr.js";
import { runChecked, type Runner } from "./run.js";

export interface Shot {
  readonly data: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg";
  /** Screen rectangle the image covers, in desktop coordinates. */
  readonly geometry: readonly [number, number, number, number];
  /** Image pixels per desktop unit; 1 means image pixel + geometry origin is the screen point. */
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** How the pixels were read, and whether that could show something other than the target. */
  readonly via: "window-buffer" | "screen-region" | "monitor";
  readonly warnings: readonly string[];
}

export interface CaptureOptions {
  readonly lossless?: boolean;
  /** Image pixels per desktop unit, 0.1–2; default 1 (logical size). */
  readonly scale?: number;
}

/** Reads width and height from a PNG or JPEG header. */
export function imageSize(data: Uint8Array): [number, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] === 0x89 && data[1] === 0x50) return [view.getUint32(16), view.getUint32(20)];
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) break;
    const marker = data[offset + 1] ?? 0;
    const length = view.getUint16(offset + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
    }
    offset += 2 + length;
  }
  throw new DesktopError("failed", "grim returned an image whose size could not be read.");
}

export function createCapture(run: Runner) {
  const grim = async (
    args: string[],
    options: CaptureOptions,
    geometry: Shot["geometry"],
    via: Shot["via"],
    warnings: string[] = [],
  ): Promise<Shot> => {
    const scale = options.scale ?? 1;
    if (!(scale >= 0.1 && scale <= 2)) throw new DesktopError("invalid", "scale must be between 0.1 and 2.");
    const format = options.lossless ? ["-t", "png"] : ["-t", "jpeg", "-q", "90"];
    const { bytes } = await runChecked(run, ["grim", "-s", String(scale), ...format, ...args, "-"], { timeoutMs: 8000, binary: true });
    if (!bytes?.length) throw new DesktopError("failed", "grim returned no image.");
    const [width, height] = imageSize(bytes);
    return { data: bytes, mimeType: options.lossless ? "image/png" : "image/jpeg", geometry, scale, width, height, via, warnings };
  };
  const rect = ([x, y, w, h]: Shot["geometry"]) => `${x},${y} ${w}x${h}`;

  return {
    /**
     * A window's own buffer through the foreign-toplevel protocol, which sees
     * covered and off-screen windows without disturbing anything. Only when
     * that fails and the window is on screen does it fall back to the screen
     * region, and says so; a hidden window it cannot read is refused, never
     * replaced by whatever happens to be in its rectangle.
     */
    async window(client: HyprClient, monitors: readonly HyprMonitor[], options: CaptureOptions = {}): Promise<Shot> {
      const geometry = [client.at[0], client.at[1], client.size[0], client.size[1]] as const;
      let bufferError = "this window has no foreign-toplevel identifier";
      const identifier = client.stableId ?? client.stable_id;
      if (identifier) {
        try {
          return await grim(["-T", identifier], options, geometry, "window-buffer");
        } catch (error) {
          bufferError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!windowShown(client, monitors)) {
        throw new DesktopError(
          "unavailable",
          `${client.class} is not on screen and its buffer could not be read (${bufferError}). `
          + "Bring it forward with desktop_act focus, then look again.",
        );
      }
      return grim(["-g", rect(geometry)], options, geometry, "screen-region", [
        `read from the screen (${bufferError}); a window covering it would show instead`,
      ]);
    },

    monitor(monitor: HyprMonitor, options: CaptureOptions = {}): Promise<Shot> {
      const geometry = [monitor.x, monitor.y, ...logicalSize(monitor)] as const;
      return grim(["-o", monitor.name], options, geometry, "monitor");
    },

    region(geometry: Shot["geometry"], options: CaptureOptions = {}): Promise<Shot> {
      if (!(geometry[2] > 0 && geometry[3] > 0)) throw new DesktopError("invalid", "A region needs a positive width and height.");
      return grim(["-g", rect(geometry)], options, geometry, "screen-region");
    },
  };
}

export type Capture = ReturnType<typeof createCapture>;

/** "x,y WxH" or "x,y,WxH" into numbers. */
export function parseRegion(region: string): [number, number, number, number] {
  const match = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*[ ,]\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(region);
  if (!match) throw new DesktopError("invalid", `region must look like "x,y WxH", not ${JSON.stringify(region)}.`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}
