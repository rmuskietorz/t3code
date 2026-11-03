import * as Schema from "effect/Schema";

export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

// "Collapse/expand all" is stored as one flag instead of one entry per file, so a
// large diff does not grow the stored state by its file count.
const DiffFileFolds = Schema.Struct({
  all: Schema.optionalKey(Schema.Boolean),
  files: Schema.Record(Schema.String, Schema.Boolean),
});
export type DiffFileFolds = typeof DiffFileFolds.Type;

export const DiffFileFoldsByScope = Schema.Record(Schema.String, DiffFileFolds);
export type DiffFileFoldsByScope = typeof DiffFileFoldsByScope.Type;

// Every thread and turn a user has opened gets a scope; keep only the recent ones.
export const MAX_REMEMBERED_DIFF_FOLD_SCOPES = 200;

export function isDiffFileCollapsed(
  folds: DiffFileFolds | undefined,
  fileKey: string,
  collapsedByDefault: boolean,
): boolean {
  return folds?.files[fileKey] ?? folds?.all ?? collapsedByDefault;
}

export function resolveCollapsedDiffFileKeys(
  fileKeys: ReadonlyArray<string>,
  folds: DiffFileFolds | undefined,
  collapsedByDefault: boolean,
): ReadonlySet<string> {
  return new Set(
    fileKeys.filter((fileKey) => isDiffFileCollapsed(folds, fileKey, collapsedByDefault)),
  );
}

export function foldDiffFile(
  folds: DiffFileFolds | undefined,
  fileKey: string,
  collapsed: boolean,
): DiffFileFolds {
  return { ...folds, files: { ...folds?.files, [fileKey]: collapsed } };
}

export function foldAllDiffFiles(collapsed: boolean): DiffFileFolds {
  return { all: collapsed, files: {} };
}

/** Stores a scope's folds as the most recent one and drops the oldest past the limit. */
export function rememberDiffFileFolds(
  foldsByScope: DiffFileFoldsByScope,
  scopeKey: string,
  folds: DiffFileFolds,
): DiffFileFoldsByScope {
  const { [scopeKey]: _previous, ...others } = foldsByScope;
  const kept = Object.entries(others).slice(-(MAX_REMEMBERED_DIFF_FOLD_SCOPES - 1));
  return { ...Object.fromEntries(kept), [scopeKey]: folds };
}
