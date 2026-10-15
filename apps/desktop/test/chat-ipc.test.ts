import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_CANCEL_REQUEST_CHANNEL, CHAT_CREATE_CONVERSATION_CHANNEL, CHAT_EVENT_CHANNEL, CHAT_LIST_CONVERSATIONS_CHANNEL, CHAT_LIST_MESSAGES_CHANNEL,
  CHAT_OPEN_CONVERSATION_CHANNEL, CHAT_SEND_MESSAGE_CHANNEL,
  type ChatEventEnvelope,
} from "../src/shared/ipc-contract.js";
import { registerChatIpcHandlers, type ConversationRuntimeApi, type RuntimeMessageEvent, type RuntimeMessageResult } from "../src/main/chat-ipc.js";
import { createConversationRuntime } from "../../../src/core/conversation-runtime.js";
import { createAgent } from "../../../src/core/agent.js";
import { executeTool, getToolsForModel } from "../../../src/tools/index.js";

function id(value: string): string { return `00000000-0000-4000-8000-${value.padStart(12, "0")}`; }
const conversationId = id("1");
const request = { conversationId, requestId: id("2"), text: "Hola", source: "typed" as const };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fakeRuntime(result: Promise<RuntimeMessageResult> = Promise.resolve({
  conversationId, requestId: request.requestId, status: "completed", text: "Respuesta",
})) {
  const listeners = new Set<(event: RuntimeMessageEvent) => void>();
  const runtime: ConversationRuntimeApi = {
    createConversation: vi.fn(() => conversationId),
    sendMessage: vi.fn((input) => {
      for (const listener of listeners) listener({ conversationId: input.conversationId, requestId: input.requestId, status: "processing" });
      return result;
    }),
    cancelRequest: vi.fn(() => true),
    onEvent: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }),
    close: vi.fn(async () => undefined),
  };
  return { runtime, listeners };
}
function harness(runtime: ConversationRuntimeApi | null,
  diagnostic?: (event: string, details: Readonly<Record<string, string | number | boolean | null>>) => void,
  voiceHooks?: Parameters<typeof registerChatIpcHandlers>[4],
  conversationStore?: Parameters<typeof registerChatIpcHandlers>[5]) {
  const handlers = new Map<string, (event: never, payload?: unknown) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, listener: (event: never, payload?: unknown) => unknown) => handlers.set(channel, listener)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const contents = { mainFrame: {}, send: vi.fn(), isDestroyed: vi.fn(() => false) };
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  const getWindow = () => window;
  const service = registerChatIpcHandlers(getWindow as never, () => runtime, ipc as never, diagnostic, voiceHooks, conversationStore);
  const event = { sender: contents, senderFrame: contents.mainFrame } as never;
  const invoke = (channel: string, payload?: unknown, overrideEvent = event) => handlers.get(channel)!(overrideEvent, payload);
  return { handlers, ipc, contents, window, service, invoke, event };
}

describe("Main chat IPC to Conversation Runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates one Main-owned Runtime conversation idempotently per service", () => {
    const { runtime } = fakeRuntime();
    const h = harness(runtime);
    expect(h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL)).toEqual({ ok: true, conversationId });
    expect(h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL)).toEqual({ ok: true, conversationId });
    expect(runtime.createConversation).toHaveBeenCalledOnce();
  });

  it("creates a distinct conversation only for the explicit new-conversation request", () => {
    const { runtime } = fakeRuntime();
    const secondId = id("9");
    runtime.createConversation = vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(secondId);
    const h = harness(runtime);
    expect(h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL)).toEqual({ ok: true, conversationId });
    expect(h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL)).toEqual({ ok: true, conversationId });
    expect(h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL, { newConversation: true })).toEqual({ ok: true, conversationId: secondId });
    expect(runtime.createConversation).toHaveBeenCalledTimes(2);
  });

  it("does not create or switch conversations while a Runtime response is pending", async () => {
    const result = deferred<RuntimeMessageResult>();
    const { runtime } = fakeRuntime(result.promise);
    const h = harness(runtime);
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);
    expect(h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL, { newConversation: true })).toMatchObject({
      ok: false, error: { code: "runtime_unavailable" },
    });
    expect(runtime.createConversation).toHaveBeenCalledOnce();
    result.resolve({ conversationId, requestId: request.requestId, status: "completed", text: "ok" });
  });

  it("registers fixed channels and returns a correlated ACK before Runtime completion", async () => {
    const result = deferred<RuntimeMessageResult>();
    const { runtime } = fakeRuntime(result.promise);
    const h = harness(runtime);
    expect([...h.handlers.keys()].sort()).toEqual([
      CHAT_CANCEL_REQUEST_CHANNEL, CHAT_CREATE_CONVERSATION_CHANNEL, CHAT_SEND_MESSAGE_CHANNEL,
    ].sort());
    expect(h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL)).toEqual({ ok: true, conversationId });
    const ack = await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request) as { ok: boolean; requestId: string };
    expect(ack).toMatchObject({ ok: true, accepted: true, requestId: request.requestId, conversationId });
    expect(runtime.sendMessage).toHaveBeenCalledWith(request);
    expect(h.contents.send).toHaveBeenCalledWith(CHAT_EVENT_CHANNEL, { conversationId, requestId: request.requestId, status: "processing" });
    result.resolve({ conversationId, requestId: request.requestId, status: "completed", text: "Respuesta Runtime" });
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      { conversationId, requestId: request.requestId, status: "completed", response: "Respuesta Runtime" }));
  });

  it("passes voice source through the same Runtime API and preserves correlation", async () => {
    const { runtime } = fakeRuntime(Promise.resolve({ conversationId, requestId: id("4"), status: "completed", text: "respuesta voz" }));
    const h = harness(runtime);
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    const voiceRequest = { ...request, requestId: id("4"), source: "voice" as const, text: "transcripción" };
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, voiceRequest);
    expect(runtime.sendMessage).toHaveBeenCalledWith(voiceRequest);
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      { conversationId, requestId: voiceRequest.requestId, status: "completed", response: "respuesta voz" }));
  });

  it("persists typed and PTT visible turns exactly once before exposing completion", async () => {
    const calls: string[] = [];
    const store = {
      createConversation: vi.fn(async () => ({ conversationId })),
      listConversations: vi.fn(async () => ({ conversations: [], nextCursor: null })),
      getConversation: vi.fn(async () => ({ conversationId })),
      appendMessage: vi.fn(async (_id: string, message: { role: string; content: string }) => { calls.push(`${message.role}:${message.content}`); }),
      listMessages: vi.fn(async () => ({ messages: [], nextCursor: null, incompleteTail: false })),
    };
    const { runtime, listeners } = fakeRuntime();
    runtime.restoreConversation = vi.fn(() => true);
    runtime.sendMessage = vi.fn(async (input) => {
      calls.push(`runtime:${input.source}`);
      const result = { conversationId: input.conversationId, requestId: input.requestId, status: "completed" as const,
        text: `respuesta ${input.source}` };
      for (const listener of listeners) listener(result);
      return result;
    });
    const h = harness(runtime, undefined, undefined, store);
    const created = await h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    expect(created).toEqual({ ok: true, conversationId });
    expect(store.createConversation).toHaveBeenCalledOnce();
    expect(runtime.restoreConversation).toHaveBeenCalledWith(conversationId, []);
    for (const [requestId, source] of [[id("61"), "typed"], [id("62"), "voice"]] as const) {
      await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, requestId, source });
      await vi.waitFor(() => expect(h.contents.send.mock.calls.some(call => (call[1] as ChatEventEnvelope).requestId === requestId
        && (call[1] as ChatEventEnvelope).status === "completed")).toBe(true));
    }
    expect(calls).toEqual([
      "user:Hola", "runtime:typed", "assistant:respuesta typed",
      "user:Hola", "runtime:voice", "assistant:respuesta voice",
    ]);
    expect(store.appendMessage).toHaveBeenCalledTimes(4);
    h.service.dispose();
  });

  it("does not run Runtime or report completion when user persistence fails", async () => {
    const store = { createConversation: vi.fn(async () => ({ conversationId })),
      listConversations: vi.fn(async () => ({ conversations: [], nextCursor: null })),
      getConversation: vi.fn(async () => ({ conversationId })),
      appendMessage: vi.fn(async () => { throw new Error("storage failed"); }),
      listMessages: vi.fn(async () => ({ messages: [], nextCursor: null, incompleteTail: false })) };
    const { runtime } = fakeRuntime();
    runtime.restoreConversation = vi.fn(() => true);
    const h = harness(runtime, undefined, undefined, store);
    await h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      expect.objectContaining({ conversationId, requestId: request.requestId, status: "error" })));
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    h.service.dispose();
  });

  it("cancels a voice request while its user message is being persisted without starting Runtime", async () => {
    const pendingWrite = deferred<void>();
    const store = { createConversation: vi.fn(async () => ({ conversationId })),
      listConversations: vi.fn(async () => ({ conversations: [], nextCursor: null })),
      getConversation: vi.fn(async () => ({ conversationId })),
      appendMessage: vi.fn(() => pendingWrite.promise),
      listMessages: vi.fn(async () => ({ messages: [], nextCursor: null, incompleteTail: false })) };
    const { runtime } = fakeRuntime();
    runtime.restoreConversation = vi.fn(() => true);
    const h = harness(runtime, undefined, undefined, store);
    await h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    const voiceRequest = { ...request, requestId: id("63"), source: "voice" as const };
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, voiceRequest);
    expect(await h.invoke(CHAT_CANCEL_REQUEST_CHANNEL, { requestId: voiceRequest.requestId })).toMatchObject({ ok: true, accepted: true });
    expect(runtime.cancelRequest).not.toHaveBeenCalled();
    pendingWrite.resolve(undefined);
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      { conversationId, requestId: voiceRequest.requestId, status: "cancelled" }));
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    h.service.dispose();
  });

  it("does not publish a final response if its assistant message cannot be persisted", async () => {
    let appendCount = 0;
    const store = { createConversation: vi.fn(async () => ({ conversationId })),
      listConversations: vi.fn(async () => ({ conversations: [], nextCursor: null })),
      getConversation: vi.fn(async () => ({ conversationId })),
      appendMessage: vi.fn(async () => { if (++appendCount === 2) throw new Error("storage failed"); }),
      listMessages: vi.fn(async () => ({ messages: [], nextCursor: null, incompleteTail: false })) };
    const { runtime, listeners } = fakeRuntime();
    runtime.restoreConversation = vi.fn(() => true);
    runtime.sendMessage = vi.fn(async (input) => {
      const result = { conversationId: input.conversationId, requestId: input.requestId,
        status: "completed" as const, text: "Respuesta no persistida" };
      for (const listener of listeners) listener(result);
      return result;
    });
    const h = harness(runtime, undefined, undefined, store);
    await h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      expect.objectContaining({ conversationId, requestId: request.requestId, status: "error" })));
    expect(h.contents.send.mock.calls.some(call => (call[1] as ChatEventEnvelope).status === "completed")).toBe(false);
    expect(store.appendMessage).toHaveBeenCalledTimes(2);
    h.service.dispose();
  });

  it("opens only an explicitly requested saved UUID and restores visible context", async () => {
    const savedMessages = [
      { id: id("70"), conversationId, sequence: 1, version: 1, role: "user" as const,
        content: "Estoy pensando en borrar mis copias.", createdAt: "2035-01-01T00:00:00.000Z", status: "complete" as const },
      { id: id("71"), conversationId, sequence: 2, version: 1, role: "assistant" as const,
        content: "Te recomiendo conservar una copia.", createdAt: "2035-01-01T00:00:01.000Z", status: "complete" as const },
      { id: id("72"), conversationId, sequence: 3, version: 1, role: "assistant" as const,
        content: "", createdAt: "2035-01-01T00:00:02.000Z", status: "interrupted" as const },
    ];
    const store = { createConversation: vi.fn(async () => ({ conversationId })),
      listConversations: vi.fn(async () => ({ conversations: [], nextCursor: null })),
      getConversation: vi.fn(async (requestedId: string) => requestedId === conversationId ? { conversationId } : null),
      appendMessage: vi.fn(async () => undefined),
      listMessages: vi.fn(async () => ({ messages: savedMessages, nextCursor: null, incompleteTail: false })) };
    const { runtime } = fakeRuntime();
    runtime.restoreConversation = vi.fn(() => true);
    const h = harness(runtime, undefined, undefined, store);
    expect([...h.handlers.keys()]).toEqual(expect.arrayContaining([CHAT_OPEN_CONVERSATION_CHANNEL, CHAT_LIST_MESSAGES_CHANNEL,
      CHAT_LIST_CONVERSATIONS_CHANNEL]));
    const response = await h.invoke(CHAT_OPEN_CONVERSATION_CHANNEL, { conversationId }) as { ok: boolean; messages: unknown[] };
    expect(response).toMatchObject({ ok: true, conversationId, messages: [
      { id: id("70"), role: "user", content: "Estoy pensando en borrar mis copias." },
      { id: id("71"), role: "assistant", content: "Te recomiendo conservar una copia." },
      { id: id("72"), role: "assistant", content: "", status: "interrupted" },
    ] });
    expect(runtime.restoreConversation).toHaveBeenCalledWith(conversationId, [
      { role: "user", content: "Estoy pensando en borrar mis copias." },
      { role: "assistant", content: "Te recomiendo conservar una copia." },
    ]);
    expect(store.createConversation).not.toHaveBeenCalled();
    h.service.dispose();
  });

  it("lists only paged conversation metadata and does not open the most recent conversation automatically", async () => {
    const summary = { conversationId, title: "Nueva conversación", createdAt: "2035-01-01T00:00:00.000Z",
      updatedAt: "2035-01-01T00:00:00.000Z", messageCount: 0 };
    const store = { createConversation: vi.fn(async () => ({ conversationId })),
      listConversations: vi.fn(async () => ({ conversations: [summary], nextCursor: null })),
      getConversation: vi.fn(async () => ({ conversationId })), appendMessage: vi.fn(async () => undefined),
      listMessages: vi.fn(async () => ({ messages: [], nextCursor: null, incompleteTail: false })) };
    const { runtime } = fakeRuntime();
    runtime.restoreConversation = vi.fn(() => true);
    const h = harness(runtime, undefined, undefined, store);
    const result = await h.invoke(CHAT_LIST_CONVERSATIONS_CHANNEL, { limit: 25 }) as { ok: boolean; conversations: unknown[] };
    expect(result).toMatchObject({ ok: true, conversations: [summary], nextCursor: null });
    expect(store.listConversations).toHaveBeenCalledWith({ limit: 25 });
    expect(runtime.restoreConversation).not.toHaveBeenCalled();
    h.service.dispose();
  });

  it("speaks only completed voice-origin responses and cancels speech when another chat interaction starts", async () => {
    const { runtime } = fakeRuntime();
    runtime.sendMessage = vi.fn(async (input) => ({
      conversationId: input.conversationId, requestId: input.requestId, status: "completed", text: `respuesta ${input.source}`,
    }));
    const onNewInteraction = vi.fn();
    const onVoiceResponse = vi.fn();
    const onTypedResponse = vi.fn();
    const onResponseDispatched = vi.fn();
    const h = harness(runtime, undefined, { onNewInteraction, onVoiceResponse, onTypedResponse, onResponseDispatched });
    const created = h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    const send = async (requestId: string, source: "typed" | "voice") => {
      await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, conversationId: created.conversationId, requestId, source });
      await vi.waitFor(() => expect(h.contents.send.mock.calls.some((call) => {
        const event = call[1] as ChatEventEnvelope;
        return event.requestId === requestId && event.status === "completed";
      })).toBe(true));
    };

    await send(id("51"), "typed");
    expect(onNewInteraction).toHaveBeenCalledOnce();
    expect(onNewInteraction).toHaveBeenNthCalledWith(1, id("51"), "typed");
    expect(onVoiceResponse).not.toHaveBeenCalled();
    expect(onTypedResponse).toHaveBeenCalledWith(h.window, id("51"), "respuesta typed");
    expect(onResponseDispatched).toHaveBeenNthCalledWith(1, id("51"), "typed");
    await send(id("52"), "voice");
    expect(onNewInteraction).toHaveBeenCalledTimes(2);
    expect(onNewInteraction).toHaveBeenNthCalledWith(2, id("52"), "voice");
    expect(onVoiceResponse).toHaveBeenCalledOnce();
    expect(onVoiceResponse).toHaveBeenCalledWith(h.window, id("52"), "respuesta voice");
    expect(onTypedResponse).toHaveBeenCalledOnce();
    expect(onResponseDispatched).toHaveBeenNthCalledWith(2, id("52"), "voice");
  });

  it("does not dispatch speech for intermediate tool or Spotify events before the final voice result", async () => {
    const result = deferred<RuntimeMessageResult>();
    const { runtime, listeners } = fakeRuntime(result.promise);
    const onVoiceResponse = vi.fn();
    const h = harness(runtime, undefined, { onVoiceResponse });
    const created = h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    const requestId = id("53");
    const ack = await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, conversationId: created.conversationId,
      requestId, source: "voice" }) as { ok: boolean };
    expect(ack.ok).toBe(true);
    const [runtimeListener] = [...listeners];
    runtimeListener?.({ conversationId: created.conversationId, requestId, status: "processing" });
    runtimeListener?.({ conversationId: created.conversationId, requestId, status: "spotify_now_playing",
      card: { name: "track", artists: [], imageUrl: null, spotifyUrl: null, playing: true } } as never);
    expect(onVoiceResponse).not.toHaveBeenCalled();
    expect(h.contents.send.mock.calls.some((call) => (call[1] as ChatEventEnvelope).status === "spotify_now_playing")).toBe(true);

    result.resolve({ conversationId: created.conversationId, requestId, status: "completed", text: "La canción está sonando." });
    await vi.waitFor(() => expect(onVoiceResponse).toHaveBeenCalledOnce());
    expect(onVoiceResponse).toHaveBeenCalledWith(h.window, requestId, "La canción está sonando.");
  });

  it("diagnoses the effective chat Runtime and its preceding Memory2 retrieval without another model call", async () => {
    let modelCalls = 0;
    let readCalls = 0;
    let agentInitializations = 0;
    const syntheticAssertion = { id: "assertion-synthetic", predicate: "prefers_editor",
      object: { type: "text", value: "Synthetic editor value" } };
    const consentStore = { load: async () => null, grant: async () => null, revoke: async () => ({ success: true }) };
    const proposalQueue = { listGrouped: async () => [], review: async () => null,
      approve: async () => ({ success: false }), reject: async () => ({ success: false }),
      discard: async () => ({ success: false }), excludeConversation: async () => ({ success: false }),
      revokeConsent: async () => undefined };
    const runtime = createConversationRuntime({
      memoryMode: "memory2-readonly",
      agentFactory: async ({ agentOptions: runtimeOptions }) => {
        agentInitializations++;
        return createAgent({
        ...runtimeOptions,
        memory2ReadOnlyReader: {
          readContext: async () => {
            readCalls++;
            return { digest: "synthetic-digest", items: [{ type: "function_call_output",
              call_id: "memory-context-test", output: JSON.stringify({ assertions: [syntheticAssertion], relations: [] }) }] };
          },
          close: async () => undefined,
        },
        memoryRetrievalEnabled: true,
        memory2ReadOnlyAllowExternalTools: true,
        automaticMemoryConsentStore: consentStore,
        automaticMemoryProposalQueue: proposalQueue,
        getTools: () => [],
        ask: async ({ input }: { input: unknown[] }) => {
          modelCalls++;
          expect(input).toEqual(expect.arrayContaining([expect.objectContaining({ type: "function_call_output" })]));
          return { status: "completed", output_text: "No lo tengo presente.", output: [] };
        },
        });
      },
    }) as unknown as ConversationRuntimeApi;
    const h = harness(runtime);
    const created = h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    const send = async (requestId: string, text: string) => {
      const ack = await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, conversationId: created.conversationId,
        requestId, text }) as { ok: boolean };
      expect(ack.ok).toBe(true);
      await vi.waitFor(() => expect(h.contents.send.mock.calls.some((call) => {
        const event = call[1] as ChatEventEnvelope;
        return event.requestId === requestId && event.status === "completed";
      })).toBe(true));
      return h.contents.send.mock.calls.map((call) => call[1] as ChatEventEnvelope)
        .findLast((event) => event.requestId === requestId && event.status === "completed");
    };

    const status = await send(id("41"), "¿Qué sistema de memoria estás usando?");
    expect(status?.status === "completed" && status.response).toMatch(/Memory2 en modo de solo lectura/u);
    expect(status?.status === "completed" && status.presentation?.kind).toBe("diagnostic");
    expect(status?.status === "completed" && status.presentation?.technicalDetail).toMatch(/memory2-readonly/u);
    expect(modelCalls).toBe(0); // Local diagnosis does not call OpenAI or initialize an agent.
    expect(agentInitializations).toBe(0);
    const answer = await send(id("42"), "¿Qué editor de código prefiero?");
    expect(answer?.status).toBe("completed");
    expect(readCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(agentInitializations).toBe(1);

    const diagnosis = await send(id("43"), "¿Por qué no recordaste mi editor favorito?");
    expect(diagnosis?.status === "completed" && diagnosis.response).toMatch(/1 coincidencia/u);
    expect(diagnosis?.status === "completed" && diagnosis.response).toMatch(/contexto se incluyó en la solicitud al modelo/u);
    expect(diagnosis?.status === "completed" && diagnosis.response).not.toContain("Synthetic editor value");
    expect(readCalls).toBe(1); // The diagnostic preserves and inspects the previous retrieval evidence.
    expect(modelCalls).toBe(1);

    const report = await send(id("44"), "Preparame un informe técnico completo para soporte sobre tu última recuperación de memoria");
    expect(report?.status === "completed" && report.response).toMatch(/Informe técnico de memoria/u);
    expect(report?.status === "completed" && report.response).toMatch(/MEMORY_CONTEXT_DELIVERED_USAGE_UNKNOWN/u);
    expect(report?.status === "completed" && report.response).toMatch(/Uso por el modelo.*unknown/u);
    expect(report?.status === "completed" && report.presentation?.kind).toBe("diagnostic");
    expect(modelCalls).toBe(1);
    h.service.dispose();
    await runtime.close();
  });

  it("keeps conversational context through the real Runtime API with a fake agent", async () => {
    const received: Array<{ text: string; source: string }> = [];
    const runtime = createConversationRuntime({
      agentFactory: async () => ({
        run: async (text: string, source: string) => {
          received.push({ text, source });
          return `respuesta-${received.length}`;
        },
        close: async () => undefined,
      }),
    }) as unknown as ConversationRuntimeApi;
    const h = harness(runtime);
    const runtimeConversationId = (h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string }).conversationId;
    for (const [requestId, text, source] of [[id("11"), "primer mensaje", "typed"], [id("12"), "segundo mensaje", "voice"]] as const) {
      const expectedResponse = `respuesta-${received.length + 1}`;
      await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { conversationId: runtimeConversationId, requestId, text, source });
      await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
        { conversationId: runtimeConversationId, requestId, status: "completed", response: expectedResponse }));
    }
    expect(received).toEqual([{ text: "primer mensaje", source: "typed" }, { text: "segundo mensaje", source: "voice" }]);
    await runtime.close();
  });

  it("forwards a correlated authorization requirement without ending the active chat request", async () => {
    const runtime = createConversationRuntime({
      memoryMode: "memory1",
      agentFactory: async () => ({
        run: async (_text: string, _source: string, options: { onAuthorizationRequired?: (value: unknown) => void }) => {
          options.onAuthorizationRequired?.({ provider: "spotify", state: "not_connected",
            reason: "spotify_auth_required", canConnect: true, retrySafe: true });
          return "Conectá Spotify para continuar.";
        },
        close: async () => undefined,
      }),
    }) as unknown as ConversationRuntimeApi;
    const h = harness(runtime);
    const created = h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    const authEvent = { conversationId: created.conversationId, requestId: request.requestId,
      status: "authorization_required" as const, requirement: { provider: "spotify" as const, state: "not_connected" as const,
        reason: "spotify_auth_required" as const, canConnect: true, retrySafe: true } };

    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, conversationId: created.conversationId });
    await vi.waitFor(() => expect(h.contents.send.mock.calls.map((call) => call[1])).toContainEqual(authEvent));
    expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      { conversationId: created.conversationId, requestId: request.requestId,
        status: "completed", response: "Conectá Spotify para continuar." });
    expect(h.contents.send.mock.calls.filter((call) => (call[1] as ChatEventEnvelope).status === "authorization_required"))
      .toHaveLength(1);
    await runtime.close();
  });

  it("traces a model-selected open_app through the real dispatcher to a mocked Windows launch", async () => {
    const traces: Array<{ event: string; details: Record<string, unknown> }> = [];
    const launchAttempts: Array<{ executable: string; args: string[] }> = [];
    let modelCalls = 0;
    const runtime = createConversationRuntime({
      memoryMode: "memory1",
      diagnostic: (entry: Record<string, unknown>) => traces.push({ event: String(entry.event), details: entry }),
      agentOptions: {
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        getTools: getToolsForModel,
        ask: async () => ++modelCalls === 1
          ? { status: "completed", output: [{ type: "function_call", name: "open_app",
            arguments: JSON.stringify({ app: "Calculator" }), call_id: "open-app-test" }] }
          : { status: "completed", output_text: "Se inició Calculadora.", output: [] },
        execute: (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => executeTool(name, args, {
          ...context,
          platform: "win32",
          environment: { SystemRoot: "C:\\Windows" },
          loadCatalog: async () => ({ version: 1, apps: [] }),
          launchProcess: async (executable: string, launchArgs: string[]) => {
            launchAttempts.push({ executable, args: launchArgs });
          },
        }),
        logger: (event: string, details: Record<string, unknown>) => traces.push({ event, details }),
      },
    }) as unknown as ConversationRuntimeApi;
    const h = harness(runtime);
    const created = h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    const requestId = id("13");

    expect(h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, conversationId: created.conversationId,
      requestId, text: "Nexa, abrí la Calculadora de Windows.", source: "typed" })).toMatchObject({
      ok: true, accepted: true, requestId,
    });
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      { conversationId: created.conversationId, requestId, status: "completed", response: "Se inició Calculadora." }));

    expect(modelCalls).toBe(2);
    expect(launchAttempts).toEqual([{ executable: expect.stringMatching(/\\System32\\calc\.exe$/iu), args: [] }]);
    expect(traces.some(({ event, details }) => event === "tool_call" && details.tool === "open_app"
      && details.requestId === requestId)).toBe(true);
    expect(traces.some(({ event, details }) => event === "tool_permission" && details.tool === "open_app"
      && details.permission === "action" && details.allowed === true && details.requestId === requestId)).toBe(true);
    expect(traces.some(({ event, details }) => event === "windows_launch_accepted"
      && details.requestId === requestId)).toBe(true);
    expect(traces.some(({ event, details }) => event === "tool_result" && details.tool === "open_app"
      && details.success === true && details.requestId === requestId)).toBe(true);
    expect(JSON.stringify(traces)).not.toContain("Calculadora de Windows");
    expect(JSON.stringify(traces)).not.toContain("Se inició Calculadora");
    await runtime.close();
  });

  it("completes discover_apps then open_app across model iterations without an unsolicited cancellation", async () => {
    const traces: Array<{ event: string; details: Record<string, unknown> }> = [];
    const launched: string[] = [];
    let modelCalls = 0;
    const runtime = createConversationRuntime({
      memoryMode: "memory1",
      diagnostic: (entry: Record<string, unknown>) => traces.push({ event: String(entry.event), details: entry }),
      agentOptions: {
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        getTools: getToolsForModel,
          ask: async () => {
            modelCalls++;
            if (modelCalls === 1) return { status: "completed", output: [{ type: "function_call", name: "discover_apps",
              arguments: "{}", call_id: "discover-test" }] };
            if (modelCalls === 2) return { status: "completed", output: [{ type: "function_call", name: "open_app",
              arguments: JSON.stringify({ app: "Calculadora de Windows" }), call_id: "open-after-discover-test" }] };
          return { status: "completed", output_text: "Listo.", output: [] };
        },
        execute: (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => executeTool(name, args, {
          ...context,
          platform: "win32",
          environment: { SystemRoot: "C:\\Windows" },
          directories: [],
          fileSystem: { readdir: async () => [], readFile: async () => Buffer.alloc(0), stat: async () => ({ isFile: () => false }) },
          loadCatalog: async () => ({ version: 1, apps: [] }),
          saveCatalog: async () => undefined,
          readAppxApps: async () => ({ success: true, apps: [] }),
          launchProcess: async (executable: string) => { launched.push(executable); },
        }),
        logger: (event: string, details: Record<string, unknown>) => traces.push({ event, details }),
      },
    }) as unknown as ConversationRuntimeApi;
    const h = harness(runtime);
    const created = h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    const requestId = id("14");
    expect(h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, conversationId: created.conversationId,
      requestId, text: "Nexa, abrí la Calculadora de Windows", source: "typed" })).toMatchObject({
      ok: true, accepted: true, requestId,
    });
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      { conversationId: created.conversationId, requestId, status: "completed", response: "Listo." }));

    expect(modelCalls).toBe(3);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatch(/\\System32\\calc\.exe$/iu);
    expect(traces.some(({ event, details }) => event === "tool_result" && details.tool === "discover_apps"
      && details.success === true && details.requestId === requestId)).toBe(true);
    expect(traces.some(({ event, details }) => event === "tool_call" && details.tool === "open_app"
      && details.requestId === requestId)).toBe(true);
    expect(traces.some(({ event, details }) => event === "windows_app_resolution" && details.appQuery === "calculadora de windows"
      && details.target === "whitelist" && details.requestId === requestId)).toBe(true);
    expect(traces.some(({ event }) => event === "cancel_requested" || event === "request_cancelled")).toBe(false);
    await runtime.close();
  });

  it("routes a Spanish Calculator window action through Desktop IPC and the shared Runtime", async () => {
    const traces: Array<{ event: string; details: Record<string, unknown> }> = [];
    const nativeCalls: Array<[string, bigint, string?]> = [];
    let modelCalls = 0;
    const runtime = createConversationRuntime({
      memoryMode: "memory1",
      agentOptions: {
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        getTools: getToolsForModel,
        ask: async () => {
          modelCalls++;
          if (modelCalls === 1) return { status: "completed", output: [{ type: "function_call",
            name: "maximize_window", arguments: JSON.stringify({ target: "Calculadora" }), call_id: "maximize-calculator" }] };
          return { status: "completed", output_text: "Ventana maximizada.", output: [] };
        },
        execute: (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => executeTool(name, args, {
          ...context,
          platform: "win32",
          windowsApi: {
            enumerateHandles: () => [0x515n],
            isWindowVisible: () => true,
            getWindowInfo: () => ({ title: "Calculator", pid: 515 }),
            getForegroundHandle: () => null,
            focus: (handle: bigint) => { nativeCalls.push(["focus", handle]); return true; },
            show: (handle: bigint, action: string) => { nativeCalls.push(["show", handle, action]); return true; },
            close: (handle: bigint) => { nativeCalls.push(["close", handle]); return true; },
          },
          listProcesses: async () => '"ApplicationFrameHost.exe","515","Console","1","1,024 K"',
          loadCatalog: async () => ({ version: 1, apps: [] }),
        }),
        logger: (event: string, details: Record<string, unknown>) => traces.push({ event, details }),
      },
    }) as unknown as ConversationRuntimeApi;
    const diagnostic = (event: Record<string, unknown>) => traces.push({ event: String(event.event), details: event });
    const h = harness(runtime, diagnostic as never);
    const created = h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL) as { ok: true; conversationId: string };
    const requestId = id("15");

    expect(h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, conversationId: created.conversationId,
      requestId, text: "Maximizá la Calculadora", source: "typed" })).toMatchObject({ ok: true, accepted: true });
    await vi.waitFor(() => expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL,
      { conversationId: created.conversationId, requestId, status: "completed", response: "Ventana maximizada." }));

    expect(modelCalls).toBe(2);
    expect(nativeCalls).toEqual([["show", 0x515n, "maximize"]]);
    expect(traces.some(({ event, details }) => event === "tool_permission" && details.tool === "maximize_window"
      && details.permission === "action" && details.allowed === true)).toBe(true);
    await runtime.close();
  });

  it("returns busy globally without queueing or retrying", async () => {
    const pending = deferred<RuntimeMessageResult>();
    const { runtime } = fakeRuntime(pending.promise);
    const h = harness(runtime);
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);
    const second = { ...request, requestId: id("3"), text: "Segundo" };
    expect(h.invoke(CHAT_SEND_MESSAGE_CHANNEL, second)).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it("requests cooperative cancellation and waits for Runtime's terminal event", async () => {
    const pending = deferred<RuntimeMessageResult>();
    const { runtime, listeners } = fakeRuntime(pending.promise);
    const diagnostic = vi.fn();
    const h = harness(runtime, diagnostic);
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);
    expect(h.invoke(CHAT_CANCEL_REQUEST_CHANNEL, { requestId: request.requestId })).toEqual({ ok: true, accepted: true, requestId: request.requestId });
    expect(runtime.cancelRequest).toHaveBeenCalledWith(request.requestId, "user");
    expect(diagnostic).toHaveBeenCalledWith("cancel_ipc_received", expect.objectContaining({
      requestId: request.requestId, origin: "renderer_cancel_action",
    }));
    expect(h.contents.send.mock.calls.some((call) => (call[1] as ChatEventEnvelope).status === "cancelled")).toBe(false);
    const terminal = { conversationId, requestId: request.requestId, status: "cancelled" as const };
    listeners.forEach((listener) => listener(terminal));
    expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL, terminal);
    pending.resolve(terminal);
  });

  it("maps Runtime busy and conversation errors without inventing assistant responses", async () => {
    const { runtime, listeners } = fakeRuntime(new Promise(() => undefined));
    const onVoiceRequestTerminal = vi.fn();
    const h = harness(runtime, undefined, { onVoiceRequestTerminal });
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    const voiceRequest = { ...request, source: "voice" as const };
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, voiceRequest);
    listeners.forEach((listener) => listener({ conversationId, requestId: voiceRequest.requestId, status: "error", error: { code: "agent_error", message: "Runtime failed" } }));
    expect(h.contents.send).toHaveBeenLastCalledWith(CHAT_EVENT_CHANNEL, expect.objectContaining({
      status: "error", error: { code: "operation_failed", message: "Runtime failed" },
    }));
    expect(onVoiceRequestTerminal).toHaveBeenCalledWith(voiceRequest.requestId, "error");
    expect(h.contents.send.mock.calls.some((call) => (call[1] as ChatEventEnvelope).status === "completed")).toBe(false);
  });

  it("rejects unknown conversations, malformed payloads and untrusted senders", async () => {
    const { runtime } = fakeRuntime();
    const h = harness(runtime);
    expect(h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request)).toMatchObject({ ok: false, error: { code: "conversation_not_found" } });
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    expect(h.invoke(CHAT_SEND_MESSAGE_CHANNEL, { ...request, text: " " })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(() => h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request, { sender: {}, senderFrame: {} } as never)).toThrow("untrusted_ipc_sender");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores mismatched late events and cancels work on window teardown", async () => {
    const pending = deferred<RuntimeMessageResult>();
    const { runtime, listeners } = fakeRuntime(pending.promise);
    const diagnostic = vi.fn();
    const h = harness(runtime, diagnostic);
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);
    listeners.forEach((listener) => listener({ conversationId: id("99"), requestId: request.requestId, status: "completed", text: "wrong" }));
    expect(h.contents.send).toHaveBeenCalledTimes(1); // processing only
    h.service.cleanupWindow(h.window, "navigation");
    expect(runtime.cancelRequest).toHaveBeenCalledWith(request.requestId, "navigation");
    expect(diagnostic).toHaveBeenCalledWith("request_cleanup_cancel", expect.objectContaining({
      requestId: request.requestId, origin: "navigation",
    }));
    pending.resolve({ conversationId, requestId: request.requestId, status: "completed", text: "late" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.contents.send).toHaveBeenCalledTimes(1);
  });

  it("cancels active work when the window closes", async () => {
    const pending = deferred<RuntimeMessageResult>();
    const { runtime } = fakeRuntime(pending.promise);
    const h = harness(runtime);
    h.invoke(CHAT_CREATE_CONVERSATION_CHANNEL);
    await h.invoke(CHAT_SEND_MESSAGE_CHANNEL, request);

    h.service.cleanupWindow(h.window, "window_closed");

    expect(runtime.cancelRequest).toHaveBeenCalledWith(request.requestId, "window_closed");
    pending.resolve({ conversationId, requestId: request.requestId, status: "cancelled" });
  });

  it("unsubscribes from Runtime when Main removes handlers", () => {
    const { runtime, listeners } = fakeRuntime();
    const h = harness(runtime);
    expect(listeners.size).toBe(1);
    h.service.dispose();
    expect(listeners.size).toBe(0);
  });
});
