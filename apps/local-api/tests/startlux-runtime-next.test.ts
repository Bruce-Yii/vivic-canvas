import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinnedEngine, localRuntimeEnv, extractStartluxSource } from "../src/runtime/pythonRuntime.js";
import * as pythonRuntime from "../src/runtime/pythonRuntime.js";
import { ManagedStartluxRuntime } from "../src/runtime/startluxRuntime.js";
import { zipSync, strToU8 } from "fflate";
import metadata from "../src/runtime/startlux-metadata.json" with {type:"json"};
import manifest from "../src/runtime/kokoro-manifest.json" with {type:"json"};
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
describe("pinned native runtime preparation",()=>{
 it("does not reuse the old Qwen engine, and separately pins all supported architectures",()=>{for(const [platform,arch] of [["win32","x64"],["darwin","arm64"],["darwin","x64"]] as const){const engine=pinnedEngine(platform,arch)!;expect(engine.name).toContain("b11550");expect(engine.sha256).toMatch(/^[a-f0-9]{64}$/);expect(engine.bytes).toBeGreaterThan(10_000_000);}expect(pinnedEngine("win32","arm64")).toBeUndefined();expect(pinnedEngine("linux","x64")).toBeUndefined();});
 it("never forwards operator model tokens to Python or engine processes",()=>{vi.stubEnv("STEPFUN_API_KEY","private-token");vi.stubEnv("VIVIC_DECISION_PROVIDER_TOKEN","private-decision");vi.stubEnv("HTTP_PROXY","http://private.test");vi.stubEnv("PYTHONPATH","/untrusted");const env=localRuntimeEnv();expect(env.STEPFUN_API_KEY).toBeUndefined();expect(env.VIVIC_DECISION_PROVIDER_TOKEN).toBeUndefined();expect(env.HTTP_PROXY).toBeUndefined();expect(env.PYTHONPATH).toBeUndefined();expect(env.HF_HUB_OFFLINE).toBe("1");});
 it("pins complete StartLux metadata for every selectable tier and Kokoro data per file",()=>{for(const files of Object.values(metadata)){expect(new Set(files.map(a=>a.name))).toEqual(new Set(["config.json","decision_config.json","tokenizer.json","tokenizer_config.json","LICENSE"]));for(const a of files){expect(a.url).toMatch(/\/resolve\/[a-f0-9]{40}\//);expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);expect(a.bytes).toBeGreaterThan(0);}}expect(manifest.files.some(a=>a.name==="ESPEAK-COPYING")).toBe(true);expect(manifest.files.some(a=>a.name==="espeak-ng-data/en_dict")).toBe(true);expect(manifest.files.some(a=>a.name==="lexicon-zh.txt")).toBe(true);expect(manifest.modelLicense).toBe("Apache-2.0");expect(manifest.espeakDataLicense).toBe("GPL-3.0-or-later");expect(new Set(manifest.files.map(a=>a.name)).size).toBe(manifest.files.length);});
 it("refuses an untrusted source archive path before any write outside the target",async()=>{const root=await fs.mkdtemp(path.join(tmpdir(),"vivic-source-"));roots.push(root);const archive=path.join(root,"bad.zip");await fs.writeFile(archive,zipSync({"other/startlux_decide/pipeline.py":strToU8("bad")}));await expect(extractStartluxSource(archive,path.join(root,"source"),new AbortController().signal)).rejects.toThrow("source_archive_path");expect(await fs.readdir(root)).toEqual(["bad.zip"]);});
 it("changes model selection only while stopped and cancels before a prepared child exists",async()=>{
   // Exercise the lifecycle on every CI host without pretending Linux has a
   // product engine. stop() aborts before the first artifact/network operation.
   const engine=pinnedEngine("darwin","arm64")!;
   vi.spyOn(pythonRuntime,"pinnedEngine").mockReturnValue(engine);
   const root=await fs.mkdtemp(path.join(tmpdir(),"vivic-selection-"));roots.push(root);
   const runtime=new ManagedStartluxRuntime(root,"startlux-0.8b");
   try {
     expect(runtime.selectProfile("startlux-4b")).toMatchObject({profileId:"startlux-4b",enabled:false,phase:"absent"});
     expect(()=>runtime.selectProfile("untrusted-url")).toThrow("invalid_profile");
     expect(runtime.prepare().phase).toBe("downloading");
     expect(()=>runtime.selectProfile("startlux-2b")).toThrow("runtime_busy");
     runtime.stop();await vi.waitFor(()=>expect(runtime.status().phase).toBe("absent"));
     expect((await runtime.decide("test")).state).toBe("disabled");
   } finally { runtime.stop(); await vi.waitFor(()=>expect(runtime.status().phase).toBe("absent")); }
 });
 it("rejects unsupported native platforms before downloading",async()=>{
   vi.spyOn(pythonRuntime,"pinnedEngine").mockReturnValue(undefined);
   const root=await fs.mkdtemp(path.join(tmpdir(),"vivic-unsupported-"));roots.push(root);
   const runtime=new ManagedStartluxRuntime(root,"startlux-0.8b");
   try { expect(runtime.prepare()).toMatchObject({phase:"error",enabled:false,error:expect.stringContaining("Windows x64")}); }
   finally { runtime.stop(); await vi.waitFor(()=>expect(runtime.status().phase).toBe("absent")); }
 });
});
