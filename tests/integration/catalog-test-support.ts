import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CatalogBook, CatalogRoot } from "../../shared/catalog-contracts.js";
import { createCatalogService, type CatalogService } from "../../server/catalog-service.js";

export interface TestCatalog {
  service: CatalogService;
  baseUrl: string;
}

export interface CreatedConfiguration {
  profile: { id: string; name: string };
  roots: CatalogRoot[];
}

export interface BookPageBody {
  items: CatalogBook[];
  total: number;
  limit: number;
  offset: number;
}

export async function makeTemporaryDirectory(cleanups: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-bridge-integration-"));
  cleanups.push(directory);
  return directory;
}

export async function cleanupTemporaryDirectories(cleanups: string[]): Promise<void> {
  while (cleanups.length > 0) {
    await rm(cleanups.pop() as string, { recursive: true, force: true });
  }
}

export async function startTestCatalog(
  stateDirectory: string,
  allowedRootPath: string,
  overrides: { databaseName?: string; cacheName?: string } = {},
): Promise<TestCatalog> {
  const dataDirectory = path.join(stateDirectory, "data");
  const cacheDirectory = path.join(stateDirectory, "cache");
  await mkdir(dataDirectory, { recursive: true });
  const service = await createCatalogService({
    databasePath: path.join(dataDirectory, overrides.databaseName ?? "catalog.sqlite"),
    cacheDirectory: path.join(cacheDirectory, overrides.cacheName ?? "derived"),
    allowedRootPaths: [allowedRootPath],
    http: {
      hostname: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
      requireOriginForMutations: true,
      requestsPerMinutePerAddress: 10_000,
    },
    scanner: {
      quietWindowMs: 60_000,
      reconciliationIntervalMs: 60_000,
      watcherHints: false,
      stabilityWindowMs: 0,
    },
  });
  const address = await service.start();
  return { service, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function createConfiguration(
  catalog: TestCatalog,
  input: {
    name: string;
    roots: Array<{
      label: string;
      path: string;
      recursive?: boolean;
      watch?: boolean;
      enabled?: boolean;
      sentinel?: string;
    }>;
  },
  idempotencyKey = `configuration-${randomUUID()}`,
): Promise<CreatedConfiguration> {
  const response = await fetch(`${catalog.baseUrl}/api/profiles/configuration`, {
    method: "POST",
    headers: mutationHeaders(catalog.baseUrl, idempotencyKey),
    body: JSON.stringify({
      profile: { name: input.name },
      roots: input.roots,
    }),
  });
  if (!response.ok) {
    throw new Error(`Configuration request failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as CreatedConfiguration;
}

export function mutationHeaders(baseUrl: string, idempotencyKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: baseUrl,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

export async function getBookPage(
  catalog: TestCatalog,
  profileId: string,
  query = "",
): Promise<BookPageBody> {
  const response = await fetch(
    `${catalog.baseUrl}/api/profiles/${encodeURIComponent(profileId)}/books${query}`,
  );
  if (!response.ok) {
    throw new Error(`Book request failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as BookPageBody;
}

export async function sha256File(filename: string): Promise<string> {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

export function makeEpub(input: {
  title: string;
  author: string;
  identifier: string;
  language?: string;
  publisher?: string;
  publishedAt?: string;
  subject?: string;
}): Buffer {
  const title = escapeXml(input.title);
  const author = escapeXml(input.author);
  const authorSort = escapeXml(input.author.split(" ").reverse().join(", "));
  const identifier = escapeXml(input.identifier);
  const language = escapeXml(input.language ?? "en");
  const publisher = escapeXml(input.publisher ?? "Integration Press");
  const publishedAt = escapeXml(input.publishedAt ?? "2026-08-29");
  const subject = escapeXml(input.subject ?? "Integration Testing");
  return zipArchive([
    { name: "mimetype", data: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
        `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>` +
        `</rootfiles></container>`,
    },
    {
      name: "OEBPS/content.opf",
      data:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<package version="3.0" unique-identifier="book-id" xmlns="http://www.idpf.org/2007/opf">` +
        `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">` +
        `<dc:identifier id="book-id">${identifier}</dc:identifier>` +
        `<dc:title>${title}</dc:title>` +
        `<dc:creator opf:file-as="${authorSort}">${author}</dc:creator>` +
        `<dc:language>${language}</dc:language>` +
        `<dc:publisher>${publisher}</dc:publisher>` +
        `<dc:date>${publishedAt}</dc:date>` +
        `<dc:subject>${subject}</dc:subject>` +
        `</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>` +
        `</manifest><spine><itemref idref="chapter"/></spine></package>`,
    },
    {
      name: "OEBPS/chapter.xhtml",
      data:
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>` +
        `<body><h1>${title}</h1><p>Immutable source fixture.</p></body></html>`,
    },
  ]);
}

interface ZipEntryInput {
  name: string;
  data: string | Buffer;
}

function zipArchive(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data: Buffer): number {
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
