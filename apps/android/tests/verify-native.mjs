import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Dedicated synthetic-camera AVD only. No desktop browser and no physical camera/microphone.
const device = "emulator-5610";
const output = path.resolve(process.env.VIVIC_ANDROID_EVIDENCE_DIR ?? ".cache/android-build/native-verification");
fs.mkdirSync(output, { recursive: true });
const adb = (...args) => execFileSync("adb", ["-s", device, ...args], { encoding: "utf8", timeout: 30000 });
assert.equal(adb("shell", "getprop", "ro.kernel.qemu").trim(), "1");
assert.match(adb("emu", "avd", "name"), /vivic_online_20261023/);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
adb("shell", "am", "force-stop", "app.vivic.remote");
adb("shell", "pm", "revoke", "app.vivic.remote", "android.permission.CAMERA");
adb("shell", "pm", "clear-permission-flags", "app.vivic.remote", "android.permission.CAMERA", "user-set", "user-fixed");
adb("shell", "am", "start", "-n", "app.vivic.remote/.MainActivity");
await pause(1000);
const processId = adb("shell", "pidof", "app.vivic.remote").trim();
adb("forward", "tcp:9338", `localabstract:webview_devtools_remote_${processId}`);
let targets;
for (let count = 0; count < 30; count++) { try { targets = await (await fetch("http://127.0.0.1:9338/json/list")).json(); if (targets.length) break; } catch {} await pause(200); }
const [{ webSocketDebuggerUrl }] = targets;
const socket = new WebSocket(webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.id) { const job = pending.get(message.id); if (job) { pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(message.error) : job.resolve(message.result); } } });
const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native debugger timed out")); }, 10000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
const waitFor = async expression => { for (let count = 0; count < 40; count++) { if (await evaluate(expression)) return; await pause(200); } throw new Error(`Condition timed out: ${expression}`); };
const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(text)})?.click()`);
const screenshot = name => { const png = execFileSync("adb", ["-s", device, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }); assert.equal(png.subarray(1, 4).toString(), "PNG"); fs.writeFileSync(path.join(output, `${name}.png`), png); };
const checks = [];
try {
  await waitFor("!!document.querySelector('.mobile-scan-button')");
  const geometry = await evaluate(`(() => { const b=document.querySelector('.mobile-scan-button'); const s=getComputedStyle(b); return { origin:location.origin, width:innerWidth, scroll:document.documentElement.scrollWidth, display:s.display, align:s.alignItems, justify:s.justifyContent, height:b.getBoundingClientRect().height, bridge:typeof VivicAndroid.scan }; })()`);
  assert.equal(geometry.origin, "https://appassets.androidplatform.net"); assert.equal(geometry.bridge, "function"); assert.equal(geometry.display, "inline-flex"); assert.ok(geometry.scroll <= geometry.width); assert.ok(geometry.height >= 48);
  checks.push({ check: "packaged UI / native bridge / 48px touch / no horizontal overflow", geometry });
  screenshot("pair-native");
  await click("扫描电脑二维码"); await pause(1300);
  adb("shell", "uiautomator", "dump", "/sdcard/vivic-permission.xml");
  const permissionXml = adb("shell", "cat", "/sdcard/vivic-permission.xml");
  const deny = permissionXml.match(/<node[^>]*resource-id="[^"]*permission_deny_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert.ok(deny, "native permission dialog must offer deny");
  adb("shell", "input", "tap", String(Math.round((+deny[1] + +deny[3]) / 2)), String(Math.round((+deny[2] + +deny[4]) / 2)));
  await waitFor("document.querySelector('dialog')?.textContent.includes('相机权限未开启')");
  screenshot("camera-denied"); checks.push({ check: "native camera denial returns manual pairing", passed: true });
  await click("返回输入配对码");
  await waitFor("!document.querySelector('dialog')");
  adb("shell", "pm", "grant", "app.vivic.remote", "android.permission.CAMERA");
  await click("扫描电脑二维码"); await pause(1600);
  const activity = adb("shell", "dumpsys", "activity", "activities");
  assert.match(activity, /topResumedActivity=.*app\.vivic\.remote\/\.ScanActivity/);
  const cameras = adb("shell", "dumpsys", "media.camera");
  assert.match(cameras.split("Allowed user IDs:")[0], /app\.vivic\.remote/);
  let cameraXml = "";
  for (let count = 0; count < 4; count++) {
    const capture = adb("shell", "uiautomator", "dump", `/sdcard/vivic-camera-${count}.xml`);
    if (capture.includes("dumped to")) { cameraXml = adb("shell", "cat", `/sdcard/vivic-camera-${count}.xml`); break; }
    await pause(250);
  }
  assert.match(cameraXml, /扫描电脑 Vivic 二维码/);
  screenshot("camera-emulated-preview"); checks.push({ check: "native scanner opens emulated camera", passed: true });
  adb("shell", "input", "keyevent", "4");
  await waitFor("document.querySelector('dialog')?.textContent.includes('已取消扫码')");
  const cameraAfter = adb("shell", "dumpsys", "media.camera");
  assert.match(cameraAfter, /Active Camera Clients:\s*\[\s*\]/);
  adb("shell", "input", "keyevent", "4"); await waitFor("!document.querySelector('dialog')");
  checks.push({ check: "native back cancels scanner, releases camera, then closes sheet", passed: true });
  await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
  await waitFor("!!document.querySelector('#mobile-settings-title')");
  adb("shell", "input", "keyevent", "4"); await waitFor("!document.querySelector('#mobile-settings-title')");
  checks.push({ check: "native back closes settings without leaving app", passed: true });
  await evaluate("location.href='https://example.invalid/untrusted'"); await pause(200);
  assert.equal(await evaluate("location.href"), "https://appassets.androidplatform.net/assets/index.html");
  checks.push({ check: "external main-frame navigation blocked", passed: true });
  assert.equal(await evaluate("(() => { try { return (localStorage?.length ?? 0) + (sessionStorage?.length ?? 0); } catch { return 0; } })()"), 0);
  checks.push({ check: "no pairing credentials persisted in browser storage", passed: true });
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ device, syntheticCamera: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally { socket.close(); }
