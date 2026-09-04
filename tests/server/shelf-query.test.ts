import { describe, expect, it } from "vitest";

import {
  decodeSmartShelfQuery,
  encodeSmartShelfQuery,
  normalizeSmartShelfQuery,
  smartShelfQueryToBookQuery,
  SmartShelfQueryError,
} from "../../shared/shelf-query.js";

describe("smart-shelf query codec", () => {
  it("canonicalizes the bounded v1 query and excludes transient state", () => {
    const normalized = normalizeSmartShelfQuery({
      version: 1,
      catalog: { q: "  space opera  ", format: "epub", coverAvailable: false, sort: "updated", order: "desc" },
      personal: { favorite: true },
      kindleStatus: "not-on-kindle",
    });
    const encoded = encodeSmartShelfQuery(normalized);

    expect(encoded).toBe(
      '{"version":1,"catalog":{"q":"space opera","format":"epub","coverAvailable":false,"sort":"updated","order":"desc"},"personal":{"favorite":true},"kindleStatus":"not-on-kindle"}',
    );
    expect(decodeSmartShelfQuery(encoded)).toEqual(normalized);
    expect(smartShelfQueryToBookQuery(normalized)).toEqual({
      q: "space opera",
      format: "epub",
      coverAvailable: false,
      sort: "updated",
      order: "desc",
      favorite: true,
    });
  });

  it.each([
    [{ version: 2 }, "version"],
    [{ version: 1, limit: 20 }, "unsupported field"],
    [{ version: 1, catalog: { offset: 20 } }, "unsupported field"],
    [{ version: 1, catalog: { year: "20xx" } }, "four digits"],
    [{ version: 1, personal: { favorite: "yes" } }, "boolean"],
    [{ version: 1, kindleStatus: "last-seen" }, "kindleStatus"],
  ])("rejects unversioned, transient, or unbounded query input %#", (value, message) => {
    expect(() => normalizeSmartShelfQuery(value)).toThrowError(SmartShelfQueryError);
    expect(() => normalizeSmartShelfQuery(value)).toThrow(String(message));
  });
});
