import { describe, expectTypeOf, it } from "vitest";
import type { KindleObjectStore } from "../../client/src/kindle/contracts";
import type { MtpObjectStore } from "../../client/src/mtp/object-store";
import type { MtpBulkTransport } from "../../client/src/mtp/session";
import type { UsbBulkTransport } from "../../client/src/usb/types";

describe("MTP integration contracts", () => {
  it("remains structurally compatible with the USB and Kindle layers", () => {
    expectTypeOf<UsbBulkTransport>().toMatchTypeOf<MtpBulkTransport>();
    expectTypeOf<MtpObjectStore>().toMatchTypeOf<KindleObjectStore>();
  });
});
