export interface IpcSenderContext { sender: object; senderFrame: object | null; }
export interface MainWindowContext { webContents: { mainFrame: object }; }

export function isTrustedIpcSender(
  event: IpcSenderContext,
  mainWindow: MainWindowContext | null,
): boolean {
  return Boolean(
    mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame,
  );
}

export function runForTrustedIpcSender<T>(
  event: IpcSenderContext,
  mainWindow: MainWindowContext | null,
  operation: () => T,
): T {
  if (!isTrustedIpcSender(event, mainWindow)) throw new Error("untrusted_ipc_sender");
  return operation();
}

export function isAllowedNavigation(targetUrl: string, entryPointUrl: string): boolean {
  return targetUrl === entryPointUrl;
}
