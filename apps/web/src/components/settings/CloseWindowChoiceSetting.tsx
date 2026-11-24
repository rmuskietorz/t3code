import type { DesktopCloseWindowChoice } from "@t3tools/contracts";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const CHOICE_LABELS: Record<DesktopCloseWindowChoice, string> = {
  ask: "Ask",
  window: "Close that window",
  all: "Close all windows",
};

export function CloseWindowChoiceSetting() {
  const bridge = window.desktopBridge;
  const [choice, setChoice] = useState(() => bridge?.getCloseWindowChoice?.() ?? null);
  const [error, setError] = useState<string | null>(null);
  const setCloseWindowChoice = bridge?.setCloseWindowChoice;
  if (choice === null || !setCloseWindowChoice) return null;

  const change = async (next: DesktopCloseWindowChoice) => {
    const previous = choice;
    setChoice(next);
    setError(null);
    try {
      await setCloseWindowChoice(next);
    } catch (cause) {
      setChoice(previous);
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("close-window-choice")}
      description={
        error ??
        "What happens when you close one of several open windows. Closing all windows quits T3 Code, and they all open again on the next start."
      }
      control={
        <Select
          value={choice}
          onValueChange={(value) => {
            if (value !== choice) void change(value as DesktopCloseWindowChoice);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Closing a window">
            <SelectValue>{CHOICE_LABELS[choice]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(Object.keys(CHOICE_LABELS) as DesktopCloseWindowChoice[]).map((value) => (
              <SelectItem key={value} hideIndicator value={value}>
                {CHOICE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
