// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogBrowser } from "../../client/src/catalog-browser";
import type { CatalogApi } from "../../client/src/catalog-client";
import { renderLibraryPrototype, renderOnboarding } from "../../client/src/library-prototype-view";
import { initialAppState } from "../../client/src/state";
import { libraryIcon } from "../../client/src/library-icons";

describe("ShelfSend display branding", () => {
  it("brands the real sidebar and onboarding without renaming Kindle connection actions", () => {
    const browser = new CatalogBrowser({} as CatalogApi, {}, () => {}, undefined);
    const state = { ...initialAppState(), secureContext: true, webUsbAvailable: true };
    const html = renderLibraryPrototype(state, browser.snapshot);
    expect(html).toContain("ShelfSend library home");
    expect(html).toContain("<strong>ShelfSend</strong>");
    expect(html).toContain("Browser to reader");
    expect(html).toContain(libraryIcon("shelfSend"));
    expect(html).toContain("Connect Kindle");
    expect(html).not.toContain("Kindle Bridge");
    const welcome = renderOnboarding({ ...browser.snapshot, onboarding: { step: "welcome" } }, state);
    expect(welcome).toContain("Welcome to ShelfSend");
  });
  it("brands the browser title/icon but preserves deployment and storage compatibility", () => {
    const read = (file: string) => readFileSync(new NodeURL(`../../${file}`, import.meta.url), "utf8");
    expect(read("client/index.html")).toContain("<title>ShelfSend Library</title>");
    expect(read("client/index.html")).toContain('href="/shelfsend.svg"');
    expect(read("client/public/shelfsend.svg")).toContain("<svg");
    expect(JSON.parse(read("package.json")).name).toBe("kindle-bridge");
    expect(read("compose.yaml")).toContain("kindle-bridge-data:/data");
    expect(read("client/src/delivery-journal.ts")).toContain('"kindle-bridge.pending-deliveries-v1"');
    expect(read("client/src/kindle/device-metadata-cache-codec.ts")).toContain('".kindle-bridge-device-metadata-cache-"');
  });
});
