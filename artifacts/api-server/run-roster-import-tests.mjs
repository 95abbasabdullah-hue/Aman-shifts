import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const temporaryDirectory = await mkdtemp(path.join(packageDirectory, ".roster-test-"));
const testBundle = path.join(temporaryDirectory, "roster-import.test.mjs");

try {
  await build({
    entryPoints: [path.join(packageDirectory, "src/lib/rosterImport.test.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: testBundle,
    external: ["exceljs"],
    sourcemap: "inline",
    logLevel: "warning",
  });
  const result = spawnSync(process.execPath, ["--test", testBundle], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
