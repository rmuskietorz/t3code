import type { SidebarCustomProjectGroup } from "@t3tools/contracts/settings";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  useCustomProjectGroupActions,
  useCustomProjectGroups,
  useCustomProjectGroupsEnabled,
} from "~/hooks/useCustomProjectGroups";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const parsePathRules = (text: string) =>
  text
    .split("\n")
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0);

function PathRulesInput({ group }: { group: SidebarCustomProjectGroup }) {
  const actions = useCustomProjectGroupActions();
  const committed = group.pathRules.join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      size="sm"
      aria-label={`Path rules for ${group.name}`}
      placeholder={"/var/www/*\nC:\\Users\\me\\projects\\**"}
      spellCheck={false}
      value={draft ?? committed}
      onFocus={() => setDraft(committed)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = parsePathRules(draft ?? committed);
        setDraft(null);
        if (next.join("\n") !== committed) void actions.setPathRules(group.id, next);
      }}
    />
  );
}

export function CustomProjectGroupsSettings() {
  const enabled = useCustomProjectGroupsEnabled();
  const groups = useCustomProjectGroups();
  const legacySidebarEnabled = useClientSettings((settings) => settings.legacySidebarEnabled);
  const updateSettings = useUpdateClientSettings();
  const actions = useCustomProjectGroupActions();

  return (
    <>
      <SettingsRow
        {...searchableSetting("custom-project-groups")}
        description={
          legacySidebarEnabled
            ? "Sort sidebar projects into your own groups, such as Work and Personal."
            : "Sort sidebar projects into your own groups. Shown in the legacy sidebar for now."
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              updateSettings({ sidebarCustomProjectGroupsEnabled: Boolean(checked) })
            }
            aria-label="Custom project groups"
          />
        }
      />
      {enabled
        ? groups.map((group, index) => (
            <SettingsRow
              key={group.id}
              title={
                <DraftInput
                  size="sm"
                  className="w-full sm:w-56"
                  aria-label="Group name"
                  value={group.name}
                  onCommit={(name) => {
                    const trimmed = name.trim();
                    if (trimmed.length > 0) void actions.renameGroup(group.id, trimmed);
                  }}
                />
              }
              description="Projects matching a rule join this group unless you moved them yourself. One rule per line; * matches within a folder, ** across folders."
              control={
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move ${group.name} up`}
                    disabled={index === 0}
                    onClick={() => actions.moveGroupBy(group.id, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move ${group.name} down`}
                    disabled={index === groups.length - 1}
                    onClick={() => actions.moveGroupBy(group.id, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${group.name}`}
                    onClick={() => void actions.deleteGroup(group.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              }
            >
              <PathRulesInput group={group} />
            </SettingsRow>
          ))
        : null}
      {enabled ? (
        <SettingsRow
          title="Add a group"
          description="Drag projects onto a group in the sidebar, or use Move to group in a project's menu."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => actions.createGroup(`Group ${groups.length + 1}`)}
            >
              <PlusIcon />
              Add group
            </Button>
          }
        />
      ) : null}
    </>
  );
}
