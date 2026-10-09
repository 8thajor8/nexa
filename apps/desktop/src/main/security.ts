export interface SecureWebPreferences {
  preload: string;
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  allowRunningInsecureContent: false;
}

export const FRAMELESS_WINDOW_OPTIONS = {
  frame: false,
  autoHideMenuBar: true,
  resizable: true,
  minimizable: true,
  maximizable: true,
  closable: true,
} as const;

export function createSecureWebPreferences(preload: string): SecureWebPreferences {
  return {
    preload, nodeIntegration: false, contextIsolation: true, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false,
  };
}

export const EXPECTED_VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";

export type RendererEntryPoint =
  | { kind: "file"; filePath: string }
  | { kind: "url"; url: string };

export function isExpectedViteDevServerUrl(value: string): boolean {
  if (value !== value.trim()) return false;

  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "5173" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (value === EXPECTED_VITE_DEV_SERVER_URL || value === `${EXPECTED_VITE_DEV_SERVER_URL}/`);
  } catch {
    return false;
  }
}

export function selectRendererEntryPoint(
  isPackaged: boolean,
  configuredDevelopmentUrl: string | undefined,
  rendererFile: string,
): RendererEntryPoint {
  if (isPackaged || configuredDevelopmentUrl === undefined) {
    return { kind: "file", filePath: rendererFile };
  }
  if (!isExpectedViteDevServerUrl(configuredDevelopmentUrl)) {
    throw new Error("invalid_vite_dev_server_url");
  }
  return { kind: "url", url: EXPECTED_VITE_DEV_SERVER_URL };
}

export interface RendererLoader {
  loadURL: (url: string) => unknown;
  loadFile: (filePath: string) => unknown;
}

export function loadRendererEntryPoint(
  entryPoint: RendererEntryPoint,
  loader: RendererLoader,
): unknown {
  return entryPoint.kind === "url"
    ? loader.loadURL(entryPoint.url)
    : loader.loadFile(entryPoint.filePath);
}

export function createContentSecurityPolicy(development: boolean): string {
  const developmentScriptSources = development
    ? " http://127.0.0.1:5173 'unsafe-inline'" : "";
  const developmentStyleSources = development
    ? " http://127.0.0.1:5173 'unsafe-inline'" : "";
  const developmentConnections = development
    ? " http://127.0.0.1:5173 ws://127.0.0.1:5173" : "";

  return [
    "default-src 'self'", "base-uri 'self'", "object-src 'none'",
    "frame-ancestors 'none'", "form-action 'self'",
    "script-src 'self'" + developmentScriptSources,
    "style-src 'self'" + developmentStyleSources,
    "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'" + developmentConnections,
  ].join("; ");
}
