const port = process.env.CATALOG_PORT ?? "8080";
const url = `http://127.0.0.1:${port}/api/readyz`;

try {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(4_000),
  });
  const status = await response.json();
  if (!response.ok || status?.ready !== true) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}
