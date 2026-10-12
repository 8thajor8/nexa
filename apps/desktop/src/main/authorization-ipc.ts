import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  AUTHORIZATION_CANCEL_CHANNEL, AUTHORIZATION_CONNECT_CHANNEL,
  type AuthorizationCancelResult, type AuthorizationConnectResult, type AuthorizationProvider,
} from "../shared/ipc-contract.js";
import { isAuthorizationCancelRequest, isAuthorizationConnectRequest } from "../shared/authorization-ipc-validation.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";

type IpcEvent = { sender: object; senderFrame: object | null };
type Handler = (event: IpcMainInvokeEvent, payload: unknown) => unknown;
interface IpcMainLike { handle(channel: string, listener: Handler): void; removeHandler(channel: string): void; }
interface WindowContext { webContents: { mainFrame: object }; }
interface ConnectorResult { success?: boolean; error?: { code?: string }; }
export type AuthorizationConnector = (signal: AbortSignal) => Promise<ConnectorResult | void>;

const safeErrors: Record<string, string> = {
  spotify_config_missing: "Falta configurar Spotify en el entorno local de Nexa.",
  spotify_config_invalid: "La configuración local de Spotify no es válida.",
  spotify_callback_unavailable: "No se pudo preparar el retorno de Spotify en este equipo.",
  spotify_browser_unavailable: "No se pudo abrir el navegador para conectar Spotify.",
  spotify_authorization_timeout: "Se agotó el tiempo de espera de Spotify.",
  spotify_state_mismatch: "Spotify devolvió una respuesta de autorización no válida.",
  spotify_authorization_denied: "Spotify no completó la autorización.",
  spotify_authorization_cancelled: "La autorización de Spotify fue cancelada.",
  microsoft_config_missing: "Falta configurar Microsoft en el entorno local de Nexa.",
  microsoft_configuration_missing: "Falta configurar Microsoft en el entorno local de Nexa.",
  microsoft_configuration_invalid: "La configuración local de Microsoft no es válida.",
  microsoft_browser_unavailable: "No se pudo abrir el navegador para conectar Microsoft.",
  microsoft_dpapi_unavailable: "Windows no pudo abrir el almacenamiento protegido de Microsoft.",
  microsoft_token_storage_unavailable: "No se pudo preparar el almacenamiento protegido de Microsoft.",
  microsoft_admin_consent_required: "El administrador del tenant debe aprobar los permisos solicitados.",
  microsoft_authorization_cancelled: "La autorización de Microsoft fue cancelada.",
  microsoft_authorization_failed: "Microsoft no completó la autorización. Revisa la configuración de la aplicación.",
  microsoft_authentication_failed: "No se pudo completar la autorización de Microsoft.",
};

function safeError(provider: AuthorizationProvider, error: unknown): Extract<AuthorizationConnectResult, { state: "error" }> {
  const rawCode = typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code : "";
  const code = rawCode.startsWith(`${provider}_`) && Object.hasOwn(safeErrors, rawCode)
    ? rawCode
    : provider === "spotify" ? "spotify_authorization_failed" : "microsoft_authorization_failed";
  return { provider, state: "error", code, message: safeErrors[code]
    ?? (provider === "spotify" ? "Spotify no completó la autorización." : "Microsoft no completó la autorización.") };
}

export class AuthorizationIpcService {
  private readonly active = new Map<AuthorizationProvider, { requestId: string; window: WindowContext; controller: AbortController }>();

  constructor(
    private readonly getWindow: () => WindowContext | null,
    private readonly connectors: Record<AuthorizationProvider, AuthorizationConnector>,
  ) {}

  async connect(event: IpcEvent, payload: unknown): Promise<AuthorizationConnectResult> {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event as never, window as never)) throw new Error("untrusted_ipc_sender");
    if (!isAuthorizationConnectRequest(payload)) {
      return { provider: isRecord(payload) && payload.provider === "spotify" ? "spotify" : "microsoft",
        state: "error", code: "invalid_request", message: "La solicitud de conexión no es válida." };
    }
    const { provider, requestId } = payload;
    if (this.active.has(provider)) {
      return { provider, state: "error", code: "authorization_in_progress", message: "Ya hay una conexión de este servicio en curso." };
    }
    const controller = new AbortController();
    const active = { requestId, window, controller };
    this.active.set(provider, active);
    try {
      const result = await this.connectors[provider](controller.signal);
      if (controller.signal.aborted) return { provider, state: "cancelled" };
      if (result?.success === false) {
        const code = result.error?.code;
        if (code === "spotify_authorization_cancelled" || code === "microsoft_authorization_cancelled") {
          return { provider, state: "cancelled" };
        }
        return safeError(provider, { code });
      }
      return { provider, state: "connected" };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (controller.signal.aborted || code === "spotify_authorization_cancelled" || code === "microsoft_authorization_cancelled") {
        return { provider, state: "cancelled" };
      }
      return safeError(provider, error);
    } finally {
      if (this.active.get(provider) === active) this.active.delete(provider);
    }
  }

  cancel(event: IpcEvent, payload: unknown): AuthorizationCancelResult {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event as never, window as never)) throw new Error("untrusted_ipc_sender");
    if (!isAuthorizationCancelRequest(payload)) {
      return { provider: isRecord(payload) && payload.provider === "spotify" ? "spotify" : "microsoft",
        requestId: isRecord(payload) && typeof payload.requestId === "string" ? payload.requestId : "00000000-0000-4000-8000-000000000000",
        accepted: false, code: "not_active" };
    }
    const active = this.active.get(payload.provider);
    if (!active || active.window !== window || active.requestId !== payload.requestId) {
      return { provider: payload.provider, requestId: payload.requestId, accepted: false, code: "not_active" };
    }
    if (payload.provider !== "spotify") {
      return { provider: payload.provider, requestId: payload.requestId, accepted: false, code: "unsupported" };
    }
    active.controller.abort();
    return { provider: payload.provider, requestId: payload.requestId, accepted: true };
  }

  dispose(): void {
    for (const [provider, active] of this.active) {
      if (provider === "spotify") active.controller.abort();
    }
    this.active.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let service: AuthorizationIpcService | null = null;
export function registerAuthorizationIpcHandlers(
  getWindow: () => BrowserWindow | null,
  connectors: Record<AuthorizationProvider, AuthorizationConnector>,
  ipc: IpcMainLike = ipcMain,
): AuthorizationIpcService {
  removeAuthorizationIpcHandlers(ipc);
  service = new AuthorizationIpcService(getWindow, connectors);
  ipc.handle(AUTHORIZATION_CONNECT_CHANNEL, (event, payload) => service!.connect(event, payload));
  ipc.handle(AUTHORIZATION_CANCEL_CHANNEL, (event, payload) => service!.cancel(event, payload));
  return service;
}

export function removeAuthorizationIpcHandlers(ipc: IpcMainLike = ipcMain): void {
  ipc.removeHandler(AUTHORIZATION_CONNECT_CHANNEL);
  ipc.removeHandler(AUTHORIZATION_CANCEL_CHANNEL);
  service?.dispose();
  service = null;
}
