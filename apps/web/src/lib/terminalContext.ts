import { COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS, type ThreadId } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

export interface TerminalContextSelection {
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface TerminalContextDraft extends TerminalContextSelection {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";

export interface TerminalContextReferenceSource {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}

export function formatTerminalContextReference(context: TerminalContextReferenceSource): string {
  return formatComposerContextReference({
    kind: "terminal",
    contextId: toKindScopedComposerContextId("terminal", context.id),
    label: formatTerminalContextLabel(context),
  });
}

export function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

function hasTerminalContextText(context: { text: string }): boolean {
  return normalizeTerminalContextText(context.text).length > 0;
}

export function isTerminalContextExpired(context: { text: string }): boolean {
  return !hasTerminalContextText(context);
}

export function filterTerminalContextsWithText<T extends { text: string }>(
  contexts: ReadonlyArray<T>,
): T[] {
  return contexts.filter((context) => hasTerminalContextText(context));
}

function formatTerminalContextRange(selection: { lineStart: number; lineEnd: number }): string {
  return selection.lineStart === selection.lineEnd
    ? `line ${selection.lineStart}`
    : `lines ${selection.lineStart}-${selection.lineEnd}`;
}

export function formatTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${selection.terminalLabel} ${formatTerminalContextRange(selection)}`;
}

export function migrateLegacyTerminalContextPlaceholders(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextReferenceSource>,
): string {
  if (!prompt.includes(INLINE_TERMINAL_CONTEXT_PLACEHOLDER)) return prompt;
  let index = 0;
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, () => {
    const context = contexts[index];
    index += 1;
    return context ? formatTerminalContextReference(context) : "";
  });
}

const SHELL_COMMAND_LABEL_MAX_CHARS = 80;

/**
 * `!cmd` in the composer runs `cmd` on the environment, like the Claude CLI's bash mode. Context
 * chips stay in the draft (image chips start with `!` too), so commands can follow each other.
 */
export function parseShellCommandPrompt(
  prompt: string,
): { command: string; remainingPrompt: string } | null {
  const text = replaceComposerContextReferences(prompt, () => "").trim();
  if (!text.startsWith("!")) return null;
  const command = text.slice(1).trim();
  if (command.length === 0) return null;
  return {
    command,
    remainingPrompt: collectComposerContextReferences(prompt)
      .map((reference) => reference.source)
      .join(" "),
  };
}

export function shellCommandContextSelection(
  command: string,
  result: { output: string; exitCode: number | null; timedOut: boolean },
): TerminalContextSelection {
  const status = result.timedOut
    ? "[timed out]"
    : result.exitCode !== null && result.exitCode !== 0
      ? `[exit code ${result.exitCode}]`
      : null;
  const fullText = normalizeTerminalContextText(
    [`$ ${command}`, result.output.replace(/\s+$/, ""), status]
      .filter((part) => part !== null && part !== "")
      .join("\n"),
  );
  const truncatedMarker = "\n[output truncated]";
  const text =
    fullText.length > COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS
      ? fullText.slice(0, COMPOSER_CONTEXT_TERMINAL_TEXT_MAX_CHARS - truncatedMarker.length) +
        truncatedMarker
      : fullText;
  const firstLine = command.split("\n")[0] ?? command;
  const label =
    firstLine.length > SHELL_COMMAND_LABEL_MAX_CHARS || firstLine !== command
      ? `${firstLine.slice(0, SHELL_COMMAND_LABEL_MAX_CHARS)}…`
      : firstLine;
  return {
    terminalId: "shell-command",
    terminalLabel: `$ ${label}`,
    lineStart: 1,
    lineEnd: text.split("\n").length,
    text,
  };
}
