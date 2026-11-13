// Release candidates are branches such as `release_v1.3.6`, `release/2.0` or `rc-1.4`.
const RELEASE_BRANCH_PATTERN = /^(?:release|rc)[-_/]?v?(\d+(?:\.\d+)*)$/i;

function parseReleaseVersion(branchName: string): ReadonlyArray<number> | null {
  const match = RELEASE_BRANCH_PATTERN.exec(branchName);
  return match?.[1] ? match[1].split(".").map(Number) : null;
}

function compareVersions(left: ReadonlyArray<number>, right: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isReleaseBranchName(branchName: string): boolean {
  return parseReleaseVersion(branchName) !== null;
}

/**
 * Picks the highest-versioned release branch. `branchNames` are local names and
 * remote names with their remote prefix already removed.
 */
export function pickLatestReleaseBranch(branchNames: ReadonlyArray<string>): string | null {
  let latest: { readonly name: string; readonly version: ReadonlyArray<number> } | null = null;
  for (const name of branchNames) {
    const version = parseReleaseVersion(name);
    if (version === null) continue;
    if (latest === null || compareVersions(version, latest.version) > 0) {
      latest = { name, version };
    }
  }
  return latest?.name ?? null;
}
