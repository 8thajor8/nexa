import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerIpcHandlers } from "./ipc.js";
import { isAllowedNavigation } from "../shared/ipc-security.js";
import {
  GET_WALLPAPER_CHANNEL,
  PING_CHANNEL,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_MINIMIZE_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
} from "../shared/ipc-contract.js";
import {
  FRAMELESS_WINDOW_OPTIONS,
  createSecureWebPreferences,
  loadRendererEntryPoint,
  selectRendererEntryPoint,
} from "./security.js";
import { getWindowsWallpaper } from "./wallpaper.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rendererFile = resolve(appRoot, "dist", "index.html");
const rendererEntryPoint = selectRendererEntryPoint(
  app.isPackaged,
  process.env.VITE_DEV_SERVER_URL,
  rendererFile,
);
const rendererEntryPointUrl = rendererEntryPoint.kind === "url"
  ? rendererEntryPoint.url
  : pathToFileURL(rendererEntryPoint.filePath).href;
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280, height: 800, minWidth: 840, minHeight: 600,
    title: "Nexa Desktop", show: false, ...FRAMELESS_WINDOW_OPTIONS,
    webPreferences: createSecureWebPreferences(
      resolve(appRoot, "dist-electron", "preload.cjs"),
    ),
  });
  window.once("ready-to-show", () => {
    window.show();
    console.info("[nexa-desktop] window ready");
  });
  window.on("closed", () => { mainWindow = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, rendererEntryPointUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  void loadRendererEntryPoint(rendererEntryPoint, {
    loadURL: (url) => window.loadURL(url),
    loadFile: (filePath) => window.loadFile(filePath),
  });
  mainWindow = window;
  return window;
}

function installWebContentsGuards(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, targetUrl) => {
      if (!isAllowedNavigation(targetUrl, rendererEntryPointUrl)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  installWebContentsGuards();
  registerIpcHandlers(
    () => mainWindow,
    () => getWindowsWallpaper(app.getPath("appData")),
  );
  createMainWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) createMainWindow();
});
app.on("before-quit", () => {
  ipcMain.removeHandler(PING_CHANNEL);
  ipcMain.removeHandler(GET_WALLPAPER_CHANNEL);
  ipcMain.removeHandler(WINDOW_TOGGLE_MAXIMIZE_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_MINIMIZE_CHANNEL);
  ipcMain.removeAllListeners(WINDOW_CLOSE_CHANNEL);
});
