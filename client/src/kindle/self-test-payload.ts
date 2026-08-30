const PREFIX = new TextEncoder().encode(
  "Kindle WebUSB POC exact-byte test\nUTF-8: caf\u00e9 \u2014 \u65e5\u672c\u8a9e\n",
);

/**
 * The 1,012-byte payload plus the 12-byte MTP data-container header is exactly
 * 1,024 bytes: a multiple of both common 64- and 512-byte bulk packet sizes.
 * This forces the real device test to exercise the terminating-ZLP path in
 * both directions. NULs and every byte value also catch encoding corruption.
 */
export const KINDLE_SELF_TEST_PAYLOAD: Uint8Array = (() => {
  const payload = new Uint8Array(1_012);
  payload.set(PREFIX);
  for (let index = PREFIX.byteLength; index < payload.byteLength; index += 1) {
    payload[index] = (index * 73 + 19) & 0xff;
  }
  payload[63] = 0;
  payload[64] = 0xff;
  payload[511] = 0;
  payload[512] = 0xff;
  payload[payload.byteLength - 1] = 0;
  return payload;
})();
