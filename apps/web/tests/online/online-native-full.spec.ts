import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

// Dedicated synthetic image camera, debug-only private TLS, and isolated owner.
// Four initial cards are a labeled response fixture; subsequent phone commands use the real API.
test("Android scans the desktop QR and synchronizes existing Space, progress, edits and durable phone actions", async ({ browser }, info) => {
  test.skip(process.env.VIVIC_ANDROID_FULL !== "1", "Requires the dedicated camera-free Android acceptance environment");
  const repository = path.resolve(import.meta.dirname, "../../../..");
  const cache = path.join(repository, ".cache/full-android-20261024"); fs.mkdirSync(cache, { recursive: true });
  const oldCache = path.join(repository, ".cache/online-mobile-20261023");
  const sdk = path.join(process.env.USERPROFILE!, ".rea/toolchains/android/sdk");
  const adbExe = path.join(sdk, "platform-tools/adb.exe");
  const adb = (...args: string[]) => execFileSync(adbExe, ["-s", "emulator-5610", ...args], { encoding: "utf8", timeout: 30000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const screenshot = (name: string) => fs.writeFileSync(info.outputPath(name), execFileSync(adbExe, ["-s", "emulator-5610", "exec-out", "screencap", "-p"], { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
  const origin = "https://localhost:19445";
  const api = spawn(process.execPath, ["--import", "tsx", "src/online/index.ts"], { cwd: path.join(repository, "apps/local-api"),
    env: { ...process.env, PORT: "18995", VIVIC_ONLINE_ORIGIN: origin, VIVIC_ONLINE_WEB_DIST: path.join(repository, "apps/web/dist-online-android-full") }, stdio: "ignore", windowsHide: true });
  const proxy = https.createServer({ key: fs.readFileSync(path.join(oldCache, "tls-key.pem")), cert: fs.readFileSync(path.join(oldCache, "tls-cert.pem")) }, (incoming, outgoing) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: 18995, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => upstream.destroy()); incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(19445, "127.0.0.1", resolve); });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  let socket: WebSocket | undefined, emulator: ChildProcess | undefined;
  const checks: string[] = [];
  try {
    await expect.poll(async () => { try { return (await fetch("http://localhost:18995/healthz")).ok; } catch { return false; } }).toBe(true);
    const owner = await context.newPage();
    await owner.addInitScript(() => { localStorage.setItem("vivic.online.welcome.v1", "done"); if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error("No physical media during acceptance"); }; });
    await owner.goto(origin); await expect(owner.getByLabel("指令输入")).toBeVisible();
    let fixtureUsed = false;
    await owner.route("**/api/intent", async route => {
      const body = route.request().postDataJSON();
      if (body.text !== "TEST 初始同步卡片" || fixtureUsed) return route.continue();
      fixtureUsed = true;
      const now = new Date().toISOString();
      const shell = { variant: "minimal", sources: [], layout: { x: 0, y: 0, width: 320, height: 180, pinned: false }, metadata: { createdAt: now, updatedAt: now }, sourceData: {} };
      const cards = [
        { ...shell, id: "android-existing-note", type: "NoteCard", displayProps: { text: "TEST 已有电脑便笺正文" } },
        { ...shell, id: "android-existing-todo", type: "TodoCard", displayProps: { items: [{ id: "android-done", text: "TEST 已完成事项", done: true }, { id: "android-pending", text: "TEST 未完成事项", done: false }] } },
        { ...shell, id: "android-existing-goal", variant: "standard", type: "ProgressRingCard", displayProps: { title: "TEST 项目进度", current: 3, target: 10, unit: "项", note: "TEST 保留目前进度" } },
        { ...shell, id: "android-existing-timer", type: "CountdownCard", displayProps: {}, sourceData: { targetAt: new Date(Date.now() + 600000).toISOString(), startedAt: now } },
      ];
      await route.fulfill({ json: { kind: "envelope", usedProvider: "rules", envelope: { schemaVersion: "0.6", requestId: "android-fixture-seed", canvasId: body.canvasContext.canvasId, actions: cards.map(card => ({ type: "card.create", card })), spokenText: "TEST 同步卡片已建立" } } });
    });
    await owner.getByLabel("指令输入").fill("TEST 初始同步卡片"); await owner.getByLabel("指令输入").press("Enter");
    await expect(owner.getByText("TEST 同步卡片已建立", { exact: true })).toBeVisible();
    const popup = owner.waitForEvent("popup"); await owner.getByRole("button", { name: "展示窗口", exact: true }).click(); const display = await popup;
    await expect(display.getByText("TEST 已有电脑便笺正文", { exact: true })).toBeVisible();
    await owner.getByRole("button", { name: "设置", exact: true }).click(); await owner.locator('[data-settings-extra="mobile"] > summary').click();
    await expect(owner.locator("[data-vivic-android-download]")).toBeVisible();
    const metadata = await (await context.request.get(`${origin}/downloads/android.json`)).json();
    const downloadEvent = owner.waitForEvent("download"); await owner.locator("[data-vivic-android-download]").click(); const download = await downloadEvent;
    const release = path.join(cache, "downloaded-production.apk"); await download.saveAs(release);
    expect(createHash("sha256").update(fs.readFileSync(release)).digest("hex")).toBe(metadata.sha256);
    expect(fs.statSync(release).size).toBe(metadata.bytes); checks.push("desktop APK download has exact production SHA256");
    await owner.getByRole("button", { name: "生成连接二维码" }).click();
    await expect(owner.locator("[data-vivic-mobile-pair-code]")).toHaveText(/^[A-F0-9]{16}$/);
    await expect(owner.getByAltText("手机控制一次性配对二维码")).toHaveAttribute("src", /^data:image\/png/);
    const qr = path.join(cache, "camera-qr.png");
    const qrBitmap = Buffer.from((await owner.getByAltText("手机控制一次性配对二维码").getAttribute("src"))!.split(",")[1]!, "base64");
    const sharp = createRequire(path.join(repository, "apps/local-api/package.json"))("sharp");
    // This emulator's preview samples the upper-left field of its image source.
    // Add white surroundings, keeping the desktop QR pixels unchanged and visible.
    fs.writeFileSync(qr, await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "white" } }).composite([{ input: qrBitmap, left: 100, top: 300 }]).png().toBuffer());
    // The only camera source is a file containing the desktop's actual QR bitmap.
    const emuLog = fs.openSync(path.join(cache, "emulator.log"), "a");
    emulator = spawn(path.join(sdk, "emulator/emulator.exe"), ["-avd", "vivic_online_20261023", "-port", "5610", "-no-window", "-no-snapshot", "-no-metrics", "-no-audio", "-gpu", "host", "-camera-back", `imagefile:${qr}`, "-camera-front", "none"], {
      env: { ...process.env, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: path.join(oldCache, "avd") }, stdio: ["ignore", emuLog, emuLog], windowsHide: true });
    await expect.poll(() => { try { return adb("shell", "getprop", "sys.boot_completed").trim(); } catch { return ""; } }, { timeout: 90000 }).toBe("1");
    expect(adb("emu", "avd", "name")).toContain("vivic_online_20261023");
    adb("install", "-r", release); adb("shell", "am", "start", "-n", "app.vivic.remote/.MainActivity");
    expect(adb("shell", "dumpsys", "package", "app.vivic.remote")).not.toMatch(/pkgFlags=\[[^\]]*DEBUGGABLE/);
    screenshot("01-production-apk-installed.png"); checks.push("downloaded production APK installs and opens without DEBUGGABLE");
    adb("shell", "am", "force-stop", "app.vivic.remote");
    const debug = path.join(repository, `.cache/android-build/artifacts/Vivic-Remote-${metadata.version}-debug.apk`);
    const receipt = JSON.parse(fs.readFileSync(`${debug}.json`, "utf8")); expect(receipt.debugging && receipt.testCa).toBe(true);
    adb("install", "-r", debug); adb("reverse", "tcp:19445", "tcp:19445");
    adb("shell", "pm", "grant", "app.vivic.remote", "android.permission.CAMERA");
    adb("shell", "am", "start", "-n", "app.vivic.remote/.MainActivity");
    let pid = ""; await expect.poll(() => { try { pid = adb("shell", "pidof", "app.vivic.remote").trim(); return /^\d+$/.test(pid); } catch { return false; } }).toBe(true);
    adb("forward", "tcp:9338", `localabstract:webview_devtools_remote_${pid}`);
    let target: { webSocketDebuggerUrl: string } | undefined;
    await expect.poll(async () => { try { target = (await (await fetch("http://127.0.0.1:9338/json/list")).json()).find((item: { url: string }) => item.url === "https://appassets.androidplatform.net/assets/index.html"); return !!target; } catch { return false; } }).toBe(true);
    socket = new WebSocket(target!.webSocketDebuggerUrl); await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", reject, { once: true }); });
    const pending = new Map<number, { resolve(value: any): void; reject(value: unknown): void }>(); let sequence = 0;
    socket.addEventListener("message", event => { const message = JSON.parse(String(event.data)), job = pending.get(message.id); if (job) { pending.delete(message.id); message.error ? job.reject(new Error("Native debugger request failed")) : job.resolve(message.result); } });
    const evaluate = async (expression: string) => { const id = ++sequence; const result = await new Promise<any>((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native evaluation timed out")); }, 8000); pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })); }); if (result.exceptionDetails) throw new Error("Native UI evaluation failed"); return result.result.value; };
    const click = (label: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
    await expect.poll(() => evaluate("!!document.querySelector('.mobile-scan-button')")).toBe(true);
    const previousCode = await owner.locator("[data-vivic-mobile-pair-code]").textContent();
    await owner.getByRole("button", { name: "重新生成", exact: true }).click();
    await expect(owner.locator("[data-vivic-mobile-pair-code]")).not.toHaveText(previousCode!);
    await expect(owner.getByAltText("手机控制一次性配对二维码")).toHaveAttribute("src", /^data:image\/png/);
    const freshQr = Buffer.from((await owner.getByAltText("手机控制一次性配对二维码").getAttribute("src"))!.split(",")[1]!, "base64");
    fs.writeFileSync(qr, await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "white" } }).composite([{ input: freshQr, left: 100, top: 300 }]).png().toBuffer());
    await evaluate("window.__scanEvidence=[]; window.addEventListener('vivic:scan-result',e=>window.__scanEvidence.push({type:'scan-result',hasValue:!!e.detail?.value,error:e.detail?.error}));window.addEventListener('vivic:native-back',()=>window.__scanEvidence.push({type:'native-back'}));document.addEventListener('click',e=>window.__scanEvidence.push({type:'click',tag:e.target.tagName,text:e.target.textContent?.slice(0,40)}),true)");
    await click("扫描电脑二维码");
    try { await expect.poll(() => evaluate("document.querySelector('.mobile-pair-confirm')?.textContent ?? ''"), { timeout: 20000 }).toContain("localhost:19445"); }
    catch (error) { screenshot("scan-failed.png"); fs.writeFileSync(info.outputPath("scan-native-failed.txt"), adb("logcat", "-d", "-t", "800")); fs.writeFileSync(info.outputPath("scan-failed.json"), JSON.stringify({ activity: adb("shell", "dumpsys", "activity", "activities").split("\n").filter(line=>line.includes("topResumedActivity")), pid: adb("shell", "pidof", "app.vivic.remote"), originalPid: pid, events: await evaluate("window.__scanEvidence").catch(()=>null), text: await evaluate("document.body.innerText").catch(()=>null) }, null, 2)); throw error; }
    screenshot("03-camera-decoded-confirmation.png");
    expect(adb("shell", "dumpsys", "media.camera")).toMatch(/Active Camera Clients:\s*\[\s*\]/);
    checks.push("synthetic camera ZXing decoding of exact desktop QR with explicitly granted camera permission; camera released");
    await click("确认连接电脑"); await expect.poll(() => evaluate("!!document.querySelector('[aria-label=\"发送给电脑的文字指令\"]:enabled')")).toBe(true);
    await expect(owner.locator("[data-vivic-online-mobile-control]")).toContainText("已连接 1 部手机"); await expect(owner.locator("[data-vivic-mobile-pair-code]")).toHaveCount(0);
    await owner.getByRole("button", { name: "关闭设置" }).click();
    // Real OS swipe, not calling the React handler directly.
    adb("shell", "input", "swipe", "160", "750", "860", "760", "320");
    await expect.poll(() => evaluate("document.querySelector('main')?.getAttribute('data-mobile-page')")).toBe("space");
    await expect.poll(() => evaluate("document.querySelectorAll('.mobile-space-card').length")).toBe(4);
    expect(await evaluate("document.querySelector('[data-mobile-card-id=android-existing-note]').textContent")).toContain("TEST 已有电脑便笺正文");
    expect(await evaluate("document.querySelector('[data-mobile-card-id=android-existing-goal]').textContent")).toContain("3 / 10");
    expect(await evaluate("document.querySelectorAll('[data-mobile-card-id=android-existing-todo] [data-completed=true]').length")).toBe(1);
    const firstTime = await evaluate("document.querySelector('.mobile-card-countdown-digits').textContent");
    await expect.poll(() => evaluate("document.querySelector('.mobile-card-countdown-digits').textContent"), { timeout: 5000 }).not.toBe(firstTime);
    screenshot("04-initial-space-content-progress.png"); checks.push("actual swipe; initial existing note/todo completion/goal progress/countdown synchronized");
    // Desktop checkbox is a real edit, reflected on the already paired phone.
    const todo = display.locator('[data-card-id="android-existing-todo"]');
    await todo.hover(); await todo.getByRole("button", { name: /^传送到用户页/ }).click();
    const userTodo = owner.locator('[data-vivic-user-card][data-scene-type="TodoCard"]');
    await userTodo.getByRole("checkbox").last().click();
    await userTodo.getByRole("button", { name: /放回副屏/ }).click();
    await expect.poll(() => evaluate("document.querySelectorAll('[data-mobile-card-id=android-existing-todo] [data-completed=true]').length")).toBe(2);
    await evaluate("document.querySelector('[data-mobile-card-id=android-existing-note] .mobile-card-pin').click()");
    await expect.poll(() => evaluate("document.querySelector('[data-mobile-card-id=android-existing-note] .mobile-card-pin').getAttribute('aria-pressed')")).toBe("true");
    await evaluate("document.querySelector('#mobile-tab-chat').click()");
    const text = "TEST 安卓扫码后真实保存";
    await evaluate(`(() => { const input=document.querySelector('[aria-label="发送给电脑的文字指令"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(`新建便笺：${text}`)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate("document.querySelector('form.mobile-composer').requestSubmit()");
    await expect.poll(() => evaluate("Array.from(document.querySelectorAll('.mobile-request-succeeded')).some(item=>item.textContent.includes('TEST 安卓扫码后真实保存'))")).toBe(true);
    await expect(display.getByText(text, { exact: true })).toBeVisible(); checks.push("desktop edit live sync; native pin and real API basic card creation durable success");
    // Android settings remain local only, and keyboard resizing is visible through the native WebView.
    const fullHeight = await evaluate("visualViewport.height");
    const imeDump = `/sdcard/vivic-full-ime-${Date.now()}.xml`;
    adb("shell", "uiautomator", "dump", imeDump);
    const imeXml = adb("shell", "cat", imeDump); fs.writeFileSync(info.outputPath("ime-hierarchy.xml"), imeXml);
    const webView = imeXml.match(/<node[^>]*class="android.webkit.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    expect(webView).toBeTruthy();
    const field = await evaluate("(() => { const r=document.querySelector('[aria-label=\"发送给电脑的文字指令\"]').getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth }; })()");
    const scale = (+webView![3]! - +webView![1]!) / field.width;
    adb("shell", "input", "tap", String(Math.round(+webView![1]! + field.x * scale)), String(Math.round(+webView![2]! + field.y * scale)));
    await expect.poll(() => evaluate("visualViewport.height")).toBeLessThan(fullHeight - 100);
    expect(await evaluate("document.querySelector('[aria-label=\"发送给电脑的文字指令\"]').getBoundingClientRect().bottom<=visualViewport.height+2")).toBe(true);
    screenshot("05-native-chat-keyboard.png");
    adb("shell", "input", "keyevent", "4");
    await expect.poll(() => evaluate("visualViewport.height")).toBeGreaterThan(fullHeight - 10);
    expect(adb("shell", "dumpsys", "activity", "activities")).toMatch(/topResumedActivity=.*app\.vivic\.remote\/\.MainActivity/);
    checks.push("real Android input-method opens on actual accessibility input bounds; resizes WebView; focused composer remains visible");
    await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()");
    expect(await evaluate("document.querySelector('dialog').textContent")).toContain("其他设置请在电脑调整");
    expect(await evaluate("document.querySelector('dialog').textContent")).not.toMatch(/API Key|模型下载/);
    await evaluate("(() => { const s=document.querySelector('#mobile-theme'); s.value='dark'; s.dispatchEvent(new Event('change',{bubbles:true})); })()");
    await evaluate("(() => { const s=document.querySelector('#mobile-text-size'); s.value='large'; s.dispatchEvent(new Event('change',{bubbles:true})); })()");
    await expect.poll(() => evaluate("document.querySelector('main').getAttribute('data-large-text')")).toBe("true");
    await expect.poll(() => evaluate("getComputedStyle(document.querySelector('.mobile-session-actions button')).color === getComputedStyle(document.querySelector('main')).color")).toBe(true);
    screenshot("06-native-small-settings-dark.png"); adb("shell", "input", "keyevent", "4");
    await expect.poll(() => evaluate("!!document.querySelector('#mobile-settings-title')")).toBe(false);
    expect(await evaluate("document.documentElement.scrollWidth<=innerWidth")).toBe(true);
    checks.push("phone small settings/dark/large text/native back/narrow layout");
    // Background/resume preserves in-memory authorization; refresh/process death intentionally does not.
    adb("shell", "input", "keyevent", "3"); adb("shell", "am", "start", "-n", "app.vivic.remote/.MainActivity");
    await expect.poll(() => evaluate("!!document.querySelector('[aria-label=\"发送给电脑的文字指令\"]:enabled')")).toBe(true);
    await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()"); await click("断开连接");
    await expect.poll(() => evaluate("!!document.querySelector('[aria-label=\"发送给电脑的文字指令\"]:disabled')")).toBe(true);
    await evaluate("document.querySelector('[aria-label=\"打开设置\"]').click()"); await click("重新连接");
    await expect.poll(() => evaluate("!!document.querySelector('[aria-label=\"发送给电脑的文字指令\"]:enabled')")).toBe(true);
    adb("shell", "input", "keyevent", "4");
    checks.push("phone intentional disconnect disables writing; reconnect recovers existing in-memory authorization");
    await owner.getByRole("button", { name: "设置", exact: true }).click();
    await owner.locator("[data-vivic-online-mobile-control]").getByRole("button", { name: "撤销授权", exact: true }).click();
    await expect.poll(() => evaluate("document.querySelector('[role=alert]')?.textContent ?? ''")).toContain("撤销");
    expect(await evaluate("!!document.querySelector('[aria-label=\"发送给电脑的文字指令\"]')")).toBe(false);
    expect(await evaluate("(() => { try { return localStorage !== null; } catch { return false; } })()")).toBe(false);
    await owner.getByRole("button", { name: "停止手机控制", exact: true }).click(); await owner.reload(); await expect(owner.getByLabel("指令输入")).toBeVisible();
    await display.reload(); await expect(display.getByText(text, { exact: true })).toBeVisible();
    await display.locator('[data-card-id="android-existing-todo"]').hover();
    await display.locator('[data-card-id="android-existing-todo"]').getByRole("button", { name: /^传送到用户页/ }).click();
    await expect(owner.locator('[data-vivic-user-card][data-scene-type="TodoCard"]').getByRole("checkbox").last()).toBeChecked();
    checks.push("native background resume; revoke disables phone; no phone storage; desktop reload preserves edits and created content");
    socket.close(); socket = undefined;
    // Reopen the same synthetic camera with a blank image for deny/cancel tests.
    fs.writeFileSync(qr, await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "white" } }).png().toBuffer());
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["apps/android/tests/verify-native.mjs"], { cwd: repository, windowsHide: true, stdio: "inherit",
        env: { ...process.env, Path: `${path.join(sdk, "platform-tools")};${process.env.Path ?? process.env.PATH}`, VIVIC_ANDROID_EVIDENCE_DIR: info.outputPath("native-permission") } });
      child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Native permission verification failed (${code})`)));
    });
    checks.push("native camera permission denial/manual fallback; camera cancel/release; settings back; external navigation blocked");
    fs.writeFileSync(info.outputPath("result.json"), JSON.stringify({ checkedAt: new Date().toISOString(), checks, fixture: "initial four cards only; no claim of real StepFun here", physicalMedia: false, qrMethod: "actual native ZXing camera frames from exact desktop QR imagefile", productionApkSha256: metadata.sha256, testTrust: "debug-only exact CA; production package unchanged" }, null, 2));
  } finally {
    socket?.close(); await context.close(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); api.kill();
    try { adb("reverse", "--remove", "tcp:19445"); } catch { }
    try { adb("forward", "--remove", "tcp:9338"); } catch { }
    if (emulator) { try { adb("emu", "kill"); } catch { emulator.kill(); } }
  }
});
