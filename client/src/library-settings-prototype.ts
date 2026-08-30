import type {
  CatalogProfile,
  CatalogRoot,
  CatalogRootStatus,
  CreateCatalogProfileInput,
  CreateCatalogRootInput,
} from "./catalog-client";

export interface LibraryFolderDraft {
  readonly id: string;
  readonly persisted: boolean;
  readonly label: string;
  readonly path: string;
  readonly includeSubfolders: boolean;
  readonly enabled: boolean;
  readonly watchForChanges: boolean;
  readonly sentinel: string;
  /** Opaque server-provisioned guard. The browser preserves but does not edit it. */
  readonly mountIdentity?: string;
  readonly status: CatalogRootStatus;
  readonly lastScanAt?: string;
  readonly lastErrorCode?: string;
}

export interface LibrarySettingsDraft {
  readonly id: string;
  readonly persisted: boolean;
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly sourceLabel: string;
  readonly enabled: boolean;
  readonly folders: readonly LibraryFolderDraft[];
  readonly originalRootIds: readonly string[];
}

// Compatibility aliases keep the rendering layer's historic module boundary
// while the data now comes from the catalog API rather than sample constants.
export type PrototypeLibraryFolder = LibraryFolderDraft;
export type PrototypeLibraryConfig = LibrarySettingsDraft;

let draftSequence = 0;

function nextDraftId(prefix: string): string {
  draftSequence += 1;
  return `draft-${prefix}-${draftSequence}`;
}

function folderFromRoot(root: CatalogRoot): LibraryFolderDraft {
  return {
    id: root.id,
    persisted: true,
    label: root.label,
    path: root.path,
    includeSubfolders: root.recursive,
    enabled: root.enabled,
    watchForChanges: root.watch,
    sentinel: root.sentinel ?? "",
    mountIdentity: root.mountIdentity,
    status: root.status,
    lastScanAt: root.lastScanAt,
    lastErrorCode: root.lastErrorCode,
  };
}

export function settingsDraftFromProfile(
  profile: CatalogProfile,
  roots: readonly CatalogRoot[],
): LibrarySettingsDraft {
  return {
    id: profile.id,
    persisted: true,
    name: profile.name,
    description: profile.description,
    initial: profile.initial,
    sourceLabel: profile.sourceLabel,
    enabled: profile.enabled,
    folders: roots.map(folderFromRoot),
    originalRootIds: roots.map((root) => root.id),
  };
}

export function createPrototypeLibrary(): LibrarySettingsDraft {
  const id = nextDraftId("library");
  return {
    id,
    persisted: false,
    name: "New library",
    description: "Household collection",
    initial: "N",
    sourceLabel: "Folder not set",
    enabled: true,
    folders: [createPrototypeFolder([], id)],
    originalRootIds: [],
  };
}

export function createPrototypeFolder(
  folders: readonly LibraryFolderDraft[],
  libraryId: string,
): LibraryFolderDraft {
  return {
    id: `${libraryId}-${nextDraftId("folder")}`,
    persisted: false,
    label: `Folder ${folders.length + 1}`,
    path: "",
    includeSubfolders: true,
    enabled: true,
    watchForChanges: true,
    sentinel: "",
    mountIdentity: undefined,
    status: "unknown",
  };
}

export function isValidContainerPath(path: string): boolean {
  const value = path.trim();
  return value.startsWith("/")
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/(?:^|\/)\.\.(?:\/|$)/u.test(value)
    && !/^\/\//u.test(value);
}

export function normalizeContainerPath(path: string): string {
  return path.trim().replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
}

export function librarySourceLabel(library: Pick<LibrarySettingsDraft, "folders">): string {
  const firstEnabled = library.folders.find((folder) => folder.enabled && folder.path.trim());
  if (!firstEnabled) return "Folder not set";
  if (firstEnabled.label.trim()) return firstEnabled.label.trim();
  return firstEnabled.path.trim().split("/").filter(Boolean).at(-1) ?? "Library folder";
}

export function normalizeLibraryDraft(draft: LibrarySettingsDraft): LibrarySettingsDraft {
  const name = draft.name.trim();
  const folders = draft.folders.map((folder, index) => ({
    ...folder,
    label: folder.label.trim() || `Folder ${index + 1}`,
    path: normalizeContainerPath(folder.path),
    sentinel: folder.sentinel.trim(),
  }));
  return {
    ...draft,
    name,
    initial: name.slice(0, 1).toLocaleUpperCase() || "L",
    sourceLabel: librarySourceLabel({ folders }),
    folders,
  };
}

export function validateLibraryDraft(
  library: LibrarySettingsDraft,
  profiles: readonly CatalogProfile[],
): string | undefined {
  const name = library.name.trim();
  if (!name) return "Enter a display name.";
  if (name.length > 50) return "Use 50 characters or fewer for the display name.";
  if (profiles.some((candidate) => candidate.id !== library.id && candidate.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return `A library named “${name}” already exists.`;
  }
  if (library.folders.length === 0) return "Add at least one folder.";

  const normalizedPaths = new Set<string>();
  for (const folder of library.folders) {
    const path = folder.path.trim();
    if (!path) return "Enter a container folder path for every configured folder.";
    if (/(?:^|\/)\.\.(?:\/|$)/u.test(path)) return "Parent-directory segments are not allowed in container folder paths.";
    if (!isValidContainerPath(path)) return "Enter an absolute container path beginning with /.";
    if (path.length > 1_024) return "Use container folder paths of 1,024 characters or fewer.";
    const normalized = normalizeContainerPath(path);
    if (normalizedPaths.has(normalized)) return "The same container folder is configured more than once in this library.";
    normalizedPaths.add(normalized);
    const sentinel = folder.sentinel.trim();
    if (
      sentinel
      && (sentinel.length > 1_024
        || sentinel.startsWith("/")
        || /[\u0000-\u001f\u007f]/u.test(sentinel)
        || sentinel.split(/[\\/]+/u).some((part) => part === ".."))
    ) {
      return "Use a safe relative sentinel file path without parent-directory segments.";
    }
  }
  return undefined;
}

export function profileInput(draft: LibrarySettingsDraft): CreateCatalogProfileInput {
  return { name: draft.name, description: draft.description, enabled: draft.enabled };
}

export function rootInput(folder: LibraryFolderDraft): CreateCatalogRootInput {
  return {
    label: folder.label,
    path: folder.path,
    recursive: folder.includeSubfolders,
    watch: folder.watchForChanges,
    enabled: folder.enabled,
    sentinel: folder.sentinel || null,
    mountIdentity: folder.mountIdentity ?? null,
  };
}
