import { contextBridge, ipcRenderer } from "electron";

// The split view's divider and minimized-tab bar (see window/SplitView.ts).
// Channel names are repeated here because sandboxed preloads cannot share chunks.
contextBridge.exposeInMainWorld("splitChrome", {
  dividerStart: () => ipcRenderer.send("divider:start"),
  dividerEnd: () => ipcRenderer.send("divider:end"),
  onTabs: (listener: (tabs: unknown) => void) => {
    ipcRenderer.on("strip:tabs", (_event, tabs: unknown) => listener(tabs));
  },
  restoreTab: (id: number) => ipcRenderer.send("strip:restore", Number(id)),
  closeTab: (id: number) => ipcRenderer.send("strip:close", Number(id)),
});
