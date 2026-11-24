import { DesktopCloseWindowChoiceSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getCloseWindowChoice = makeSyncIpcMethod({
  channel: IpcChannels.GET_CLOSE_WINDOW_CHOICE_CHANNEL,
  result: DesktopCloseWindowChoiceSchema,
  handler: Effect.fn("desktop.ipc.closeWindowChoice.get")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    return (yield* appSettings.get).closeWindowChoice;
  }),
});

export const setCloseWindowChoice = makeIpcMethod({
  channel: IpcChannels.SET_CLOSE_WINDOW_CHOICE_CHANNEL,
  payload: DesktopCloseWindowChoiceSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.closeWindowChoice.set")(function* (choice) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    yield* appSettings.setCloseWindowChoice(choice);
  }),
});
