export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
export default function init(moduleOrPath?: InitInput): Promise<WebAssembly.Exports>;
export function convert(data: Uint8Array, from: string, to: string): Uint8Array;
export function book_info(data: Uint8Array, from: string): unknown;
