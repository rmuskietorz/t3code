import { ChevronDownIcon, LayersIcon } from "lucide-react";

import { ALL_SIDEBAR_PROFILE_KEY, useSidebarProfile } from "~/sidebarProfile";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

/** Renders nothing while custom project groups are off. */
export function SidebarProfileMenu({ className }: { className?: string }) {
  const { profile, options, setProfileKey } = useSidebarProfile();
  if (options === null) return null;
  const label = profile?.label ?? "All projects";
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost-muted"
            className={className}
            aria-label={`Profile: ${label}`}
            data-testid="sidebar-profile-trigger"
          />
        }
      >
        <LayersIcon />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Profile</MenuGroupLabel>
          <MenuRadioGroup
            value={profile?.key ?? ALL_SIDEBAR_PROFILE_KEY}
            onValueChange={(value) => setProfileKey(String(value))}
          >
            {options.map((option) => (
              <MenuRadioItem key={option.key} value={option.key}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
