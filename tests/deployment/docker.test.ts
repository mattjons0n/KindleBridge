import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");

function read(path: string): string {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(projectRoot, path))).digest("hex");
}

describe("platform-agnostic Docker deployment", () => {
  it("pins a verified multi-architecture base image", () => {
    const dockerfile = read("Dockerfile");
    const lock = read("deploy/docker/base-image.lock");
    const bake = read("deploy/docker/docker-bake.hcl");

    expect(dockerfile).toContain("node:24.20.0-bookworm-slim@sha256:ba849c60");
    expect(dockerfile).toContain("FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build");
    expect(lock).toContain("index=sha256:ba849c60");
    expect(lock).toMatch(/linux\/amd64=sha256:[a-f0-9]{64}/u);
    expect(lock).toMatch(/linux\/arm64=sha256:[a-f0-9]{64}/u);
    expect(bake).toContain('\"linux/amd64\", \"linux/arm64\"');
    expect(bake).toContain('\"type=provenance,mode=max\"');
    expect(bake).toContain('\"type=sbom\"');
  });

  it("runs unprivileged with a read-only root and only explicit data/cache volumes", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("compose.yaml");

    expect(dockerfile).toContain("USER 1000:1000");
    expect(dockerfile).toContain('VOLUME ["/data", "/cache"]');
    expect(dockerfile.split(/\r?\n/u)).toContain("    TMPDIR=/cache \\");
    expect(dockerfile).not.toContain("TMPDIR=/cache/tmp");
    expect(dockerfile).toContain("STOPSIGNAL SIGTERM");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("cap_drop:");
    expect(compose).toContain("pids_limit: 128");
    expect(compose).toContain("stop_grace_period: 30s");
    expect(compose).toContain(":/libraries:ro");
    expect(compose).toContain("kindle-bridge-data:/data");
    expect(compose).toContain("kindle-bridge-cache:/cache");
    expect(compose).not.toContain("tmpfs:");
    expect(compose).not.toMatch(/\/dev\/bus\/usb|privileged:\s*true/iu);
  });

  it("binds direct HTTP to loopback and checks JSON readiness, not status alone", () => {
    const compose = read("compose.yaml");
    const dockerfile = read("Dockerfile");
    const healthcheck = read("deploy/docker/healthcheck.mjs");

    expect(compose).toContain("KINDLE_BRIDGE_BIND_ADDRESS:-127.0.0.1");
    expect(compose).toContain("/usr/local/lib/kindle-bridge/healthcheck.mjs");
    expect(dockerfile).toContain("/usr/local/lib/kindle-bridge/healthcheck.mjs");
    expect(dockerfile).toContain("CATALOG_STATIC_DIRECTORY=/app/dist/client");
    expect(compose).toContain("CATALOG_ALLOWED_ROOTS: /libraries");
    expect(compose).toContain("CATALOG_MAX_CONCURRENT");
    expect(compose).toContain("CATALOG_MAX_SOURCE_STREAMS");
    expect(compose).toContain('CATALOG_SOURCE_RESPONSE_TIMEOUT_MS: "${CATALOG_SOURCE_RESPONSE_TIMEOUT_MS:-600000}"');
    expect(compose).toContain('CATALOG_COVER_RESPONSE_TIMEOUT_MS: "${CATALOG_COVER_RESPONSE_TIMEOUT_MS:-30000}"');
    expect(compose).toContain('CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS: "${CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS:-10000}"');
    expect(compose).toContain('CATALOG_ROOT_POLICY_TIMEOUT_MS: "${CATALOG_ROOT_POLICY_TIMEOUT_MS:-10000}"');
    expect(compose).toContain("CATALOG_MAX_CONCURRENT_SCANS");
    expect(compose).toContain('CATALOG_SCAN_TIMEOUT_MS: "${CATALOG_SCAN_TIMEOUT_MS:-600000}"');
    expect(compose).toContain('CATALOG_MAX_SCAN_ENTRIES: "${CATALOG_MAX_SCAN_ENTRIES:-1000000}"');
    expect(compose).toContain('CATALOG_MAX_SCAN_DIRECTORIES: "${CATALOG_MAX_SCAN_DIRECTORIES:-50000}"');
    expect(compose).toContain("CATALOG_METADATA_WORKERS");
    expect(compose).toContain("CATALOG_METADATA_TIMEOUT_MS");
    expect(compose).toContain('CATALOG_STABILITY_WINDOW_MS: "${CATALOG_STABILITY_WINDOW_MS:-2000}"');
    expect(compose).toContain('CATALOG_COVER_RETENTION_MS: "${CATALOG_COVER_RETENTION_MS:-604800000}"');
    expect(compose).toContain('CATALOG_COVER_PRUNE_MS: "${CATALOG_COVER_PRUNE_MS:-86400000}"');
    expect(compose).toContain('CATALOG_DEEP_RECONCILE_MS: "${CATALOG_DEEP_RECONCILE_MS:-86400000}"');
    expect(compose).toContain('CATALOG_MAX_BODY_BYTES: "${CATALOG_MAX_BODY_BYTES:-1048576}"');
    expect(compose).toContain('CATALOG_SHUTDOWN_TIMEOUT_MS: "${CATALOG_SHUTDOWN_TIMEOUT_MS:-20000}"');
    expect(healthcheck).toContain("/api/readyz");
    expect(healthcheck).toContain("status?.ready !== true");
    expect(healthcheck).toContain("AbortSignal.timeout(4_000)");
  });

  it("ships redistribution evidence and verifies the vendored converter", () => {
    const dockerfile = read("Dockerfile");
    const dockerignore = read(".dockerignore");
    const notices = read("THIRD_PARTY_NOTICES.md");

    expect(dockerfile).toContain("npm run check");
    expect(dockerfile).toContain("sbom.cdx.json");
    expect(dockerfile).toContain("sbom.runtime.cdx.json");
    expect(dockerfile).toContain("boko-artifacts.sha256");
    expect(dockerfile).toContain("boko-wasm.sha256");
    expect(dockerfile).toContain("/usr/share/kindle-bridge/source/third_party/boko");
    expect(dockerfile).toContain("/usr/share/kindle-bridge/source/scripts");
    expect(dockerfile).toContain("/app/package.json ./package.json");
    expect(dockerignore).toContain("third_party/boko/target");
    expect(dockerignore).toContain("third_party/boko/web/pkg");
    expect(dockerignore).toContain("**/core");
    expect(dockerignore).toContain("**/core.*");
    expect(notices).toContain(sha256("client/vendor/boko/boko.js"));
    expect(notices).toContain(sha256("client/vendor/boko/boko_bg.wasm"));
    expect(read("third_party/boko/LICENSE")).toContain("GNU GENERAL PUBLIC LICENSE");
  });

  it("provides a strict HTTPS proxy policy for WebUSB", () => {
    const caddy = read("deploy/docker/Caddyfile.example");

    expect(caddy).toContain("tls internal");
    expect(caddy).toContain("Content-Security-Policy");
    expect(caddy).toContain("header_down -Content-Security-Policy");
    expect(caddy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(caddy).toContain("frame-ancestors 'none'");
    expect(caddy).toContain('Permissions-Policy "usb=(self)"');
    expect(caddy).toContain('X-Frame-Options "DENY"');
    expect(caddy).toContain('X-Content-Type-Options "nosniff"');
    expect(caddy).toContain("Strict-Transport-Security");
    expect(caddy).toContain("max_size 1MB");
  });

  it("documents the immutable storage boundary and full recovery lifecycle", () => {
    const decisions = read("deploy/docker/MILESTONE-0.md");
    const operations = read("deploy/docker/README.md");
    const checklist = read("deploy/docker/RELEASE_CHECKLIST.md");

    expect(decisions).toContain("Docker Engine 26 or newer");
    expect(decisions).toContain("200 MiB");
    expect(decisions).toContain("1.5 GiB");
    expect(decisions).toContain("publicly reachable unauthenticated deployment is explicitly unsupported");
    expect(operations).toContain("paths such as `/libraries/husband`");
    expect(operations).toContain("never mounts local, NAS, SMB, or NFS storage itself");
    expect(operations).toContain("Non-destructive restore and rollback");
    expect(operations).toContain("Cache and catalog rebuild");
    expect(operations).toContain("Cold backup");
    expect(checklist).toContain("Physical secure-origin acceptance");
  });

  it("makes backup executable and restore non-overwriting by construction", () => {
    const backupPath = resolve(projectRoot, "deploy/docker/backup-data.sh");
    const restorePath = resolve(projectRoot, "deploy/docker/restore-data.sh");
    const rebuildPath = resolve(projectRoot, "deploy/docker/rebuild-catalog.sh");
    const verifierPath = resolve(projectRoot, "deploy/docker/verify-backup.sh");
    const backup = read("deploy/docker/backup-data.sh");
    const restore = read("deploy/docker/restore-data.sh");
    const rebuild = read("deploy/docker/rebuild-catalog.sh");

    expect(statSync(backupPath).mode & 0o111).not.toBe(0);
    expect(statSync(restorePath).mode & 0o111).not.toBe(0);
    expect(statSync(rebuildPath).mode & 0o111).not.toBe(0);
    expect(statSync(verifierPath).mode & 0o111).not.toBe(0);
    expect(backup).toContain("dst=/data,readonly");
    expect(backup).toContain("sha256sum");
    expect(backup).toContain("set -C");
    expect(backup).toContain("Refusing to overwrite existing backup");
    expect(backup).toContain("Refusing backup while a running container uses the data volume");
    expect(restore).toContain("Refusing to overwrite existing Docker volume");
    expect(restore).toContain("org.kindle-bridge.restore-token");
    expect(restore).toContain("verify-backup.sh");
    expect(restore).toContain("dist/server/maintenance.js verify");
    expect(rebuild).toContain("Refusing catalog rebuild while a running container uses the data volume");
    expect(rebuild).toContain("dist/server/maintenance.js prepare-rebuild");
    expect(restore).not.toMatch(/docker volume rm|rm -rf/iu);
  });

  it("refuses a same-timestamp backup retry without changing the first archive", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "kindle-bridge-backup-test-"));
    try {
      const bin = resolve(directory, "bin");
      const backups = resolve(directory, "backups");
      mkdirSync(bin);
      mkdirSync(backups);
      const dateStub = resolve(bin, "date");
      const dockerStub = resolve(bin, "docker");
      writeFileSync(dateStub, "#!/bin/sh\nprintf '%s\\n' 20260830T120000Z\n");
      writeFileSync(dockerStub, `#!/bin/sh
set -eu
if [ "\${1:-}" = volume ]; then exit 0; fi
if [ "\${1:-}" = ps ]; then exit 0; fi
backup=
archive=
for argument do
  case "$argument" in
    type=bind,src=*,dst=/backup) backup=\${argument#type=bind,src=}; backup=\${backup%,dst=/backup} ;;
    ARCHIVE=*) archive=\${argument#ARCHIVE=} ;;
  esac
done
printf 'first-backup' > "$backup/$archive"
printf 'checksum' > "$backup/$archive.sha256"
`);
      chmodSync(dateStub, 0o755);
      chmodSync(dockerStub, 0o755);
      const environment = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
      const first = spawnSync(resolve(projectRoot, "deploy/docker/backup-data.sh"), ["test-volume", backups], {
        env: environment,
        encoding: "utf8",
      });
      expect(first.status, first.stderr).toBe(0);
      const archive = resolve(backups, "kindle-bridge-data-20260830T120000Z.tar.gz");
      expect(readFileSync(archive, "utf8")).toBe("first-backup");

      const second = spawnSync(resolve(projectRoot, "deploy/docker/backup-data.sh"), ["test-volume", backups], {
        env: environment,
        encoding: "utf8",
      });
      expect(second.status).toBe(73);
      expect(second.stderr).toContain("Refusing to overwrite existing backup");
      expect(readFileSync(archive, "utf8")).toBe("first-backup");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds a checksum sidecar to the selected archive", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "kindle-bridge-restore-checksum-"));
    try {
      const selected = resolve(directory, "selected.tar.gz");
      const other = resolve(directory, "other.tar.gz");
      writeFileSync(selected, "selected-backup");
      writeFileSync(other, "different-backup");
      writeFileSync(`${selected}.sha256`, `${createHash("sha256").update(readFileSync(other)).digest("hex")}  other.tar.gz\n`);
      const result = spawnSync(resolve(projectRoot, "deploy/docker/verify-backup.sh"), [selected], { encoding: "utf8" });
      expect(result.status).toBe(65);
      expect(result.stderr).toContain("does not match the selected archive");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses backup when a running container uses the data volume", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "kindle-bridge-running-backup-"));
    try {
      const bin = resolve(directory, "bin");
      const backups = resolve(directory, "backups");
      const runMarker = resolve(directory, "docker-run-called");
      mkdirSync(bin);
      mkdirSync(backups);
      const dockerStub = resolve(bin, "docker");
      writeFileSync(dockerStub, `#!/bin/sh
set -eu
if [ "\${1:-}" = volume ]; then exit 0; fi
if [ "\${1:-}" = ps ]; then printf '%s\\n' running-container; exit 0; fi
touch "${runMarker}"
`);
      chmodSync(dockerStub, 0o755);
      const result = spawnSync(resolve(projectRoot, "deploy/docker/backup-data.sh"), ["busy-volume", backups], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      expect(result.status).toBe(73);
      expect(result.stderr).toContain("running container");
      expect(() => statSync(runMarker)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a restore volume claimed during reservation", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "kindle-bridge-restore-race-"));
    try {
      const bin = resolve(directory, "bin");
      const archive = resolve(directory, "backup.tar.gz");
      const runMarker = resolve(directory, "docker-run-called");
      mkdirSync(bin);
      writeFileSync(archive, "backup");
      writeFileSync(`${archive}.sha256`, `${createHash("sha256").update("backup").digest("hex")}  backup.tar.gz\n`);
      const dockerStub = resolve(bin, "docker");
      writeFileSync(dockerStub, `#!/bin/sh
set -eu
if [ "\${1:-}" = volume ] && [ "\${2:-}" = inspect ]; then
  if [ "\${3:-}" = --format ]; then printf '%s\\n' foreign-token; exit 0; fi
  exit 1
fi
if [ "\${1:-}" = volume ] && [ "\${2:-}" = create ]; then exit 0; fi
touch "${runMarker}"
`);
      chmodSync(dockerStub, 0o755);
      const result = spawnSync(resolve(projectRoot, "deploy/docker/restore-data.sh"), [archive, "new-volume"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      expect(result.status).toBe(73);
      expect(result.stderr).toContain("created by another actor");
      expect(() => statSync(runMarker)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps deployment contracts independent of any host vendor", () => {
    const productFiles = [
      "README.md",
      "AGENTS.md",
      "PROJECT_HANDOFF.md",
      "outputs/kindle-bridge-service-design-plan.md",
      "outputs/kindle-bridge-implementation-build-plan.md",
      "deploy/docker/MILESTONE-0.md",
      "deploy/docker/README.md",
      "compose.yaml",
      "Dockerfile",
    ];
    const text = productFiles.map(read).join("\n");

    expect(text).not.toMatch(/requires? Synology|Synology-only|Container Manager|\.spk/iu);
    expect(text).toMatch(/platform-agnostic/iu);
  });
});
