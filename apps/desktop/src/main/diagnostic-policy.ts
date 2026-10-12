export type DesktopTraceDisposition = "error" | "warning" | "diagnostic" | "silent";

export function desktopTraceDisposition(
  diagnosticsEnabled: boolean,
  area: string,
  event: string,
  details: Record<string, unknown>,
): DesktopTraceDisposition {
  if (/(?:_error|_failed)$/u.test(event)) return "error";
  if (/_warning$/u.test(event)) return "warning";
  if ((area === "spotify" || area === "runtime") && event === "spotify_action_result" && details.outcome === "rejected") return "warning";
  return diagnosticsEnabled ? "diagnostic" : "silent";
}
