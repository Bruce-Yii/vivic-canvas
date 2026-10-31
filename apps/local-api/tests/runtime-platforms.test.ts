import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { readMacEngineArchive, runtimeArtifacts } from "../src/runtime/artifacts.js";
import { ManagedDecisionRuntime } from "../src/runtime/decisionRuntime.js";

function archive(entries: { name: string; body?: string; link?: string; type?: string }[]) {
  const blocks: Buffer[] = [];
  for (const row of entries) {
    const body = Buffer.from(row.body ?? ""), header = Buffer.alloc(512);
    header.write(row.name); header.write("0000755\0", 100); header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156); header.write(row.type ?? (row.link ? "2" : "0"), 156); if (row.link) header.write(row.link, 157);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
describe("local runtime platform boundaries", () => {
  it("selects separately pinned Windows and two macOS binaries", () => {
    expect(runtimeArtifacts("win32", "x64")?.engine.executable).toBe("llama-server.exe");
    expect(runtimeArtifacts("darwin", "arm64")?.engine.name).toContain("macos-arm64");
    expect(runtimeArtifacts("darwin", "x64")?.engine.name).toContain("macos-x64");
    expect(runtimeArtifacts("darwin", "arm64")?.engine.sha256).not.toBe(runtimeArtifacts("darwin", "x64")?.engine.sha256);
    expect(runtimeArtifacts("win32", "arm64")).toBeUndefined();
    expect(runtimeArtifacts("linux", "x64")).toBeUndefined();
  });
  it("resolves only local dylib aliases and never creates filesystem symlinks", () => {
    const files = readMacEngineArchive(archive([{ name: "llama-b9660/llama-server", body: "binary" },
      { name: "llama-b9660/libllama.0.dylib", body: "library" },
      { name: "llama-b9660/libllama.dylib", link: "libllama.0.dylib" }]));
    expect(Buffer.from(files["libllama.dylib"]!).toString()).toBe("library");
    expect(Object.keys(files)).toHaveLength(3);
  });
  it.each([
    [{ name: "llama-b9660/../outside", body: "bad" }],
    [{ name: "llama-b9660/lib.dylib", link: "../../outside" }],
    [{ name: "llama-b9660/lib.dylib", link: "missing" }],
    [{ name: "llama-b9660/a", link: "b" }, { name: "llama-b9660/b", link: "a" }],
    [{ name: "llama-b9660/a", body: "one" }, { name: "llama-b9660/a", body: "two" }],
    [{ name: "llama-b9660/a", type: "3" }],
  ].map(entries => ({ entries })))("rejects paths, cycles, duplicates and special files", ({ entries }) => {
    expect(() => readMacEngineArchive(archive(entries))).toThrow(/engine_archive_/);
  });
  it("does not start a download or subprocess on unsupported hardware", () => {
    const runtime = new ManagedDecisionRuntime("unused-runtime", { platform: "win32", arch: "arm64", fetchImpl: async () => { throw new Error("must not download"); } });
    expect(runtime.prepare()).toMatchObject({ phase: "error", enabled: false });
  });
});
