import type {
  AuthorizationCancelRequest, AuthorizationCancelResult, AuthorizationConnectRequest,
  AuthorizationConnectResult, AuthorizationProvider,
} from "./ipc-contract.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProvider(value: unknown): value is AuthorizationProvider {
  return value === "spotify" || value === "microsoft";
}
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

export function isAuthorizationConnectRequest(value: unknown): value is AuthorizationConnectRequest {
  return isRecord(value) && exactKeys(value, ["provider", "requestId"])
    && isProvider(value.provider) && typeof value.requestId === "string" && UUID.test(value.requestId);
}
export function isAuthorizationCancelRequest(value: unknown): value is AuthorizationCancelRequest {
  return isRecord(value) && exactKeys(value, ["provider", "requestId"])
    && isProvider(value.provider) && typeof value.requestId === "string" && UUID.test(value.requestId);
}
export function isAuthorizationConnectResult(value: unknown): value is AuthorizationConnectResult {
  if (!isRecord(value) || !isProvider(value.provider)) return false;
  if (value.state === "connected" || value.state === "cancelled") {
    return exactKeys(value, ["provider", "state"]);
  }
  return value.state === "error" && exactKeys(value, ["provider", "state", "code", "message"])
    && typeof value.code === "string" && /^[a-z0-9_]{1,80}$/u.test(value.code)
    && typeof value.message === "string" && value.message.length <= 300;
}
export function isAuthorizationCancelResult(value: unknown): value is AuthorizationCancelResult {
  return isRecord(value) && isProvider(value.provider) && typeof value.requestId === "string" && UUID.test(value.requestId)
    && ((value.accepted === true && exactKeys(value, ["provider", "requestId", "accepted"]))
      || (value.accepted === false && exactKeys(value, ["provider", "requestId", "accepted", "code"])
        && (value.code === "not_active" || value.code === "unsupported")));
}
