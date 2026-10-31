// @vitest-environment node
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePackageFiles } from "@vivic/card-runtime";
import { createExtensionInstance } from "../extensionInstance";
import { ExtensionCardView } from "../ExtensionCardView";

it("DEMO rendering exposes neither remote image sources nor navigable links", async () => {
  const object = JSON.stringify({ type: "object", properties: {}, additionalProperties: false });
  const definition = await parsePackageFiles({
    "manifest.json": JSON.stringify({ formatVersion: "0.1", id: "test.no-network", version: "1.0.0", name: "无网络预览", description: "TEST", renderer: "declarative", host: "0.6", capabilities: [] }),
    "config.schema.json": object, "state.schema.json": object,
    "data.schema.json": JSON.stringify({ type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }),
    "ui.json": JSON.stringify({ components: [{ component: "Image", bind: "/data/url" }, { component: "Link", bind: "/data/url" }] }),
    "examples/demo.json": JSON.stringify({ name: "DEMO", config: {}, data: { url: "https://example.invalid/never-fetch" }, state: {} }),
  });
  const card = createExtensionInstance(definition, definition.examples[0]!);
  const html = renderToStaticMarkup(<ExtensionCardView card={card} definition={definition} />);
  expect(html).toContain("DEMO 预览不加载远程图片"); expect(html).toContain("DEMO 链接未打开");
  expect(html).not.toContain("src="); expect(html).not.toContain("href="); expect(html).not.toContain("example.invalid");
});
