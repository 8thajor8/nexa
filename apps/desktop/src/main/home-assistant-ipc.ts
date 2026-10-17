import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL, HOME_ASSISTANT_LIGHT_METADATA_UPDATE_CHANNEL,
  HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL, HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL, HOME_ASSISTANT_LIGHTS_LIST_CHANNEL,
  HOME_ASSISTANT_SPEED_CANDIDATES_CHANNEL, HOME_ASSISTANT_SPEED_LINK_CHANNEL, HOME_ASSISTANT_SPEED_UNLINK_CHANNEL,
} from "../shared/ipc-contract.js";
import {
  isHomeAssistantAuthorizeRequest, isHomeAssistantMetadataUpdateRequest, isHomeAssistantRemoveRequest,
  isHomeAssistantSpeedCandidatesRequest, isHomeAssistantSpeedLinkRequest, isHomeAssistantSpeedUnlinkRequest,
} from "../shared/home-assistant-ipc-validation.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
interface IpcMainLike { handle(channel: string, listener: IpcHandler): void; removeHandler(channel: string): void; }
interface WindowLike extends BrowserWindow { webContents: BrowserWindow["webContents"] }
interface DeviceAdmin {
  listAuthorizedLights(): { ok: true; value: unknown[] } | { ok: false; error: string };
  discoverLights(): Promise<{ ok: true; value: unknown[] } | { ok: false; error: string }>;
  authorizeLight(input: unknown): Promise<unknown>;
  updateLightMetadata(input: unknown): Promise<unknown>;
  removeAuthorizedLight(input: unknown): Promise<unknown>;
  discoverEffectSpeedCandidates?(input: unknown): Promise<unknown>;
  linkEffectSpeed?(input: unknown): Promise<unknown>;
  unlinkEffectSpeed?(input: unknown): Promise<unknown>;
}

export function registerHomeAssistantIpcHandlers(
  getWindow: () => BrowserWindow | null,
  admin: DeviceAdmin,
  ipc: IpcMainLike = ipcMain,
): void {
  const channels = [HOME_ASSISTANT_LIGHTS_LIST_CHANNEL, HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL,
    HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL, HOME_ASSISTANT_LIGHT_METADATA_UPDATE_CHANNEL,
    HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL, HOME_ASSISTANT_SPEED_CANDIDATES_CHANNEL,
    HOME_ASSISTANT_SPEED_LINK_CHANNEL, HOME_ASSISTANT_SPEED_UNLINK_CHANNEL];
  channels.forEach(channel => ipc.removeHandler(channel));
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    const window = getWindow() as WindowLike | null;
    return Boolean(window && isTrustedIpcSender(event as never, window as never));
  };
  const noArgs = (event: IpcMainInvokeEvent, args: unknown[]): void => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 0) throw new Error("invalid_home_assistant_request");
  };

  ipc.handle(HOME_ASSISTANT_LIGHTS_LIST_CHANNEL, (event, ...args) => {
    noArgs(event, args);
    const result = admin.listAuthorizedLights();
    return result.ok ? { ok: true, value: { authorizedLights: result.value } } : result;
  });
  ipc.handle(HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL, async (event, ...args) => {
    noArgs(event, args);
    const result = await admin.discoverLights();
    return result.ok ? { ok: true, value: { lights: result.value } } : result;
  });
  ipc.handle(HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantAuthorizeRequest(args[0])) throw new Error("invalid_home_assistant_request");
    return admin.authorizeLight(args[0]);
  });
  ipc.handle(HOME_ASSISTANT_LIGHT_METADATA_UPDATE_CHANNEL, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantMetadataUpdateRequest(args[0])) throw new Error("invalid_home_assistant_request");
    return admin.updateLightMetadata(args[0]);
  });
  ipc.handle(HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantRemoveRequest(args[0])) throw new Error("invalid_home_assistant_request");
    return admin.removeAuthorizedLight(args[0]);
  });
  ipc.handle(HOME_ASSISTANT_SPEED_CANDIDATES_CHANNEL, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantSpeedCandidatesRequest(args[0])) throw new Error("invalid_home_assistant_request");
    return admin.discoverEffectSpeedCandidates?.(args[0]) ?? { ok: false, error: "home_assistant_request_failed" };
  });
  ipc.handle(HOME_ASSISTANT_SPEED_LINK_CHANNEL, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantSpeedLinkRequest(args[0])) throw new Error("invalid_home_assistant_request");
    return admin.linkEffectSpeed?.(args[0]) ?? { ok: false, error: "home_assistant_request_failed" };
  });
  ipc.handle(HOME_ASSISTANT_SPEED_UNLINK_CHANNEL, (event, ...args) => {
    if (!trusted(event)) throw new Error("untrusted_ipc_sender");
    if (args.length !== 1 || !isHomeAssistantSpeedUnlinkRequest(args[0])) throw new Error("invalid_home_assistant_request");
    return admin.unlinkEffectSpeed?.(args[0]) ?? { ok: false, error: "home_assistant_request_failed" };
  });
}

export function removeHomeAssistantIpcHandlers(ipc: IpcMainLike = ipcMain): void {
  ipc.removeHandler(HOME_ASSISTANT_LIGHTS_LIST_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHTS_DISCOVER_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHT_AUTHORIZE_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHT_METADATA_UPDATE_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_LIGHT_REMOVE_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_SPEED_CANDIDATES_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_SPEED_LINK_CHANNEL);
  ipc.removeHandler(HOME_ASSISTANT_SPEED_UNLINK_CHANNEL);
}
