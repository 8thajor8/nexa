import type { NexaDesktopApi } from "../shared/ipc-contract";

declare global {
  interface Window { readonly nexaDesktop: NexaDesktopApi; }
}
export {};