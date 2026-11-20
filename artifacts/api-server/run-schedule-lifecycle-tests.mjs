import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const temporaryDirectory = await mkdtemp(
  path.join(packageDirectory, ".schedule-lifecycle-test-"),
);
const testBundle = path.join(temporaryDirectory, "schedule-lifecycle.test.mjs");

try {
  const testNodeModules = path.join(temporaryDirectory, "node_modules");
  await mkdir(testNodeModules, { recursive: true });
  await symlink(
    path.resolve(packageDirectory, "../../lib/db/node_modules/pg"),
    path.join(testNodeModules, "pg"),
    "dir",
  );
  await build({
    entryPoints: [
      path.join(packageDirectory, "src/routes/scheduleLifecycle.test.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: testBundle,
    external: [
      "exceljs",
      "express",
      "multer",
      "pg",
      "pg-native",
      "drizzle-orm",
      "@clerk/express",
      "@clerk/shared",
    ],
    sourcemap: "inline",
    logLevel: "warning",
  });
  const result = spawnSync(process.execPath, ["--test", testBundle], {
    stdio: "inherit",
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
