import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const device = "emulator-5610";
const imeOnly = process.argv.includes("--ime-only");
const adb = (...args) => execFileSync("adb", ["-s", device, ...args], { encoding: "utf8", timeout: 30000 });
const output = path.resolve(".cache/android-build/native-verification");
if (adb("shell", "dumpsys", "input_method").includes("mInputShown=true")) adb("shell", "input", "keyevent", "4");
const processId = adb("shell", "pidof", "app.vivic.remote").trim();
adb("forward", "tcp:9338", `localabstract:webview_devtools_remote_${processId}`);
const target = (await (await fetch("http://127.0.0.1:9338/json/list")).json())[0];
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => { const message = JSON.parse(event.data); const job = pending.get(message.id); if (job) { pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(message.error) : job.resolve(message.result); } });
const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(new Error("CDP timeout")), 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const result = await call("Runtime.evaluate", { expression, returnByValue: true }); if (result.exceptionDetails) throw new Error("Layout evaluation failed"); return result.result.value; };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const screenshot = name => fs.writeFileSync(path.join(output, name), execFileSync("adb", ["-s", device, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
const initialFontScale = adb("shell", "settings", "get", "system", "font_scale").trim();
const initialHardwareIme = adb("shell", "settings", "get", "secure", "show_ime_with_hard_keyboard").trim();
assert.match(initialFontScale, /^\d+(\.\d+)?$/);
try {
  for (let i = 0; i < 40; i++) { if (await evaluate("!!document.querySelector('#mobile-pair-code')")) break; await pause(200); }
  await evaluate("document.activeElement?.blur(); window.scrollTo(0,0)");
  for (let i = 0; i < 10; i++) { if (!adb("shell", "dumpsys", "input_method").includes("mInputShown=true")) break; await pause(300); }
  await pause(800);
  const initialHeight = await evaluate("visualViewport.height");
  assert.ok(initialHeight > 700, "Baseline requires the keyboard to be fully hidden");
  if (!imeOnly) {
    adb("shell", "settings", "put", "system", "font_scale", "1.3");
    await pause(500);
    const scaled = await evaluate(`(() => ({width:innerWidth,scrollWidth:document.documentElement.scrollWidth, inputHeight:document.querySelector('#mobile-pair-code').getBoundingClientRect().height}))()`);
    assert.ok(scaled.scrollWidth <= scaled.width);
    screenshot("system-font-130.png");
    adb("shell", "settings", "put", "system", "font_scale", initialFontScale);
  }
  // The test AVD declares a hardware keyboard; explicitly show its software IME.
  adb("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1");
  await pause(400);
  await evaluate("document.querySelector('#mobile-pair-code').scrollIntoView({block:'center'})");
  await pause(300);
  let field;
  for (let i = 0; i < 4; i++) {
    const captured = adb("shell", "uiautomator", "dump", `/sdcard/vivic-ime-${i}.xml`);
    if (captured.includes("dumped to")) field = adb("shell", "cat", `/sdcard/vivic-ime-${i}.xml`).match(/<node[^>]*class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (field) break; await pause(200);
  }
  assert.ok(field, "Native accessibility bounds must identify the pairing input");
  adb("shell", "input", "tap", String(Math.round((+field[1] + +field[3]) / 2)), String(Math.round((+field[2] + +field[4]) / 2)));
  let keyboardHeight = initialHeight;
  for (let i = 0; i < 100; i++) { await pause(200); keyboardHeight = await evaluate("visualViewport.height"); if (keyboardHeight < initialHeight - 100) break; }
  assert.ok(keyboardHeight < initialHeight - 100, "Actual Android IME must resize the WebView");
  const visible = await evaluate(`(() => { const r=document.querySelector('#mobile-pair-code').getBoundingClientRect(); return {bottom:r.bottom,height:visualViewport.height}; })()`);
  assert.ok(visible.bottom <= visible.height + 2, "Focused pairing field remains above the keyboard");
  screenshot("native-ime.png");
  adb("shell", "input", "keyevent", "4");
  fs.writeFileSync(path.join(output, "layout-result.json"), JSON.stringify({ device, systemFontScale: imeOnly ? null : 1.3, noOverflow: imeOnly ? null : true, initialHeight, keyboardHeight, focusedFieldVisible: true }, null, 2));
  console.log(JSON.stringify({ passed: imeOnly ? 1 : 2, systemFontScale: imeOnly ? null : 1.3, initialHeight, keyboardHeight }));
} finally {
  adb("shell", "settings", "put", "system", "font_scale", initialFontScale);
  if (initialHardwareIme === "null") adb("shell", "settings", "delete", "secure", "show_ime_with_hard_keyboard");
  else adb("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", initialHardwareIme);
  socket.close();
}
