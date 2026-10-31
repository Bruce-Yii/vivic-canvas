// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { webcrypto } from "node:crypto";
import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { readPackageZip, definitionKey, definitionRef, type CardDefinition } from "@vivic/card-runtime";
import { HostedCardPackages } from "./HostedCardPackages";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("./HostedDefinitions", () => ({ useRefreshHostedDefinitions: () => refresh }));
let root: Root, container: HTMLDivElement, definition: CardDefinition;
let rows: { key: string; definition: CardDefinition; enabled: boolean }[], currentAccount: string;
let deleteStatus: number, expired: boolean;
const fixture = resolve(process.cwd(), "../../examples/vivicard/fitness-log");
const bytes = zipSync(Object.fromEntries(readdirSync(fixture, { recursive: true }).filter(name => String(name).endsWith(".json")).map(name => [String(name).replaceAll("\\", "/"), new Uint8Array(readFileSync(resolve(fixture, String(name))))])));
const request = vi.fn(async (path: string, options?: RequestInit) => {
  if (expired) return Response.json({ ok: false, code: "session-required", message: "登录已失效" }, { status: 401 });
  if (path === "/api/space/session") return Response.json({ authenticated: true, user: { id: currentAccount } });
  if (path === "/api/space/cards" && options?.method === "POST") {
    rows = [{ key: definitionKey(definitionRef(definition)), definition, enabled: true }];
    return Response.json({ ok: true, record: rows[0] });
  }
  if (options?.method === "PATCH") { rows = rows.map(row => ({ ...row, enabled: JSON.parse(options.body as string).enabled })); return Response.json({ ok: true, record: rows[0] }); }
  if (options?.method === "DELETE") return Response.json({ ok: false, code: "definition-in-use", message: "当前Space仍有卡片引用此版本，请仅停用卡片包。" }, { status: deleteStatus });
  return Response.json({ definitions: rows });
});
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
const button = (label: string) => Array.from(container.querySelectorAll("button")).find(node => node.textContent === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); await settle(); };
beforeAll(async () => { vi.stubGlobal("crypto", webcrypto); definition = await readPackageZip(bytes); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", request);
  request.mockClear(); refresh.mockClear(); rows = []; currentAccount = "evaluation-a"; deleteStatus = 409; expired = false;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async () => { await act(async () => root.render(<HostedCardPackages />)); await settle(); };

describe("server card package management", () => {
  it("parses v0.2 with its real hash, previews DEMO without writing, and installs only after confirmation", async () => {
    await render();
    const file = new File([bytes], "fitness-log.vivicard", { type: "application/zip" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    const input = container.querySelector("input[type=file]")!; Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true }))); await settle();
    expect(container.textContent).toContain("DEMO 预览"); expect(container.textContent).toContain("2026-01-15");
    expect(request.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    await click("确认安装");
    const upload = request.mock.calls.find(([, options]) => options?.method === "POST")![1]!;
    expect(upload.credentials).toBe("same-origin"); expect(upload.headers).toBeUndefined(); expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get("enabled")).toBe("true"); expect(rows).toHaveLength(1); expect(refresh).toHaveBeenCalled();
    expect(container.querySelector("[aria-label='卡片包预览']")).toBeNull();
  });
  it("uses exact hash for toggling and keeps the definition after an in-use uninstall conflict", async () => {
    rows = [{ key: definitionKey(definitionRef(definition)), definition, enabled: true }]; await render(); await click("停用");
    const update = request.mock.calls.find(([, options]) => options?.method === "PATCH")![1]!;
    expect(JSON.parse(update.body as string)).toEqual({ hash: definition.hash, enabled: false }); expect(refresh).toHaveBeenCalled();
    await click("卸载"); await click("确认卸载");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("仍有卡片引用"); expect(container.querySelectorAll("[data-package-id]")).toHaveLength(1);
    expect(request.mock.calls.find(([, options]) => options?.method === "DELETE")![0]).toContain(`hash=${definition.hash}`);
  });
  it("does not issue mutations under a different account", async () => {
    rows = [{ key: definitionKey(definitionRef(definition)), definition, enabled: true }]; await render(); currentAccount = "evaluation-b"; await click("停用");
    expect(request.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
    expect(container.querySelectorAll("[data-package-id]")).toHaveLength(0); expect(container.textContent).toContain("重新登录");
  });
  it("rejects tampered stored files rather than trusting parsed manifest fields", async () => {
    const tampered = structuredClone(definition); tampered.files["manifest.json"] = { ...(tampered.files["manifest.json"] as object), name: "tampered" };
    rows = [{ key: definitionKey(definitionRef(definition)), definition: tampered, enabled: true }]; await render();
    expect(container.querySelector("[role=alert]")).not.toBeNull(); expect(container.querySelectorAll("[data-package-id]")).toHaveLength(0);
  });
});
