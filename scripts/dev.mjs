import { mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const developmentRoot = resolve(projectRoot, ".kindle-bridge-dev");
const dataDirectory = resolve(developmentRoot, "data");
const cacheDirectory = resolve(developmentRoot, "cache");
const libraryDirectory = resolve(developmentRoot, "libraries");

for (const directory of [dataDirectory, cacheDirectory, libraryDirectory]) {
  mkdirSync(directory, { recursive: true });
}

const build = spawnSync(
  process.execPath,
  [resolve(projectRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.server.json"],
  { cwd: projectRoot, stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const serverEnvironment = {
  ...process.env,
  CATALOG_HOST: process.env.CATALOG_HOST ?? "127.0.0.1",
  CATALOG_PORT: process.env.CATALOG_PORT ?? "5174",
  CATALOG_DATABASE_PATH: process.env.CATALOG_DATABASE_PATH ?? resolve(dataDirectory, "catalog.sqlite"),
  CATALOG_CACHE_DIRECTORY: process.env.CATALOG_CACHE_DIRECTORY ?? cacheDirectory,
  CATALOG_ALLOWED_ROOTS: process.env.CATALOG_ALLOWED_ROOTS ?? libraryDirectory,
  CATALOG_ALLOWED_ORIGINS: process.env.CATALOG_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173",
  CATALOG_ALLOWED_HOSTS: process.env.CATALOG_ALLOWED_HOSTS ?? "127.0.0.1:5173,localhost:5173,127.0.0.1:5174,localhost:5174",
  CATALOG_SETTINGS_MODE: process.env.CATALOG_SETTINGS_MODE ?? "read-write",
};

const children = [
  spawn(process.execPath, [resolve(projectRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.server.json", "--watch", "--preserveWatchOutput"], {
    cwd: projectRoot,
    stdio: "inherit",
  }),
  spawn(process.execPath, ["--watch", "--watch-preserve-output", resolve(projectRoot, "dist/server/main.js")], {
    cwd: projectRoot,
    env: serverEnvironment,
    stdio: "inherit",
  }),
  spawn(process.execPath, [resolve(projectRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "5173"], {
    cwd: projectRoot,
    stdio: "inherit",
  }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop(signal);
    setTimeout(() => process.exit(0), 100).unref();
  });
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (stopping) return;
    stop();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
