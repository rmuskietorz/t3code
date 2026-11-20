import * as Schema from "effect/Schema";

import { readLocalApi } from "~/localApi";
import { toastManager } from "./ui/toast";

// This fork tracks the original project; it should say when a stable release
// there has not been merged into the fork's main branch yet.
const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const FORK_OWNER = "rmuskietorz";
const FORK_BRANCH = "main";

const LatestRelease = Schema.Struct({ tag_name: Schema.String });
const Comparison = Schema.Struct({
  status: Schema.Literals(["ahead", "behind", "identical", "diverged"]),
});

const decodeLatestRelease = Schema.decodeUnknownPromise(LatestRelease);
const decodeComparison = Schema.decodeUnknownPromise(Comparison);

async function fetchGitHubJson(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
  return response.json();
}

async function findUnmergedUpstreamRelease(): Promise<string | null> {
  const release = await decodeLatestRelease(
    await fetchGitHubJson(`${UPSTREAM_REPOSITORY}/releases/latest`),
  );
  const tag = encodeURIComponent(release.tag_name);
  // Page 2 leaves out the changed-file list, which is over a megabyte on a
  // long-lived fork; the status is the same on every page.
  const comparison = await decodeComparison(
    await fetchGitHubJson(
      `${UPSTREAM_REPOSITORY}/compare/${tag}...${FORK_OWNER}:t3code:${FORK_BRANCH}?per_page=1&page=2`,
    ),
  );
  const included = comparison.status === "ahead" || comparison.status === "identical";
  return included ? null : release.tag_name;
}

/** Asks on every app start until the fork's main branch has the latest release. */
export function startUpstreamReleaseNotice(): void {
  void findUnmergedUpstreamRelease().then(
    (tag) => {
      if (tag === null) return;
      const compareUrl = `https://github.com/${FORK_OWNER}/t3code/compare/${FORK_BRANCH}...${UPSTREAM_REPOSITORY.replace("/", ":")}:${encodeURIComponent(tag)}`;
      toastManager.add({
        type: "info",
        title: `T3 Code ${tag} is out`,
        description: `Your fork's ${FORK_BRANCH} branch does not include it yet.`,
        timeout: 0,
        actionProps: {
          children: "View changes",
          onClick: () => {
            void readLocalApi()?.shell.openExternal(compareUrl);
          },
        },
      });
    },
    (error: unknown) => {
      console.warn("Could not check for a new upstream release", error);
    },
  );
}
