import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Root integration supplies an ephemeral code and an isolated owner's test text here.
// Neither input is echoed or included in screenshots before pairing consumes the code.
const input = JSON.parse(fs.readFileSync(path.resolve(".cache/android-build/live-pair.json"), "utf8"));
assert.match(input.code, /^[A-F0-9]{16}$/);
assert.equal(typeof input.text, "string");
const processId = execFileSync("adb", ["-s", "emulator-5610", "shell", "pidof", "app.vivic.remote"], { encoding: "utf8" }).trim();
assert.match(processId, /^\d+$/);
execFileSync("adb", ["-s", "emulator-5610", "forward", "tcp:9338", `localabstract:webview_devtools_remote_${processId}`]);
const targets = await (await fetch("http://127.0.0.1:9338/json/list")).json();
const target = targets.find(item => item.url === "https://appassets.androidplatform.net/assets/index.html");
assert.ok(target, "Dedicated debug APK must be open");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => { const message = JSON.parse(event.data); const job = pending.get(message.id); if (job) { pending.delete(message.id); clearTimeout(job.timer); message.error ? job.reject(message.error) : job.resolve(message.result); } });
const call = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native debugger timed out")); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error("Native UI evaluation failed"); return result.result.value; };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitFor = async (expression, limit = 100) => { for (let i = 0; i < limit; i++) { if (await evaluate(expression)) return; await pause(300); } const error = await evaluate("document.querySelector('[role=alert]')?.textContent ?? document.querySelector('.mobile-request')?.textContent ?? 'No response'"); throw new Error(`Native live verification timed out: ${error}`); };
const fill = (selector, value) => evaluate(`(() => { const field=document.querySelector(${JSON.stringify(selector)}); if(!field)throw Error('Input unavailable'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
try {
  assert.ok(await evaluate("!!document.querySelector('#mobile-pair-code')"), "Use an unpaired isolated APK session");
  await fill("#mobile-pair-code", input.code);
  await evaluate("document.querySelector('form.mobile-pair-form').requestSubmit()");
  await waitFor("!!document.querySelector('[aria-label=\"发送给电脑的文字指令\"]:enabled')");
  assert.equal(await evaluate("!!document.querySelector('#mobile-pair-code')"), false);
  await fill('[aria-label="发送给电脑的文字指令"]', input.text);
  await evaluate("document.querySelector('form.mobile-composer').requestSubmit()");
  await waitFor("!!document.querySelector('.mobile-request-succeeded')", 240);
  const result = await evaluate(`(() => { let storageAvailable=false; try { storageAvailable=localStorage!==null; } catch {} return { status:document.querySelector('.mobile-connection')?.textContent, computer:document.querySelector('#mobile-device-title')?.textContent, result:document.querySelector('.mobile-request-succeeded .mobile-result-message')?.textContent, caption:document.querySelector('.mobile-canvas-caption')?.textContent, cardCount:document.querySelectorAll('.mobile-cards li').length, storageAvailable }; })()`);
  assert.equal(result.storageAvailable, false, "Android controller must keep DOM storage disabled");
  const directory = path.resolve(".cache/android-build/native-verification");
  fs.mkdirSync(directory, { recursive: true });
  const screenshot = execFileSync("adb", ["-s", "emulator-5610", "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024, timeout: 20000 });
  fs.writeFileSync(path.join(directory, "public-live-connected.png"), screenshot);
  fs.writeFileSync(path.join(directory, "public-live-result.json"), JSON.stringify({ checkedAt: new Date().toISOString(), origin: "https://appassets.androidplatform.net", relay: "wss://edsionc.top/vivic-remote/relay", ...result }, null, 2));
  console.log(JSON.stringify({ paired: true, computerConfirmed: true, ...result }));
} finally { socket.close(); }
