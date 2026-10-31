import { readFile, writeFile } from "node:fs/promises";
import { createWireJsonSchemas } from "../packages/contracts/src/wireJsonSchema";

const directory = new URL("../Vivic_Kimi_Handoff_v0.6/contracts/", import.meta.url);
const check = process.argv.includes("--check");
for (const [name, schema] of Object.entries(createWireJsonSchemas())) {
  const target = new URL(name, directory);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  if (check) {
    if (await readFile(target, "utf8") !== expected) throw new Error(`${name} is stale; run pnpm contracts:generate`);
  } else await writeFile(target, expected);
  console.log(`${check ? "Checked" : "Generated"} ${name}`);
}
