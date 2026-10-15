import type { MasterVolumeStatus } from "./ipc-contract.js";

export function isMasterVolumePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function isMasterVolumeStatus(value: unknown): value is MasterVolumeStatus {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("available") || !keys.includes("volume") || !keys.includes("errorCode")) return false;
  const status = value as Partial<MasterVolumeStatus>;
  if (status.available === true) return isMasterVolumePercent(status.volume) && status.errorCode === null;
  return status.available === false && status.volume === null
    && (status.errorCode === "device_unavailable" || status.errorCode === "access_denied" || status.errorCode === "operation_failed");
}
