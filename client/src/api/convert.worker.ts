import initBoko, { book_info, convert } from "../../vendor/boko/boko.js";
import type { BookMetadata } from "./convert";
import { prepareKindleSideload } from "./azw3-sideload";
import { MAX_KINDLE_ARTIFACT_BYTES } from "../book-limits";

interface ConversionRequest {
  readonly input: ArrayBuffer;
  readonly overridesApplied?: boolean;
}

interface WorkerScope extends EventTarget {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;

workerScope.addEventListener("message", (rawEvent) => {
  const event = rawEvent as MessageEvent<ConversionRequest>;
  void (async () => {
    try {
      await initBoko();
      const input = new Uint8Array(event.data.input);
      const metadata = JSON.parse(String(book_info(input, "epub"))) as BookMetadata;
      const converted = convert(input, "epub", "azw3");
      if (converted.byteLength > MAX_KINDLE_ARTIFACT_BYTES) {
        workerScope.postMessage({
          type: "error",
          code: "CONVERSION_OUTPUT_TOO_LARGE",
          message: "The converted Kindle artifact exceeds the 200 MB browser limit",
          details: { outputBytes: converted.byteLength, maximumBytes: MAX_KINDLE_ARTIFACT_BYTES },
        });
        return;
      }
      const prepared = prepareKindleSideload(converted);
      if (prepared.bytes.byteLength > MAX_KINDLE_ARTIFACT_BYTES) {
        workerScope.postMessage({
          type: "error",
          code: "CONVERSION_OUTPUT_TOO_LARGE",
          message: "The prepared Kindle artifact exceeds the 200 MB browser limit",
          details: { outputBytes: prepared.bytes.byteLength, maximumBytes: MAX_KINDLE_ARTIFACT_BYTES },
        });
        return;
      }
      const transferable = prepared.bytes.buffer.slice(
        prepared.bytes.byteOffset,
        prepared.bytes.byteOffset + prepared.bytes.byteLength,
      ) as ArrayBuffer;
      workerScope.postMessage({
        type: "success",
        output: transferable,
        metadata,
        kindleDocumentType: prepared.metadata.documentType,
        embeddedCover: prepared.metadata.embeddedCover,
        overridesApplied: event.data.overridesApplied === true,
      }, [transferable]);
    } catch (error) {
      workerScope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
