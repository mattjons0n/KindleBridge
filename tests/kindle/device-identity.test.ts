import { describe, expect, it } from "vitest";
import {
  derivePseudonymousKindleIdentity,
  type KindleIdentitySecretProvider,
} from "../../client/src/kindle/device-identity";

function provider(byte: number): KindleIdentitySecretProvider {
  return {
    async getSecret() {
      return {
        bytes: new Uint8Array(32).fill(byte),
        stability: "installation" as const,
      };
    },
  };
}

describe("pseudonymous Kindle identity", () => {
  it("uses a keyed installation HMAC rather than a plain serial hash", async () => {
    const serial = "MTP-SERIAL-PRIVATE-0042";
    const first = await derivePseudonymousKindleIdentity(serial, 0x1949, 0x9981, provider(1));
    const repeated = await derivePseudonymousKindleIdentity(serial, 0x1949, 0x9981, provider(1));
    const differentInstallation = await derivePseudonymousKindleIdentity(
      serial,
      0x1949,
      0x9981,
      provider(2),
    );

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      key: expect.stringMatching(/^[0-9a-f]{64}$/u),
      stability: "installation",
    });
    expect(first?.key).not.toBe(differentInstallation?.key);
    expect(JSON.stringify(first)).not.toContain(serial);
  });

  it("does not invent an identity when the device exposes no serial", async () => {
    await expect(derivePseudonymousKindleIdentity("", 0x1949, 0x9981, provider(1)))
      .resolves.toBeUndefined();
  });
});
