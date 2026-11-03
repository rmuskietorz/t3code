import { describe, expect, it } from "vite-plus/test";

import {
  areAllDiffFilesCollapsed,
  foldAllDiffFiles,
  foldDiffFile,
  MAX_REMEMBERED_DIFF_FOLD_SCOPES,
  rememberDiffFileFolds,
  resolveCollapsedDiffFileKeys,
} from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("follows the default until the user folds a file", () => {
    expect(resolveCollapsedDiffFileKeys(FILE_KEYS, undefined, true)).toEqual(new Set(FILE_KEYS));
    const folds = foldDiffFile(undefined, FIRST_FILE_KEY, false);
    expect(resolveCollapsedDiffFileKeys(FILE_KEYS, folds, true)).toEqual(new Set(["src/index.ts"]));
  });

  it("applies collapse all to files that appear later, but keeps later single folds", () => {
    const folds = foldDiffFile(foldAllDiffFiles(false), FIRST_FILE_KEY, true);
    expect(resolveCollapsedDiffFileKeys([...FILE_KEYS, "src/new.ts"], folds, true)).toEqual(
      new Set([FIRST_FILE_KEY]),
    );
  });

  it("keeps the most recently used scopes", () => {
    let foldsByScope = {};
    for (let index = 0; index <= MAX_REMEMBERED_DIFF_FOLD_SCOPES; index++) {
      foldsByScope = rememberDiffFileFolds(foldsByScope, `scope-${index}`, foldAllDiffFiles(true));
    }
    foldsByScope = rememberDiffFileFolds(foldsByScope, "scope-1", foldAllDiffFiles(false));
    foldsByScope = rememberDiffFileFolds(foldsByScope, "scope-new", foldAllDiffFiles(true));

    const scopes = Object.keys(foldsByScope);
    expect(scopes).toHaveLength(MAX_REMEMBERED_DIFF_FOLD_SCOPES);
    expect(scopes).not.toContain("scope-0");
    expect(scopes).not.toContain("scope-2");
    expect(scopes.slice(-2)).toEqual(["scope-1", "scope-new"]);
  });
});
