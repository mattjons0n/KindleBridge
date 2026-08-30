const INSTALLATION_SECRET_STORAGE_KEY = "kindle-bridge:device-hmac-secret:v1";
const SECRET_BYTES = 32;

export type KindleIdentityStability = "installation" | "session";

export interface KindleIdentitySecret {
  readonly bytes: Uint8Array;
  readonly stability: KindleIdentityStability;
}

export interface KindleIdentitySecretProvider {
  getSecret(): Promise<KindleIdentitySecret | undefined>;
}

export interface PseudonymousKindleIdentity {
  readonly key: string;
  readonly stability: KindleIdentityStability;
}

let sessionSecret: Uint8Array | undefined;

function randomSecret(): Uint8Array | undefined {
  if (!globalThis.crypto?.getRandomValues) return undefined;
  return globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

function secretToHex(secret: Uint8Array): string {
  return Array.from(secret, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secretFromHex(value: string | null): Uint8Array | undefined {
  if (!value || !/^[0-9a-f]{64}$/iu.test(value)) return undefined;
  return Uint8Array.from(
    value.match(/../gu) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

async function defaultSecret(): Promise<KindleIdentitySecret | undefined> {
  const storage = browserStorage();
  if (storage) {
    try {
      const existing = secretFromHex(storage.getItem(INSTALLATION_SECRET_STORAGE_KEY));
      if (existing) return { bytes: existing, stability: "installation" };
      const generated = randomSecret();
      if (!generated) return undefined;
      const encoded = secretToHex(generated);
      storage.setItem(INSTALLATION_SECRET_STORAGE_KEY, encoded);
      if (storage.getItem(INSTALLATION_SECRET_STORAGE_KEY) === encoded) {
        return { bytes: generated, stability: "installation" };
      }
    } catch {
      // Privacy-preserving session identity remains available if storage is blocked.
    }
  }
  sessionSecret ??= randomSecret();
  return sessionSecret ? { bytes: sessionSecret.slice(), stability: "session" } : undefined;
}

export const kindleIdentitySecretProvider: KindleIdentitySecretProvider = Object.freeze({
  getSecret: defaultSecret,
});

/**
 * Produces a non-reversible device key using a random browser-installation
 * secret. Raw serials are used only as transient HMAC input and are not stored.
 */
export async function derivePseudonymousKindleIdentity(
  serialNumber: string | undefined,
  vendorId: number,
  productId: number,
  provider: KindleIdentitySecretProvider = kindleIdentitySecretProvider,
): Promise<PseudonymousKindleIdentity | undefined> {
  const serial = serialNumber?.trim();
  if (!serial || !globalThis.crypto?.subtle) return undefined;
  const secret = await provider.getSecret();
  if (!secret || secret.bytes.byteLength !== SECRET_BYTES) return undefined;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.bytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const material = new TextEncoder().encode(
    `kindle-device-identity-v2\u0000${vendorId}\u0000${productId}\u0000${serial}`,
  );
  const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, material));
  return {
    key: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    stability: secret.stability,
  };
}
