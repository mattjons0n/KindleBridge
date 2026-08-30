class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.#values.set(String(key), String(value));
  }
}

// Node 26 exposes an incomplete experimental Storage global that can shadow
// jsdom's origin-scoped implementation. Browser-facing tests need deterministic
// Storage semantics, not filesystem persistence.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
}
