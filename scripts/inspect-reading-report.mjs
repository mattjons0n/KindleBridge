// Offline only. Reuse the actual bounded TypeScript parser without changing or uploading the report.
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Usage: node scripts/inspect-reading-report.mjs <diagnostic.json> [--structure]");
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
const state = asModule(readFileSync(new URL("../client/src/kindle/reading-state.ts", import.meta.url), "utf8"));
const source = readFileSync(new URL("../client/src/kindle/krds-reading-state.ts", import.meta.url), "utf8")
  .replace('from "./reading-state"', `from ${JSON.stringify(state)}`);
const { parseKindleKrdsReadingEvidence, decodeKindleKrdsDiagnostic } = await import(asModule(source));
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const results = [];
for (const object of report.objects) {
  const format = object.path.split(".").pop().toLowerCase();
  if (!object.base64 || !["azw3f", "azw3r", "yjf", "yjr", "mbs", "mbp1"].includes(format)) continue;
  const bytes = new Uint8Array(Buffer.from(object.base64, "base64"));
  const result = { path: object.path, sha256: object.sha256 };
  try { result.evidence = parseKindleKrdsReadingEvidence(bytes, format); }
  catch (error) { result.error = error.message; }
  if (process.argv.includes("--structure")) {
    try { result.structure = decodeKindleKrdsDiagnostic(bytes); }
    catch (error) { result.structureError = error.message; }
  }
  results.push(result);
}
console.log(JSON.stringify(results, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
