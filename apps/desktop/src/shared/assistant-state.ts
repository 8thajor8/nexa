export const ASSISTANT_STATES = [
  "idle", "listening", "thinking", "executing", "speaking", "error",
] as const;
export type AssistantState = (typeof ASSISTANT_STATES)[number];

export interface AssistantStateProvider {
  getSnapshot: () => AssistantState;
  subscribe: (listener: () => void) => () => void;
  setState: (state: AssistantState) => void;
}

export function createMockAssistantStateProvider(): AssistantStateProvider {
  let currentState: AssistantState = "idle";
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => currentState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(state) {
      if (currentState === state) return;
      currentState = state;
      for (const listener of listeners) listener();
    },
  };
}

export const ASSISTANT_STATE_LABELS: Record<AssistantState, string> = {
  idle: "En espera", listening: "Escuchando", thinking: "Pensando",
  executing: "Ejecutando", speaking: "Respondiendo", error: "Error",
};