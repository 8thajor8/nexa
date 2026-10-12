import { isAllowedNavigation } from "../shared/ipc-security.js";

export interface ChatNavigationContents {
  on(event: "will-navigate", listener: (event: {
    preventDefault(): void;
    initiator?: { url?: string } | null;
  }, targetUrl: string) => void): unknown;
  on(event: "did-navigate", listener: (event: unknown, targetUrl: string) => void): unknown;
}

export interface ChatNavigationTrace {
  (event: "renderer_navigation_requested" | "renderer_navigation_committed", details: {
    target: string;
    initiator?: string;
    prevented?: boolean;
  }): void;
}

/** Keep request cleanup tied to a committed document navigation, not its cancellable attempt. */
export function registerChatNavigationHandlers(
  contents: ChatNavigationContents,
  rendererEntryPointUrl: string,
  classifyTarget: (url: string) => string,
  onEffectiveNavigation: () => void,
  trace: ChatNavigationTrace = () => undefined,
): void {
  contents.on("will-navigate", (event, targetUrl) => {
    const prevented = !isAllowedNavigation(targetUrl, rendererEntryPointUrl);
    trace("renderer_navigation_requested", {
      target: classifyTarget(targetUrl),
      initiator: event.initiator?.url ? classifyTarget(event.initiator.url) : "unknown",
      prevented,
    });
    if (prevented) event.preventDefault();
  });

  contents.on("did-navigate", (_event, targetUrl) => {
    trace("renderer_navigation_committed", { target: classifyTarget(targetUrl) });
    onEffectiveNavigation();
  });
}
