import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  projectComposerContextForProvider,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { terminalContextRecord } from "./composerContextRecords";

import {
  formatTerminalContextReference,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  migrateLegacyTerminalContextPlaceholders,
  parseShellCommandPrompt,
  shellCommandContextSelection,
  type TerminalContextDraft,
} from "./terminalContext";

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.make("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 12,
    lineEnd: 13,
    text: "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("terminalContext", () => {
  it("folds legacy producer ids consistently in records and references", () => {
    const context = makeContext({ id: "old terminal:one" });
    const reference = collectComposerContextReferences(formatTerminalContextReference(context))[0];
    expect(reference).toBeDefined();
    expect(reference?.contextId).toBe(terminalContextRecord(context).contextId);
  });

  it("migrates legacy placeholders to references in order and drops extras", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    const first = formatTerminalContextReference(makeContext());
    const contexts = [makeContext()];
    expect(
      migrateLegacyTerminalContextPlaceholders(`a ${placeholder} b ${placeholder}`, contexts),
    ).toBe(`a ${first} b `);
    expect(migrateLegacyTerminalContextPlaceholders("plain", contexts)).toBe("plain");
  });
});

describe("shell commands", () => {
  it("only treats a leading bang with a command as a shell command", () => {
    expect(parseShellCommandPrompt("  !git status ")).toEqual({
      command: "git status",
      remainingPrompt: "",
    });
    expect(parseShellCommandPrompt("!")).toBeNull();
    expect(parseShellCommandPrompt("why does !this fail")).toBeNull();
  });

  it("keeps earlier chips and ignores the bang an image chip starts with", () => {
    const previous = formatTerminalContextReference({
      id: "shell-0",
      terminalLabel: "$ ls",
      lineStart: 1,
      lineEnd: 2,
    });
    expect(parseShellCommandPrompt(`${previous} !git status`)).toEqual({
      command: "git status",
      remainingPrompt: previous,
    });
    const image = formatComposerContextReference({
      kind: "image",
      contextId: toKindScopedComposerContextId("image", "shot-1"),
      label: "shot.png",
    });
    expect(image.startsWith("!")).toBe(true);
    expect(parseShellCommandPrompt(`${image} look at this`)).toBeNull();
  });

  it("hands the agent every output line plus a failing exit code", () => {
    const selection = shellCommandContextSelection("ls missing", {
      output: "ls: missing: No such file or directory\n",
      exitCode: 2,
      timedOut: false,
    });
    const record = terminalContextRecord({
      ...selection,
      id: "shell-1",
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-11-05T12:00:00.000Z",
    });
    const forProvider = projectComposerContextForProvider({
      text: formatTerminalContextReference({ ...selection, id: "shell-1" }),
      records: [record],
    });

    expect(selection.terminalLabel).toBe("$ ls missing");
    expect(forProvider).toContain("1 | $ ls missing");
    expect(forProvider).toContain("3 | [exit code 2]");
  });
});
