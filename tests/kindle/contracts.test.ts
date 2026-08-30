import { expectTypeOf, it } from "vitest";
import type { KindleObjectStore } from "../../client/src/kindle/contracts";
import type { MtpObjectStore } from "../../client/src/mtp/object-store";

it("accepts the concrete MTP object store without an adapter", () => {
  expectTypeOf<MtpObjectStore>().toMatchTypeOf<KindleObjectStore>();
});
