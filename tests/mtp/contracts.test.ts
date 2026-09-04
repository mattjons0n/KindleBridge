import { describe, expect, expectTypeOf, it } from "vitest";
import type { KindleObjectStore } from "../../client/src/kindle/contracts";
import { MtpOperationCode } from "../../client/src/mtp/constants";
import type { MtpObjectStore } from "../../client/src/mtp/object-store";
import type { MtpBulkTransport } from "../../client/src/mtp/session";
import type { UsbBulkTransport } from "../../client/src/usb/types";

describe("MTP integration contracts", () => {
  it("remains structurally compatible with the USB and Kindle layers", () => {
    expectTypeOf<UsbBulkTransport>().toMatchTypeOf<MtpBulkTransport>();
    expectTypeOf<MtpObjectStore>().toMatchTypeOf<KindleObjectStore>();
  });

  it("exposes only the bounded partial-read opcode and keeps GetObjectPropList forbidden", () => {
    expect(MtpOperationCode.GetPartialObject).toBe(0x101b);
    expect(Object.prototype.hasOwnProperty.call(MtpOperationCode, "GetObjectPropList")).toBe(false);
    expect(Object.values(MtpOperationCode)).not.toContain(0x9805);
  });
});
