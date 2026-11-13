import { describe, expect, it } from "@effect/vitest";

import { isReleaseBranchName, pickLatestReleaseBranch } from "./latestReleaseBranch.ts";

describe("pickLatestReleaseBranch", () => {
  it("compares versions numerically, not as text", () => {
    expect(
      pickLatestReleaseBranch([
        "master",
        "release_v1.3.9",
        "release_v1.3.10",
        "release_v1.2.20",
        "RM/fix-preloader",
      ]),
    ).toBe("release_v1.3.10");
  });

  it("treats a missing version part as zero", () => {
    expect(pickLatestReleaseBranch(["release/2", "release/2.0.1", "rc-1.9"])).toBe("release/2.0.1");
  });

  it("returns null when the repository has no release branch", () => {
    expect(pickLatestReleaseBranch(["main", "feature/release-notes", "releases"])).toBeNull();
  });
});

describe("isReleaseBranchName", () => {
  it("accepts the common release naming styles", () => {
    expect(isReleaseBranchName("release_v1.3.6")).toBe(true);
    expect(isReleaseBranchName("release-2.0")).toBe(true);
    expect(isReleaseBranchName("RC/1.4")).toBe(true);
    expect(isReleaseBranchName("RM/release_v1.3.6")).toBe(false);
  });
});
