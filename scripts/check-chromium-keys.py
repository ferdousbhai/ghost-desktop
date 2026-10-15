#!/usr/bin/env python3
"""Real keyboard delivery in nested Hyprland; never uses the owner's apps or buses."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

source = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix="gk.", dir="/tmp"))
env = os.environ.copy()
parent = env["WAYLAND_DISPLAY"]
if not parent.startswith("/"):
    parent = env["XDG_RUNTIME_DIR"] + "/" + parent
for key, sub in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"),
                 ("XDG_STATE_HOME", "state"), ("XDG_DATA_HOME", "data"),
                 ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "run")]:
    (root / sub).mkdir(mode=0o700)
    env[key] = str(root / sub)
for key in ["HYPRLAND_INSTANCE_SIGNATURE", "HYPRLAND_CMD", "DISPLAY"]:
    env.pop(key, None)
env["HYPRLAND_NO_SD_VARS"] = "1"
children = []


def spawn(args, **kwargs):
    child = subprocess.Popen(args, env=env, **kwargs)
    children.append(child)
    return child


def clients():
    return json.loads(subprocess.check_output(
        ["hyprctl", "-j", "clients"], env=env, timeout=2))


def wait_for(check):
    for _ in range(100):
        try:
            value = check()
            if value:
                return value
        except (subprocess.SubprocessError, OSError, ValueError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Nested desktop not ready; inspect " + str(root))


try:
    config = root / "dbus.conf"
    config.write_text('<busconfig><type>session</type><listen>unix:tmpdir=' + str(root)
                      + '</listen><policy context="default"><allow send_destination="*" '
                      'eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/>'
                      '</policy></busconfig>')
    for key in ["DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS"]:
        child = spawn(["dbus-daemon", "--nofork", "--config-file=" + str(config),
                       "--print-address=1"], stdout=subprocess.PIPE, text=True)
        env[key] = child.stdout.readline().strip()
    config = root / "hyprland.lua"
    config.write_text('hl.monitor({output="",mode="800x600@60",position="0x0",scale=1})\n'
                      'hl.config({animations={enabled=false},misc={disable_hyprland_logo=true,'
                      'disable_splash_rendering=true}})\n')
    # Only the compositor inherits the parent's socket; all test clients use its private one.
    with (root / "hyprland.log").open("w") as log:
        child = subprocess.Popen(["Hyprland", "--config", str(config)],
                                 env=dict(env, WAYLAND_DISPLAY=parent),
                                 stdout=log, stderr=log, start_new_session=True)
        children.append(child)
    socket = wait_for(lambda: next((root / "run/hypr").glob("*/.socket.sock"), None))
    env["HYPRLAND_INSTANCE_SIGNATURE"] = socket.parent.name
    env["WAYLAND_DISPLAY"] = wait_for(lambda: next(
        (p.name for p in (root / "run").glob("wayland-*") if p.is_socket()), None))
    wait_for(lambda: subprocess.check_output(["hyprctl", "-j", "monitors"], env=env, timeout=2))
    profile = root / "chromium"
    with (root / "chromium.log").open("w") as log:
        spawn(["chromium", "--ozone-platform=wayland", "--disable-gpu", "--no-first-run",
               "--no-default-browser-check", "--password-store=basic", "--remote-debugging-port=0",
               "--user-data-dir=" + str(profile), "data:text/html,<input id=test autofocus value=original>"],
              stdout=log, stderr=log)
    window = wait_for(lambda: next((c for c in clients() if "chrom" in c["class"].lower()), None))
    portfile = profile / "DevToolsActivePort"
    wait_for(portfile.exists)
    port = portfile.read_text().splitlines()[0]
    with urllib.request.urlopen("http://127.0.0.1:" + port + "/json/list") as response:
        target = next(t for t in json.load(response) if t["type"] == "page")
    # Cover Chromium and give the other window focus before each chord.
    spawn(["foot", "--app-id=ghost-key-other", "sleep", "60"],
          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    other = wait_for(lambda: next((c for c in clients() if c["class"] == "ghost-key-other"), None))
    env.update(PROBE_WINDOW=window["address"], PROBE_OTHER=other["address"],
               PROBE_WS=target["webSocketDebuggerUrl"], PROBE_SOURCE=str(source))
    probe = root / "probe.ts"
    probe.write_text('''
const root = process.env.PROBE_SOURCE!;
const {createHypr} = await import(`${root}/src/hypr.ts`);
const {createDesktop} = await import(`${root}/src/desktop.ts`);
const {DesktopLease, leaseDir} = await import(`${root}/src/lease.ts`);
const {runCommand} = await import(`${root}/src/run.ts`);
const hypr = createHypr({env:process.env, logind:async()=>false});
const desktop = createDesktop({hypr, lease:new DesktopLease(leaseDir(process.env)), run:runCommand});
const ws = new WebSocket(process.env.PROBE_WS!);
await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=reject;});
let id = 0;
async function evaluate(expression:string) {
  const n = ++id;
  const reply = new Promise<any>(resolve=>{
    const listener = (event:MessageEvent)=>{const r=JSON.parse(event.data);if(r.id===n){ws.removeEventListener("message",listener);resolve(r);}};
    ws.addEventListener("message",listener);
  });
  ws.send(JSON.stringify({id:n,method:"Runtime.evaluate",params:{expression,returnByValue:true}}));
  const result = await reply;
  if(result.error || result.result.exceptionDetails) throw new Error(JSON.stringify(result));
  return result.result.result.value;
}
async function act(steps:any[]) {
  const result = await desktop.act({steps:steps.map(step=>({...step,window:process.env.PROBE_WINDOW}))},"nested-key-check");
  if(result.failed) throw result.failed.error;
  return result;
}
try {
  for (const text of ["first", "second"]) {
    await hypr.dispatch({kind:"focus",address:process.env.PROBE_OTHER!});
    const result = await act([{do:"key",keys:"ctrl+a"},{do:"type",text}]);
    await Bun.sleep(150);
    if(await evaluate('document.querySelector("#test").value')!==text) throw new Error("Covered chord did not replace input");
    if(!result.steps[0].disturbed.includes("focus")) throw new Error("Covered chord did not report focus");
  }
  await hypr.dispatch({kind:"focus",address:process.env.PROBE_OTHER!});
  await act([{do:"key",keys:"ctrl+l"},{do:"type",text:"about:version"},{do:"key",keys:"Return"}]);
  for(let attempt=0;attempt<50;attempt++) {
    if(await evaluate("location.href")==="chrome://version/") {console.log("PASS: covered Chromium receives chords, text and Return; focus is reported");process.exitCode=0;break;}
    await Bun.sleep(100);
    if(attempt===49) throw new Error("Navigation was acknowledged but not delivered");
  }
} finally {ws.close();await desktop.close();}
''')
    subprocess.run(["/usr/bin/bun", str(probe)], env=env, check=True, timeout=20)
finally:
    # Only stop children captured at spawn, never processes found by name.
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    print("Evidence:", root)
