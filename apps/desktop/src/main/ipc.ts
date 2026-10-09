import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { createPingResponse, PING_CHANNEL } from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.removeHandler(PING_CHANNEL);
  ipcMain.handle(PING_CHANNEL, (event: IpcMainInvokeEvent) => {
    const mainWindow = getMainWindow();
    if (!isTrustedIpcSender(event, mainWindow)) throw new Error("untrusted_ipc_sender");
    return createPingResponse();
  });
}