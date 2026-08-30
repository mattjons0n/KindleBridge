import { cp, chmod, mkdir, readFile, readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CatalogRoot, ProfileMatchIndex } from "../../shared/catalog-contracts.js";
import type { CatalogService } from "../../server/catalog-service.js";
import {
  cleanupTemporaryDirectories,
  createConfiguration,
  getBookPage,
  makeEpub,
  makeTemporaryDirectory,
  mutationHeaders,
  sha256File,
  startTestCatalog,
} from "./catalog-test-support.js";

const temporaryDirectories: string[] = [];
const services = new Set<CatalogService>();

afterEach(async () => {
  for (const service of services) await service.close();
  services.clear();
  await cleanupTemporaryDirectories(temporaryDirectories);
});

describe("catalog service lifecycle integration", () => {
  it("detects same-size in-place rewrites and atomic replacements without changing the stable book ID", async () => {
    const directory = await makeTemporaryDirectory(temporaryDirectories);
    const allowed = path.join(directory, "libraries");
    const rootPath = path.join(allowed, "rewrites");
    await mkdir(rootPath, { recursive: true });
    const sourcePath = path.join(rootPath, "changing.epub");
    const firstBytes = makeEpub({ title: "Alpha One", author: "Same Author", identifier: "urn:rewrite:1" });
    const secondBytes = makeEpub({ title: "Bravo Two", author: "Same Author", identifier: "urn:rewrite:2" });
    const thirdBytes = makeEpub({ title: "Delta Six", author: "Same Author", identifier: "urn:rewrite:3" });
    const fourthBytes = makeEpub({ title: "Echo Nine", author: "Same Author", identifier: "urn:rewrite:4" });
    expect(secondBytes.length).toBe(firstBytes.length);
    expect(thirdBytes.length).toBe(firstBytes.length);
    expect(fourthBytes.length).toBe(firstBytes.length);
    const fixedTimestamp = new Date("2026-08-29T10:00:00Z");
    await writeFile(sourcePath, firstBytes);
    await utimes(sourcePath, fixedTimestamp, fixedTimestamp);

    let catalog = await startTestCatalog(path.join(directory, "state"), allowed);
    services.add(catalog.service);
    const configuration = await createConfiguration(catalog, {
      name: "Rewrite shelf",
      roots: [{ label: "Rewrite books", path: rootPath, watch: false }],
    });
    const rootId = configuration.roots[0]!.id;
    await catalog.service.indexer.scanNow(rootId);
    const initial = (await getBookPage(catalog, configuration.profile.id)).items[0]!;
    expect(initial.title).toBe("Alpha One");

    await writeFile(sourcePath, secondBytes);
    await utimes(sourcePath, fixedTimestamp, fixedTimestamp);
    await catalog.service.indexer.scanNow(rootId);
    expect((await getBookPage(catalog, configuration.profile.id)).items[0]).toMatchObject({
      id: initial.id,
      title: "Bravo Two",
      size: initial.size,
    });

    const replacementPath = path.join(rootPath, "atomic-replacement.epub");
    await writeFile(replacementPath, thirdBytes);
    await utimes(replacementPath, fixedTimestamp, fixedTimestamp);
    await rename(replacementPath, sourcePath);
    await catalog.service.indexer.scanNow(rootId);
    expect((await getBookPage(catalog, configuration.profile.id)).items[0]).toMatchObject({
      id: initial.id,
      title: "Delta Six",
      size: initial.size,
    });

    // Startup is authoritative too. A replacement that preserves both size and
    // mtime while the service is offline must be found on the real restart,
    // without waiting for the periodic reconciliation interval.
    services.delete(catalog.service);
    await catalog.service.close();
    await writeFile(sourcePath, fourthBytes);
    await utimes(sourcePath, fixedTimestamp, fixedTimestamp);
    catalog = await startTestCatalog(path.join(directory, "state"), allowed);
    services.add(catalog.service);
    expect((await getBookPage(catalog, configuration.profile.id)).items[0]).toMatchObject({
      id: initial.id,
      title: "Echo Nine",
      size: initial.size,
    });
  });

  it("scans a real read-only EPUB through the profile API and never mutates source bytes", async () => {
    const directory = await makeTemporaryDirectory(temporaryDirectories);
    const allowed = path.join(directory, "libraries");
    const rootPath = path.join(allowed, "reader");
    const state = path.join(directory, "state");
    await mkdir(rootPath, { recursive: true });
    const sourcePath = path.join(rootPath, "immutable.epub");
    const sourceBytes = makeEpub({
      title: "The Immutable Volume",
      author: "Ada Reader",
      identifier: "urn:test:immutable",
      publisher: "Read Only Press",
      subject: "Safety",
    });
    await writeFile(sourcePath, sourceBytes);
    await chmod(sourcePath, 0o444);
    const before = await stat(sourcePath);
    const beforeHash = await sha256File(sourcePath);

    const catalog = await startTestCatalog(state, allowed);
    services.add(catalog.service);
    const configuration = await createConfiguration(catalog, {
      name: "Reader",
      roots: [{ label: "Reader books", path: rootPath, watch: false }],
    });
    expect(await catalog.service.indexer.scanNow(configuration.roots[0]!.id)).toBe(true);

    const page = await getBookPage(catalog, configuration.profile.id);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      title: "The Immutable Volume",
      authors: ["Ada Reader"],
      publisher: "Read Only Press",
      sourceFilename: "immutable.epub",
      available: true,
    });

    const sourceResponse = await fetch(
      `${catalog.baseUrl}/api/profiles/${configuration.profile.id}/books/${page.items[0]!.id}/source`,
    );
    expect(sourceResponse.status).toBe(200);
    expect(Buffer.from(await sourceResponse.arrayBuffer())).toEqual(sourceBytes);
    expect(sourceResponse.headers.get("cache-control")).toBe("private, no-store");

    const after = await stat(sourcePath);
    expect(await sha256File(sourcePath)).toBe(beforeHash);
    expect(await readFile(sourcePath)).toEqual(sourceBytes);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode & 0o777).toBe(0o444);
    expect(await readdir(rootPath)).toEqual(["immutable.epub"]);
  });

  it("reconciles add, in-place change, rename, mount loss, and restoration without deleting history", async () => {
    const directory = await makeTemporaryDirectory(temporaryDirectories);
    const allowed = path.join(directory, "libraries");
    const rootPath = path.join(allowed, "household");
    const offlinePath = path.join(allowed, "household-offline");
    await mkdir(rootPath, { recursive: true });
    const alphaPath = path.join(rootPath, "alpha.epub");
    const betaPath = path.join(rootPath, "beta.epub");
    await writeFile(
      alphaPath,
      makeEpub({ title: "Alpha First Edition", author: "Alex Author", identifier: "urn:test:alpha:1" }),
    );

    const catalog = await startTestCatalog(path.join(directory, "state"), allowed);
    services.add(catalog.service);
    const configuration = await createConfiguration(catalog, {
      name: "Household",
      roots: [{ label: "Household books", path: rootPath, watch: false }],
    });
    const rootId = configuration.roots[0]!.id;
    await catalog.service.indexer.scanNow(rootId);
    const initial = await getBookPage(catalog, configuration.profile.id, "?available=true");
    expect(initial.total).toBe(1);
    const alphaId = initial.items[0]!.id;

    await writeFile(
      betaPath,
      makeEpub({ title: "Beta", author: "Bea Author", identifier: "urn:test:beta:1" }),
    );
    await catalog.service.indexer.scanNow(rootId);
    expect((await getBookPage(catalog, configuration.profile.id, "?available=true")).total).toBe(2);

    await writeFile(
      alphaPath,
      makeEpub({
        title: "Alpha Revised and Expanded",
        author: "Alex Author",
        identifier: "urn:test:alpha:2",
      }),
    );
    await catalog.service.indexer.scanNow(rootId);
    const afterChange = await getBookPage(catalog, configuration.profile.id, "?available=true&sort=title&order=asc");
    expect(afterChange.items.find((book) => book.id === alphaId)?.title).toBe("Alpha Revised and Expanded");

    const beta = afterChange.items.find((book) => book.sourceFilename === "beta.epub")!;
    await rename(betaPath, path.join(rootPath, "gamma.epub"));
    await catalog.service.indexer.scanNow(rootId);
    const afterRename = await getBookPage(catalog, configuration.profile.id, "?sort=title&order=asc&limit=20");
    expect(afterRename.total).toBe(2);
    expect(afterRename.items.find((book) => book.id === beta.id)).toMatchObject({
      sourceFilename: "gamma.epub",
      available: true,
    });
    const availableBeforeLoss = afterRename.items.filter((book) => book.available);
    expect(availableBeforeLoss).toHaveLength(2);

    await rename(rootPath, offlinePath);
    await catalog.service.indexer.scanNow(rootId);
    const afterFirstLoss = await getBookPage(catalog, configuration.profile.id, "?limit=20");
    expect(afterFirstLoss.items.filter((book) => book.available)).toHaveLength(2);
    expect(new Set(afterFirstLoss.items.map((book) => book.id))).toEqual(
      new Set(afterRename.items.map((book) => book.id)),
    );
    const rootsAfterFirstLoss = (await (
      await fetch(`${catalog.baseUrl}/api/profiles/${configuration.profile.id}/roots`)
    ).json()) as CatalogRoot[];
    expect(rootsAfterFirstLoss[0]).toMatchObject({ status: "unavailable" });

    await catalog.service.indexer.scanNow(rootId);
    const afterConfirmedLoss = await getBookPage(catalog, configuration.profile.id, "?limit=20");
    expect(afterConfirmedLoss.total).toBe(2);
    expect(afterConfirmedLoss.items.every((book) => !book.available)).toBe(true);

    await rename(offlinePath, rootPath);
    await catalog.service.indexer.scanNow(rootId);
    const restored = await getBookPage(catalog, configuration.profile.id, "?limit=20");
    expect(restored.items.filter((book) => book.available)).toHaveLength(2);
    expect(restored.items.find((book) => book.id === alphaId)?.title).toBe("Alpha Revised and Expanded");
    expect(restored.items.find((book) => book.sourceFilename === "gamma.epub")?.available).toBe(true);
  });

  it("rejects a same-path wrong backing directory without its sentinel and recovers without losing catalog history", async () => {
    const directory = await makeTemporaryDirectory(temporaryDirectories);
    const allowed = path.join(directory, "libraries");
    const rootPath = path.join(allowed, "sentinel-library");
    const realBacking = path.join(allowed, "sentinel-library-real");
    const wrongBacking = path.join(allowed, "sentinel-library-wrong");
    await mkdir(rootPath, { recursive: true });
    await writeFile(path.join(rootPath, ".kindle-bridge-volume"), "household-library\n");
    await writeFile(
      path.join(rootPath, "guarded.epub"),
      makeEpub({ title: "Guarded Book", author: "Mount Sentinel", identifier: "urn:test:sentinel" }),
    );

    const catalog = await startTestCatalog(path.join(directory, "sentinel-state"), allowed);
    services.add(catalog.service);
    const configuration = await createConfiguration(catalog, {
      name: "Sentinel Library",
      roots: [{
        label: "Guarded source",
        path: rootPath,
        watch: false,
        sentinel: ".kindle-bridge-volume",
      }],
    });
    const rootId = configuration.roots[0]!.id;
    expect(configuration.roots[0]?.sentinel).toBe(".kindle-bridge-volume");
    await catalog.service.indexer.scanNow(rootId);
    const initial = await getBookPage(catalog, configuration.profile.id, "?limit=20");
    expect(initial.items).toHaveLength(1);
    const bookId = initial.items[0]!.id;

    await rename(rootPath, realBacking);
    await mkdir(rootPath);
    await writeFile(path.join(rootPath, "wrong.epub"), makeEpub({
      title: "Wrong Backing",
      author: "Not This Volume",
      identifier: "urn:test:wrong-backing",
    }));
    await catalog.service.indexer.scanNow(rootId);
    await catalog.service.indexer.scanNow(rootId);

    const guarded = await getBookPage(catalog, configuration.profile.id, "?limit=20");
    expect(guarded.items).toHaveLength(1);
    expect(guarded.items[0]).toMatchObject({ id: bookId, title: "Guarded Book", available: false });
    const unavailableRoots = (await (
      await fetch(`${catalog.baseUrl}/api/profiles/${configuration.profile.id}/roots`)
    ).json()) as CatalogRoot[];
    expect(unavailableRoots[0]).toMatchObject({ status: "unavailable" });

    await rename(rootPath, wrongBacking);
    await rename(realBacking, rootPath);
    await catalog.service.indexer.scanNow(rootId);
    const restored = await getBookPage(catalog, configuration.profile.id, "?limit=20");
    expect(restored.items[0]).toMatchObject({ id: bookId, title: "Guarded Book", available: true });
  });

  it("persists configuration and delivery history across restart and an offline backup restore", async () => {
    const directory = await makeTemporaryDirectory(temporaryDirectories);
    const allowed = path.join(directory, "libraries");
    const rootPath = path.join(allowed, "reader");
    const liveState = path.join(directory, "live-state");
    const backupState = path.join(directory, "offline-backup");
    const restoredState = path.join(directory, "restored-state");
    await mkdir(rootPath, { recursive: true });
    await writeFile(
      path.join(rootPath, "durable.epub"),
      makeEpub({ title: "Durable Book", author: "Perry Sist", identifier: "urn:test:durable" }),
    );

    let catalog = await startTestCatalog(liveState, allowed);
    services.add(catalog.service);
    const configuration = await createConfiguration(catalog, {
      name: "Durable Reader",
      roots: [{ label: "Durable shelf", path: rootPath, watch: false }],
    });
    await catalog.service.indexer.scanNow(configuration.roots[0]!.id);
    const book = (await getBookPage(catalog, configuration.profile.id)).items[0]!;
    const managedToken = (await (
      await fetch(`${catalog.baseUrl}/api/profiles/${configuration.profile.id}/match-index`)
    ).json() as ProfileMatchIndex).entries.find((entry) => entry.bookId === book.id)?.managedToken;
    expect(managedToken).toMatch(/^kb-[0-9a-f]{20}$/u);
    const deliveryResponse = await fetch(`${catalog.baseUrl}/api/deliveries`, {
      method: "POST",
      headers: mutationHeaders(catalog.baseUrl, "durable-delivery"),
      body: JSON.stringify({
        profileId: configuration.profile.id,
        bookId: book.id,
        deviceKey: "pseudonymous-device-key",
        status: "delivered",
        artifactHash: "a".repeat(64),
        filename: "durable-kb-managed.azw3",
        size: 1234,
        managedToken,
      }),
    });
    expect(deliveryResponse.status).toBe(201);
    await catalog.service.close();
    services.delete(catalog.service);

    catalog = await startTestCatalog(liveState, allowed);
    services.add(catalog.service);
    expect((await getBookPage(catalog, configuration.profile.id)).items[0]?.id).toBe(book.id);
    await catalog.service.close();
    services.delete(catalog.service);

    // A production backup contains only the durable /data volume. The restored
    // service starts with a fresh rebuildable cache.
    await cp(path.join(liveState, "data"), path.join(backupState, "data"), { recursive: true });
    await cp(path.join(backupState, "data"), path.join(restoredState, "data"), { recursive: true });
    expect(await stat(path.join(restoredState, "cache")).catch(() => undefined)).toBeUndefined();
    catalog = await startTestCatalog(restoredState, allowed);
    services.add(catalog.service);

    const profiles = (await (await fetch(`${catalog.baseUrl}/api/profiles`)).json()) as Array<{
      id: string;
      name: string;
    }>;
    expect(profiles).toContainEqual(expect.objectContaining({ id: configuration.profile.id, name: "Durable Reader" }));
    const restoredBooks = await getBookPage(catalog, configuration.profile.id);
    expect(restoredBooks.items[0]).toMatchObject({ id: book.id, title: "Durable Book", available: true });
    const matchIndex = (await (
      await fetch(`${catalog.baseUrl}/api/profiles/${configuration.profile.id}/match-index`)
    ).json()) as ProfileMatchIndex;
    expect(matchIndex.entries.find((entry) => entry.bookId === book.id)?.deliveries).toContainEqual(
      expect.objectContaining({
        deviceKey: "pseudonymous-device-key",
        filename: "durable-kb-managed.azw3",
        managedToken,
        status: "delivered",
      }),
    );
  });

  it("keeps profile catalogs and source routes scoped to configured roots and rejects outside paths", async () => {
    const directory = await makeTemporaryDirectory(temporaryDirectories);
    const allowed = path.join(directory, "libraries");
    const firstRoot = path.join(allowed, "first");
    const secondRoot = path.join(allowed, "second");
    const outsideRoot = path.join(directory, "outside");
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(
      path.join(firstRoot, "first.epub"),
      makeEpub({
        title: "First Private Shelf",
        author: "First Author",
        identifier: "urn:test:first",
        subject: "First Subject",
      }),
    );
    await writeFile(
      path.join(secondRoot, "second.epub"),
      makeEpub({
        title: "Second Private Shelf",
        author: "Second Author",
        identifier: "urn:test:second",
        subject: "Second Subject",
      }),
    );
    await writeFile(
      path.join(outsideRoot, "outside.epub"),
      makeEpub({ title: "Outside", author: "Outside Author", identifier: "urn:test:outside" }),
    );

    const catalog = await startTestCatalog(path.join(directory, "state"), allowed);
    services.add(catalog.service);
    const first = await createConfiguration(catalog, {
      name: "First reader",
      roots: [{ label: "First shelf", path: firstRoot, watch: false }],
    });
    const second = await createConfiguration(catalog, {
      name: "Second reader",
      roots: [{ label: "Second shelf", path: secondRoot, watch: false }],
    });
    await catalog.service.indexer.scanNow(first.roots[0]!.id);
    await catalog.service.indexer.scanNow(second.roots[0]!.id);

    const firstBooks = await getBookPage(catalog, first.profile.id);
    const secondBooks = await getBookPage(catalog, second.profile.id);
    expect(firstBooks.items.map((book) => book.title)).toEqual(["First Private Shelf"]);
    expect(secondBooks.items.map((book) => book.title)).toEqual(["Second Private Shelf"]);
    expect(
      (await getBookPage(catalog, first.profile.id, `?rootId=${encodeURIComponent(second.roots[0]!.id)}`)).total,
    ).toBe(0);

    const crossProfileBook = secondBooks.items[0]!;
    expect(
      (
        await fetch(`${catalog.baseUrl}/api/profiles/${first.profile.id}/books/${crossProfileBook.id}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${catalog.baseUrl}/api/profiles/${first.profile.id}/books/${crossProfileBook.id}/source`,
        )
      ).status,
    ).toBe(404);
    const firstFilters = (await (
      await fetch(`${catalog.baseUrl}/api/profiles/${first.profile.id}/filters`)
    ).json()) as { authors: Array<{ value: string }> };
    expect(firstFilters.authors.map((author) => author.value)).toEqual(["First Author"]);

    const outsideResponse = await fetch(`${catalog.baseUrl}/api/profiles/configuration`, {
      method: "POST",
      headers: mutationHeaders(catalog.baseUrl, "outside-path-attempt"),
      body: JSON.stringify({
        profile: { name: "Outside attempt" },
        roots: [{ label: "Outside", path: outsideRoot, watch: false }],
      }),
    });
    expect(outsideResponse.status).toBe(400);
    expect(await outsideResponse.json()).toMatchObject({ error: { code: "path_not_allowed" } });
    const profilesAfterRejection = (await (await fetch(`${catalog.baseUrl}/api/profiles`)).json()) as unknown[];
    expect(profilesAfterRejection).toHaveLength(2);
  });
});
