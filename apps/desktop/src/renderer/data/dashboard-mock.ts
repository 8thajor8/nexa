export interface ActivityMock {
  id: string;
  icon: "window" | "ipc" | "wallpaper";
  label: string;
  detail: string;
  time: string;
}

export const recentActivityMock: ActivityMock[] = [
  { id: "window", icon: "window", label: "Interfaz preparada", detail: "Sesión local de demostración", time: "Ahora" },
  { id: "ipc", icon: "ipc", label: "Puente IPC disponible", detail: "Comprobación local de ejemplo", time: "10:42" },
  { id: "wallpaper", icon: "wallpaper", label: "Fondo de Windows", detail: "Lectura local opcional", time: "10:41" },
];

export const availableToolsMock = [
  { id: "apps", label: "Aplicaciones", state: "FUTURO" },
  { id: "spotify", label: "Spotify", state: "FUTURO" },
  { id: "web", label: "Web Search", state: "FUTURO" },
  { id: "memory", label: "Memory", state: "FUTURO" },
  { id: "files", label: "Archivos", state: "FUTURO" },
  { id: "email", label: "Email", state: "FUTURO" },
];

export const systemStatusMock = [
  { id: "assistant", label: "Asistente", valueKind: "assistant" as const },
  { id: "core", label: "Core", value: "Sin conexión", state: "offline" as const },
  { id: "voice", label: "Voice", value: "Sin conexión", state: "offline" as const },
];
