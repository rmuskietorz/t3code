import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

const decodeStoredClientSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClientSettingsSchema),
);

/**
 * Settings another document of this origin stored, such as another tab or the
 * other half of a split window; `null` for unrelated or unreadable changes.
 */
export function clientSettingsFromStorageEvent(
  event: Pick<StorageEvent, "key" | "newValue">,
): ClientSettings | null {
  if (event.key !== CLIENT_SETTINGS_STORAGE_KEY || event.newValue === null) return null;
  return Option.getOrNull(decodeStoredClientSettings(event.newValue));
}
