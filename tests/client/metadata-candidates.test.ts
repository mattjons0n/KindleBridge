import { describe, expect, it } from "vitest";
import {
  buildMetadataCandidateDiff,
  missingMetadataCandidateFields,
  reviewedMetadataCandidateFields,
  selectedMetadataCandidateOverrides,
  validateCatalogMetadataCandidate,
  type CatalogMetadataCandidate,
} from "../../client/src/metadata-candidates";
import type { EditableBookMetadata } from "../../client/src/catalog-client";

const source: EditableBookMetadata = {
  title: "Source title",
  authors: ["Source author"],
  authorSort: "Author, Source",
  language: "en",
  publisher: null,
  publishedAt: null,
  series: null,
  seriesIndex: null,
  description: null,
  subjects: [],
  identifiers: [],
};

const candidate: CatalogMetadataCandidate = {
  provider: "google-books",
  candidateId: "volume-one",
  confidence: "high",
  metadata: {
    title: "Corrected title",
    authors: ["Correct Author"],
    publisher: "Publisher",
    subjects: ["Fiction"],
  },
};

describe("metadata provider candidate review", () => {
  const hardcover: CatalogMetadataCandidate = {
    provider: "hardcover", candidateId: "hc:42:7", confidence: "high",
    metadata: { title: source.title, authors: source.authors, series: "A series", seriesIndex: 1.5 },
  };

  it("accepts fractional Hardcover series and selects gaps without replacing an existing or explicitly cleared choice", () => {
    expect(validateCatalogMetadataCandidate(hardcover)).toEqual(hardcover);
    expect([...missingMetadataCandidateFields(source, {}, hardcover)]).toEqual(["series", "seriesIndex"]);
    expect([...missingMetadataCandidateFields(source, { series: null }, hardcover)]).toEqual([]);
    expect([...missingMetadataCandidateFields(source, { seriesIndex: null }, hardcover)]).toEqual([]);
    expect([...missingMetadataCandidateFields({ ...source, series: "Other series" }, {}, hardcover)]).toEqual([]);
    expect([...missingMetadataCandidateFields({ ...source, series: "A series" }, {}, hardcover)]).toEqual(["seriesIndex"]);
    expect([...missingMetadataCandidateFields({ ...source, seriesIndex: 3 }, {}, hardcover)]).toEqual([]);
  });

  it("changes a Hardcover series and its volume as one explicit reviewed choice", () => {
    expect([...reviewedMetadataCandidateFields(source, hardcover, new Set(), "series", true)]).toEqual(["series", "seriesIndex"]);
    expect([...reviewedMetadataCandidateFields(source, hardcover, new Set(["series", "seriesIndex"]), "seriesIndex", false)]).toEqual([]);
    expect([...reviewedMetadataCandidateFields({ ...source, series: "A series" }, hardcover, new Set(), "seriesIndex", true)]).toEqual(["seriesIndex"]);
  });

  it("shows field-by-field source/current/candidate values without preselecting fields", () => {
    const current = { ...source, title: "Current override" };
    expect(buildMetadataCandidateDiff(source, current, candidate)).toEqual([
      { field: "title", sourceValue: "Source title", currentValue: "Current override", candidateValue: "Corrected title", changed: true },
      { field: "authors", sourceValue: ["Source author"], currentValue: ["Source author"], candidateValue: ["Correct Author"], changed: true },
      { field: "publisher", sourceValue: null, currentValue: null, candidateValue: "Publisher", changed: true },
      { field: "subjects", sourceValue: [], currentValue: [], candidateValue: ["Fiction"], changed: true },
    ]);
    expect(selectedMetadataCandidateOverrides(candidate, new Set())).toEqual({});
  });

  it("applies only explicitly selected bounded fields", () => {
    expect(selectedMetadataCandidateOverrides(candidate, new Set(["title", "subjects"]))).toEqual({
      title: "Corrected title",
      subjects: ["Fiction"],
    });
  });

  it("rejects malformed provider candidates and oversized values", () => {
    expect(validateCatalogMetadataCandidate(candidate)).toEqual(candidate);
    expect(validateCatalogMetadataCandidate({ ...candidate, provider: "arbitrary-url" })).toBeUndefined();
    expect(validateCatalogMetadataCandidate({ ...candidate, metadata: { description: "x".repeat(20_001) } })).toBeUndefined();
    expect(validateCatalogMetadataCandidate({ ...candidate, metadata: {} })).toBeUndefined();
  });
});
