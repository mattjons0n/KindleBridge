import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type PolicyErrorCode =
  | "path_not_absolute"
  | "path_not_allowed"
  | "path_unavailable"
  | "permission_denied"
  | "path_not_directory"
  | "source_not_file"
  | "source_escaped_root"
  | "invalid_relative_path";

export class RootPolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RootPolicyError";
  }
}

export interface ValidatedRoot {
  absolutePath: string;
  realPath: string | null;
  available: boolean;
}

export interface ValidatedSource {
  absolutePath: string;
  realPath: string;
  rootRealPath: string;
}

interface AllowedBase {
  configuredPath: string;
  realPath: string;
}

export interface AllowedRootPolicyCreateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const DEFAULT_ROOT_POLICY_VALIDATION_TIMEOUT_MS = 10_000;

class RootPolicyOperationAbortError extends Error {
  constructor() {
    super("Allowed-root validation was interrupted.");
    this.name = "RootPolicyOperationAbortError";
  }
}

function containedBy(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function unavailable(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function denied(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}

export class AllowedRootPolicy {
  private constructor(private readonly allowedBases: readonly AllowedBase[]) {}

  static async create(
    allowedPaths: readonly string[],
    options: AllowedRootPolicyCreateOptions = {},
  ): Promise<AllowedRootPolicy> {
    if (allowedPaths.length === 0) {
      throw new RootPolicyError("path_not_allowed", "At least one allowed container root must be configured.");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_ROOT_POLICY_VALIDATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Allowed-root validation timeout must be a positive integer.");
    }
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new RootPolicyOperationAbortError()),
      timeoutMs,
    );
    timer.unref();
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const bases: AllowedBase[] = [];
    try {
      for (const input of allowedPaths) {
        if (input.includes("\0") || !path.isAbsolute(input)) {
          throw new RootPolicyError("path_not_absolute", "Allowed container roots must be absolute paths.");
        }
        const configuredPath = path.resolve(input);
        let canonical: string;
        try {
          throwIfRootPolicyOperationAborted(signal);
          canonical = await abortableRootPolicyOperation(realpath(configuredPath), signal);
          const details = await abortableRootPolicyOperation(stat(canonical), signal);
          if (!details.isDirectory()) {
            throw new RootPolicyError("path_not_directory", "An allowed container root is not a directory.");
          }
        } catch (error) {
          if (error instanceof RootPolicyError) {
            throw error;
          }
          if (error instanceof RootPolicyOperationAbortError || signal.aborted) {
            throw new RootPolicyError(
              "path_unavailable",
              options.signal?.aborted
                ? "Allowed container-root validation was cancelled."
                : "Allowed container-root validation timed out.",
            );
          }
          throw new RootPolicyError(
            denied(error) ? "permission_denied" : "path_unavailable",
            denied(error) ? "An allowed container root cannot be read." : "An allowed container root is unavailable.",
          );
        }
        if (!bases.some((base) => base.configuredPath === configuredPath && base.realPath === canonical)) {
          bases.push({ configuredPath, realPath: canonical });
        }
      }
      return new AllowedRootPolicy(bases);
    } finally {
      clearTimeout(timer);
    }
  }

  describeAllowedRoots(): string[] {
    return this.allowedBases.map((base) => base.configuredPath);
  }

  async validateConfiguredRoot(input: string, allowUnavailable = true): Promise<ValidatedRoot> {
    if (input.includes("\0") || !path.isAbsolute(input)) {
      throw new RootPolicyError("path_not_absolute", "Source roots must be absolute container paths.");
    }
    const absolutePath = path.resolve(input);
    const lexicallyAllowed = this.allowedBases.some(
      (base) => containedBy(base.configuredPath, absolutePath) || containedBy(base.realPath, absolutePath),
    );
    if (!lexicallyAllowed) {
      throw new RootPolicyError("path_not_allowed", "The source root is outside the allowed container roots.");
    }
    try {
      const canonical = await realpath(absolutePath);
      if (!this.allowedBases.some((base) => containedBy(base.realPath, canonical))) {
        throw new RootPolicyError("path_not_allowed", "The source root resolves outside the allowed container roots.");
      }
      const details = await stat(canonical);
      if (!details.isDirectory()) {
        throw new RootPolicyError("path_not_directory", "The source root is not a directory.");
      }
      return { absolutePath, realPath: canonical, available: true };
    } catch (error) {
      if (error instanceof RootPolicyError) {
        throw error;
      }
      if (allowUnavailable && unavailable(error)) {
        return { absolutePath, realPath: null, available: false };
      }
      if (denied(error)) {
        throw new RootPolicyError("permission_denied", "The source root cannot be read.");
      }
      throw new RootPolicyError("path_unavailable", "The source root is unavailable.");
    }
  }

  async resolveSource(rootPath: string, relativePath: string): Promise<ValidatedSource> {
    if (
      relativePath.length === 0 ||
      relativePath.includes("\0") ||
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]+/u).some((part) => part === "..")
    ) {
      throw new RootPolicyError("invalid_relative_path", "The stored source path is invalid.");
    }
    const root = await this.validateConfiguredRoot(rootPath, false);
    const rootRealPath = root.realPath as string;
    const lexicalCandidate = path.resolve(root.absolutePath, relativePath);
    if (!containedBy(root.absolutePath, lexicalCandidate)) {
      throw new RootPolicyError("source_escaped_root", "The source path escapes its configured root.");
    }
    try {
      const canonical = await realpath(lexicalCandidate);
      if (
        !containedBy(rootRealPath, canonical) ||
        !this.allowedBases.some((base) => containedBy(base.realPath, canonical))
      ) {
        throw new RootPolicyError("source_escaped_root", "The source resolves outside its configured root.");
      }
      const details = await stat(canonical);
      if (!details.isFile()) {
        throw new RootPolicyError("source_not_file", "The source is not a regular file.");
      }
      return { absolutePath: lexicalCandidate, realPath: canonical, rootRealPath };
    } catch (error) {
      if (error instanceof RootPolicyError) {
        throw error;
      }
      if (unavailable(error)) {
        throw new RootPolicyError("path_unavailable", "The source is unavailable.");
      }
      if (denied(error)) {
        throw new RootPolicyError("permission_denied", "The source cannot be read.");
      }
      throw new RootPolicyError("source_not_file", "The source cannot be opened safely.");
    }
  }

  async assertDirectoryInsideRoot(rootPath: string, candidatePath: string): Promise<string> {
    const root = await this.validateConfiguredRoot(rootPath, false);
    const rootRealPath = root.realPath as string;
    try {
      const candidateRealPath = await realpath(candidatePath);
      if (!containedBy(rootRealPath, candidateRealPath)) {
        throw new RootPolicyError("source_escaped_root", "A directory resolves outside its configured root.");
      }
      const details = await lstat(candidateRealPath);
      if (!details.isDirectory()) {
        throw new RootPolicyError("path_not_directory", "A catalog path is not a directory.");
      }
      return candidateRealPath;
    } catch (error) {
      if (error instanceof RootPolicyError) {
        throw error;
      }
      throw new RootPolicyError(
        denied(error) ? "permission_denied" : "path_unavailable",
        denied(error) ? "A catalog directory cannot be read." : "A catalog directory is unavailable.",
      );
    }
  }
}

function throwIfRootPolicyOperationAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RootPolicyOperationAbortError();
}

function abortableRootPolicyOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(new RootPolicyOperationAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const abort = (): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      reject(new RootPolicyOperationAbortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
