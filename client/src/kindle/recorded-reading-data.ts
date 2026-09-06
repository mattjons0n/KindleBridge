import { decodeKindleKrdsDiagnostic, type KindleKrdsReadingParserOptions } from "./krds-reading-state";

/** Observations only: never input to matching, removal, progress, or Read-books membership. */
export interface KindleRecordedReadingFile {
  readonly filename: string;
  readonly size: number;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  readonly technical?: string;
  readonly technicalTruncated?: boolean;
  readonly error?: string;
}

export function parseRecordedKindleReadingFile(
  bytes: Uint8Array,
  filename: string,
  options: KindleKrdsReadingParserOptions = {},
): KindleRecordedReadingFile {
  const values = decodeKindleKrdsDiagnostic(bytes, options);
  const fields: { label: string; value: string }[] = [];
  const field = (label: string, value: string | undefined): void => {
    if (value !== undefined) fields.push({ label, value: value.length > 512 ? `${value.slice(0, 512)}…` : value });
  };
  const scalar = (value: (typeof values)[number] | undefined): string | undefined => value && value.kind !== "object" ? String(value.value) : undefined;
  for (const object of values) {
    if (object.kind !== "object") continue;
    const data = object.values;
    if (object.name === "timer.model") {
      field("Timer structure version", scalar(data[0]));
      if (data[1]?.kind === "long" && data[1].value >= 0n) {
        const seconds = data[1].value / 1000n;
        field("Recorded reading time", `${seconds / 3600n} h ${(seconds / 60n) % 60n} min ${seconds % 60n} s`);
      }
      field("Counted words", scalar(data[2]));
      if (data[3]?.kind === "double") field("Timer activity fraction (not completion)", String(data[3].value));
    }
    if (["lpr", "updated_lpr", "fpr"].includes(object.name)) {
      const offset = object.name === "lpr" && data[0]?.kind !== "string" ? 1 : 0;
      field(object.name === "fpr" ? "Furthest saved position" : "Last saved position", scalar(data[offset]));
      const time = data[offset + 1];
      if (time?.kind === "long" && time.value >= 0n && time.value <= 253_402_300_799_999n) {
        field(object.name === "fpr" ? "Furthest-position timestamp" : "Last-read timestamp", new Date(Number(time.value)).toISOString());
      }
    }
    if (object.name === "book.info.store") {
      field("Recorded book word count", scalar(data[0]));
      field("Word-count coverage fraction", scalar(data[1]));
    }
    if (object.name === "page.history.store") field("Recorded page-history entries", scalar(data[0]));
    if (object.name === "annotation.cache.object") field("Annotation data", data.length ? "Present — see technical details" : "Empty");
    if (object.name === "font.prefs") field("Reader preferences", "Present — see technical details");
    if (object.name === "apnx.key") field("Page-number mapping", "Present — see technical details");
    if (object.name === "EndActions") field("End-actions record", "Present (does not establish Read status)");
  }
  const technical = JSON.stringify(values, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2);
  return Object.freeze({ filename, size: bytes.length, fields: Object.freeze(fields),
    technical: technical.slice(0, 16_384), technicalTruncated: technical.length > 16_384 });
}
