import { describe, expect, it } from "vitest";
import { AppError, toAppError } from "../../client/src/app-error";
import { DebugLog } from "../../client/src/log";

describe("DebugLog", () => {
  it("masks serial-number values before retaining or formatting them", () => {
    const log = new DebugLog();
    log.info("Device selected", { serialNumber: "ABCDEFGHIJK", vendorId: 0x1949 });

    expect(log.entries[0]?.context).toEqual({ serialNumber: "••••HIJK", vendorId: 0x1949 });
    expect(log.format()).not.toContain("ABCDEFGHIJK");
    expect(log.format()).toContain("••••HIJK");
  });

  it("sanitizes nested serials, diagnostic text, cycles, and bigint values", () => {
    const log = new DebugLog();
    const nested: Record<string, unknown> = {
      usb: { serialNumber: "NESTED-SECRET-5678" },
      diagnostics: { stderr: "book metadata and converter output" },
      capacityBytes: 32_000_000_000n,
    };
    nested.self = nested;

    log.error("bounded context", nested);

    const formatted = log.format();
    expect(formatted).toContain("••••5678");
    expect(formatted).not.toContain("NESTED-SECRET-5678");
    expect(formatted).not.toContain("book metadata and converter output");
    expect(formatted).toContain("redacted diagnostic text");
    expect(formatted).toContain("32000000000");
    expect(formatted).toContain("[Circular]");
  });

  it("caps retained entries", () => {
    const log = new DebugLog();
    for (let index = 0; index < 520; index += 1) log.info(`entry-${index}`);

    expect(log.entries).toHaveLength(500);
    expect(log.entries[0]?.message).toBe("entry-20");
    expect(log.entries.at(-1)?.message).toBe("entry-519");
  });
});

describe("toAppError", () => {
  it("preserves structured application errors", () => {
    const error = new AppError("MTP_INVALID_CONTAINER", "bad packet");
    expect(toAppError(error)).toBe(error);
  });

  it("maps a cancelled device chooser to a stable code", () => {
    const result = toAppError(new DOMException("cancelled", "NotFoundError"));
    expect(result.code).toBe("USB_PERMISSION_CANCELLED");
  });
});
