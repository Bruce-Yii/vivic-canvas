import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync, spawn } from "node:child_process";

// Opt-in: an isolated, camera/microphone-free AVD and a debug-only test CA.
// Production APK and the user's existing services/trust store are never changed.
test("Android bundled controller reaches the real cookie owner through trusted test TLS", async ({ browser }, info) => {
  test.skip(process.env.VIVIC_ANDROID_ONLINE !== "1", "Requires dedicated vivic_online_20261023 AVD and debug-only CA package");
  test.setTimeout(120_000);
  const repository = path.resolve(import.meta.dirname, "../../../..");
  const cache = path.join(repository, ".cache/online-mobile-20261023");
  const sdk = path.join(process.env.USERPROFILE!, ".rea/toolchains/android/sdk");
  const adb = (...args: string[]) => execFileSync(path.join(sdk, "platform-tools/adb.exe"), ["-s", "emulator-5610", ...args], { encoding: "utf8", timeout: 30_000 });
  expect(adb("shell", "getprop", "ro.kernel.qemu").trim()).toBe("1");
  expect(adb("emu", "avd", "name")).toContain("vivic_online_20261023");
  await expect.poll(() => adb("shell", "getprop", "sys.boot_completed").trim(), { timeout: 60_000 }).toBe("1");
  const version = fs.readFileSync(path.join(repository, "apps/android/AndroidManifest.xml"), "utf8").match(/android:versionName="([0-9.]+)"/)?.[1];
  expect(version).toBeTruthy();
  const apk = path.join(repository, `.cache/android-build/artifacts/Vivic-Remote-${version}-debug.apk`);
  const receipt = JSON.parse(fs.readFileSync(`${apk}.json`, "utf8"));
  expect(receipt.debugging && receipt.testCa).toBe(true);
  adb("install", "-r", apk);
  adb("reverse", "tcp:18445", "tcp:18445");
  const api = spawn(process.execPath, ["--import", "tsx", "src/online/index.ts"], { cwd: path.join(repository, "apps/local-api"),
    env: { ...process.env, PORT: "18795", VIVIC_ONLINE_ORIGIN: "https://localhost:18445" }, stdio: "ignore", windowsHide: true });
  const proxy = https.createServer({ key: fs.readFileSync(path.join(cache, "tls-key.pem")), cert: fs.readFileSync(path.join(cache, "tls-cert.pem")) }, (incoming, outgoing) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: 18795, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => upstream.destroy()); incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(18445, "127.0.0.1", resolve); });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  let socket: WebSocket | undefined;
  try {
    await expect.poll(async () => { try { return (await fetch("http://localhost:18795/healthz")).ok; } catch { return false; } }).toBe(true);
    const owner = await context.newPage();
    await owner.addInitScript(() => localStorage.setItem("vivic.online.welcome.v1", "done"));
    await owner.goto("https://localhost:18445/"); await expect(owner.getByLabel("指令输入")).toBeVisible();
    await owner.getByRole("button", { name: "设置", exact: true }).click();
    await owner.locator('[data-settings-extra="mobile"] > summary').click();
    await owner.getByRole("button", { name: "生成连接二维码" }).click();
    await expect(owner.locator("[data-vivic-mobile-pair-code]")).toHaveText(/^[A-F0-9]{16}$/);
    const code = await owner.locator("[data-vivic-mobile-pair-code]").textContent();
    const pairingUrl = `https://localhost:18445/remote/#pair=${code}&online=1`;
    adb("shell", "am", "force-stop", "app.vivic.remote"); adb("shell", "am", "start", "-n", "app.vivic.remote/.MainActivity");
    let pid = "";
    await expect.poll(() => { try { pid = adb("shell", "pidof", "app.vivic.remote").trim(); return /^\d+$/.test(pid); } catch { return false; } }).toBe(true);
    adb("forward", "tcp:9338", `localabstract:webview_devtools_remote_${pid}`);
    let target: { webSocketDebuggerUrl: string } | undefined;
    await expect.poll(async () => {
      try { target = (await (await fetch("http://127.0.0.1:9338/json/list")).json()).find((item: { url: string }) => item.url === "https://appassets.androidplatform.net/assets/index.html"); return !!target; } catch { return false; }
    }).toBe(true);
    socket = new WebSocket(target!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
    const pending = new Map<number, { resolve(value: any): void; reject(value: unknown): void }>(); let sequence = 0;
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)); const job = pending.get(message.id);
      if (job) { pending.delete(message.id); message.error ? job.reject(new Error("Native debugger request failed")) : job.resolve(message.result); }
    });
    const evaluate = async (expression: string) => {
      const id = ++sequence;
      const result = await new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })); });
      if (result.exceptionDetails) throw new Error("Native UI evaluation failed"); return result.result.value;
    };
    await expect.poll(() => evaluate("!!document.querySelector('#mobile-pair-code')")).toBe(true);
    await evaluate(`(() => { const field=document.querySelector('#mobile-pair-code'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(pairingUrl)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate("document.querySelector('form.mobile-pair-form').requestSubmit()");
    await expect.poll(() => evaluate("document.querySelector('.mobile-pair-confirm')?.textContent ?? ''")).toContain("localhost:18445");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='确认连接电脑').click()");
    await expect.poll(() => evaluate("!!document.querySelector('[aria-label=\"发送给电脑的文字指令\"]:enabled')")).toBe(true);
    await expect(owner.locator("[data-vivic-online-mobile-control]")).toContainText("已连接 1 部手机");
    await owner.getByRole("button", { name: "关闭设置" }).click();
    const text = "安卓线上可信TLS真实保存";
    await evaluate(`(() => { const field=document.querySelector('[aria-label="发送给电脑的文字指令"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(`新建便笺：${text}`)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate("document.querySelector('form.mobile-composer').requestSubmit()");
    await expect.poll(() => evaluate("document.querySelectorAll('.mobile-request-succeeded').length")).toBe(1);
    await evaluate("document.querySelector('#mobile-tab-space').click()");
    await expect.poll(() => evaluate("document.querySelector('.mobile-space-card')?.textContent ?? ''")).toContain(text);
    await evaluate("document.querySelector('.mobile-card-pin').click()");
    await expect.poll(() => evaluate("document.querySelector('.mobile-card-pin')?.getAttribute('aria-pressed')")).toBe("true");
    fs.writeFileSync(info.outputPath("01-native-online-space.png"), execFileSync(path.join(sdk, "platform-tools/adb.exe"), ["-s", "emulator-5610", "exec-out", "screencap", "-p"], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }));
    const popup = owner.waitForEvent("popup"); await owner.getByRole("button", { name: "展示窗口", exact: true }).click();
    const display = await popup; await expect(display.getByText(text, { exact: true })).toBeVisible();
    await owner.getByRole("button", { name: "设置", exact: true }).click();
    await owner.locator("[data-vivic-online-mobile-control]").getByRole("button", { name: "撤销授权", exact: true }).click();
    await expect.poll(() => evaluate("document.querySelector('[role=alert]')?.textContent ?? ''")).toContain("撤销");
    expect(await evaluate("(() => { try { return localStorage !== null; } catch { return false; } })()")).toBe(false);
    await owner.getByRole("button", { name: "停止手机控制", exact: true }).click();
    await owner.reload(); await expect(owner.getByLabel("指令输入")).toBeVisible();
    await display.reload(); await expect(display.getByText(text, { exact: true })).toBeVisible();
    fs.writeFileSync(info.outputPath("result.json"), JSON.stringify({ checkedAt: new Date().toISOString(),
      isolatedAvd: "vivic_online_20261023", androidOrigin: "https://appassets.androidplatform.net", transport: "HTTPS phone-only CORS via adb reverse",
      testCa: "debug-only exact certificate; no production trust change", realOwner: true, realBuiltinNote: true, pin: true,
      ownerFlush: true, reloadPersistence: true, revoked: true, phoneStorage: false, physicalMedia: false }, null, 2));
  } finally {
    socket?.close(); await context.close(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); api.kill();
    try { adb("reverse", "--remove", "tcp:18445"); } catch { /* Only this test's optional tunnel. */ }
    try { adb("forward", "--remove", "tcp:9338"); } catch { /* Startup may fail before debugger forwarding. */ }
  }
});
