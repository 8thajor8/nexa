import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { performance } from "node:perf_hooks";
import { isChatCancelRequest, isChatConversationCreateRequest, isChatConversationListRequest, isChatConversationMessagesRequest, isChatConversationOpenRequest,
  isChatConversationResponse, isChatEventEnvelope, isChatSendMessageRequest } from "../shared/chat-ipc-validation.js";
import {
  CHAT_CANCEL_REQUEST_CHANNEL, CHAT_CREATE_CONVERSATION_CHANNEL, CHAT_EVENT_CHANNEL, CHAT_LIST_CONVERSATIONS_CHANNEL,
  CHAT_LIST_MESSAGES_CHANNEL, CHAT_OPEN_CONVERSATION_CHANNEL, CHAT_SEND_MESSAGE_CHANNEL,
  type AuthorizationRequiredEvent, type ChatConversationMessage, type ChatConversationMessagesRequest,
  type ChatConversationResponse, type ChatMessageCursor, type ChatConversationListRequest, type SpotifyNowPlayingEvent,
  type ChatEventEnvelope, type ChatIpcErrorCode, type ChatSendMessageRequest,
} from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";

export interface ConversationRuntimeApi {
  createConversation(): string;
  restoreConversation?(conversationId: string, messages: readonly Pick<ChatConversationMessage, "role" | "content">[]): boolean;
  sendMessage(input: Readonly<ChatSendMessageRequest>): Promise<RuntimeMessageResult>;
  cancelRequest(requestId: string, origin?: string): boolean;
  onEvent(listener: (event: RuntimeMessageEvent) => void): () => void;
  getMemoryMode?(): string;
  close(): Promise<void>;
}
export interface ConversationStoreApi {
  createConversation(): Promise<{ conversationId: string }>;
  listConversations(options?: ChatConversationListRequest): Promise<{
    conversations: Array<{ conversationId: string; title: string; createdAt: string; updatedAt: string; messageCount: number }>;
    nextCursor: { updatedAt: string; conversationId: string } | null;
  }>;
  getConversation(conversationId: string): Promise<unknown | null>;
  appendMessage(conversationId: string, message: { role: "user" | "assistant"; content: string }): Promise<unknown>;
  listMessages(conversationId: string, options?: { limit?: number; cursor?: ChatMessageCursor | null }): Promise<{
    messages: ChatConversationMessage[]; nextCursor: ChatMessageCursor | null; incompleteTail: boolean;
  }>;
}
export type RuntimeMessageResult =
  | { conversationId: string; requestId: string; status: "completed"; text: string;
      presentation?: { kind: "diagnostic" | "tool_catalog"; technicalDetail: string } }
  | { conversationId: string; requestId: string; status: "cancelled" }
  | { conversationId: string; requestId: string; status: "error"; error: { code: string; message: string; diagnostic?: { stage: string; code: string; durationMs: number } } };
export type RuntimeMessageEvent = RuntimeMessageResult | { conversationId: string; requestId: string; status: "processing" }
  | AuthorizationRequiredEvent | SpotifyNowPlayingEvent;

interface ChatWindowContext {
  webContents: { mainFrame: object; send(channel: string, payload: unknown): void };
  isDestroyed?(): boolean;
}
interface ChatIpcEvent {
  sender: object;
  senderFrame: object | null;
  returnValue?: unknown;
  reply?(channel: string, payload: unknown): void;
}
type Handler = (event: IpcMainInvokeEvent, payload: unknown) => unknown;
type ChatDiagnostic = (event: string, details: Readonly<Record<string, string | number | boolean | null>>) => void;
export type ChatCleanupOrigin = "navigation" | "window_closed" | "app_quit";
export interface ChatVoiceHooks {
  onNewInteraction?(requestId: string, source: "typed" | "voice"): void;
  onVoiceResponse?(window: ChatWindowContext, requestId: string, response: string): void;
  onTypedResponse?(window: ChatWindowContext, requestId: string, response: string): void;
  onVoiceRuntimeCompleted?(window: ChatWindowContext, requestId: string, durationMs: number): void;
  onResponseDispatched?(requestId: string, source: "typed" | "voice"): void;
  onVoiceRequestTerminal?(requestId: string, status: "cancelled" | "error"): void;
}
interface IpcMainLike {
  handle(channel: string, listener: Handler): void;
  removeHandler(channel: string): void;
}
interface ActiveRequest {
  window: ChatWindowContext;
  request: Readonly<ChatSendMessageRequest>;
  terminal: boolean;
  cancelPending: boolean;
  startedAt: number;
  completionPromise?: Promise<void>;
  persistencePending?: boolean;
  cancellationRequested?: boolean;
}

function failure(requestId: string, code: ChatIpcErrorCode, message: string, conversationId?: string) {
  return { ok: false as const, requestId, ...(conversationId ? { conversationId } : {}), error: { code, message } };
}
function exposedMessages(messages: readonly ChatConversationMessage[]): ChatConversationMessage[] {
  return messages.map(({ id, role, content, createdAt, status }) => ({ id, role, content, createdAt, status }));
}
function runtimeErrorCode(code: string): ChatIpcErrorCode {
  if (code === "busy") return "busy";
  if (code === "conversation_not_found") return "conversation_not_found";
  return "operation_failed";
}
function isRuntimeEvent(value: unknown): value is RuntimeMessageEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.conversationId !== "string" || typeof event.requestId !== "string") return false;
  if (event.status === "processing" || event.status === "cancelled") return true;
  if (event.status === "authorization_required" || event.status === "spotify_now_playing") return isChatEventEnvelope(value);
  if (event.status === "completed") return typeof event.text === "string";
  return event.status === "error" && typeof event.error === "object" && event.error !== null
    && typeof (event.error as Record<string, unknown>).code === "string"
    && typeof (event.error as Record<string, unknown>).message === "string";
}

/** Main-process allowlisted transport; Runtime is injected only into this Main-process service. */
export class ChatIpcService {
  private readonly activeByRequest = new Map<string, ActiveRequest>();
  private readonly seenRequestIds = new WeakMap<object, Set<string>>();
  private conversationId: string | null = null;
  private conversationCreation: Promise<ChatConversationResponse> | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private runtimeSwitching = false;

  constructor(
    private readonly getWindow: () => ChatWindowContext | null,
    private readonly getRuntime: () => ConversationRuntimeApi | null,
    private readonly diagnostic: ChatDiagnostic = () => undefined,
    private readonly voiceHooks: ChatVoiceHooks = {},
    private readonly conversationStore: ConversationStoreApi | null = null,
  ) {
    const runtime = getRuntime();
    if (runtime) this.unsubscribeRuntime = runtime.onEvent((event) => this.handleRuntimeEvent(event));
  }

  createConversation(event: ChatIpcEvent, payload?: unknown): ChatConversationResponse | Promise<ChatConversationResponse> {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isChatConversationCreateRequest(payload)) return { ok: false,
      error: { code: "operation_failed", message: "The conversation request is invalid." } };
    const newConversation = payload?.newConversation === true;
    if (this.runtimeSwitching) return { ok: false, error: { code: "runtime_unavailable", message: "Runtime is changing memory mode." } };
    if (newConversation && this.activeByRequest.size > 0) return { ok: false,
      error: { code: "runtime_unavailable", message: "A conversation cannot be created while Runtime is busy." } };
    const runtime = this.getRuntime();
    if (!runtime) return { ok: false, error: { code: "runtime_unavailable", message: "Runtime is not connected." } };
    if (this.conversationId && !newConversation) return { ok: true, conversationId: this.conversationId };
    if (!this.conversationStore) {
      try {
        const conversationId = runtime.createConversation();
        if (!isChatConversationResponse({ ok: true, conversationId })) throw new Error("runtime_conversation_id_invalid");
        this.conversationId = conversationId;
        return { ok: true, conversationId };
      } catch {
        return { ok: false, error: { code: "operation_failed", message: "A conversation could not be created." } };
      }
    }
    if (this.conversationCreation) return this.conversationCreation;
    this.conversationCreation = (async () => {
      try {
        const conversationId = (await this.conversationStore!.createConversation()).conversationId;
        if (!isChatConversationResponse({ ok: true, conversationId })) throw new Error("runtime_conversation_id_invalid");
        if (!runtime.restoreConversation || !runtime.restoreConversation(conversationId, []))
          throw new Error("runtime_conversation_restore_failed");
        this.conversationId = conversationId;
        return { ok: true as const, conversationId };
      } catch {
        this.trace("conversation_create_failed", { stage: "persistent_create" });
        return { ok: false as const, error: { code: "operation_failed" as const, message: "A conversation could not be created." } };
      } finally { this.conversationCreation = null; }
    })();
    return this.conversationCreation;
  }

  async openConversation(event: ChatIpcEvent, payload: unknown) {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isChatConversationOpenRequest(payload)) return { ok: false as const,
      error: { code: "operation_failed" as const, message: "The conversation request is invalid." } };
    if (this.runtimeSwitching || this.activeByRequest.size > 0) return { ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "The conversation cannot be opened while Runtime is busy." } };
    const runtime = this.getRuntime();
    if (!runtime) return { ok: false as const, error: { code: "runtime_unavailable" as const, message: "Runtime is not connected." } };
    if (!this.conversationStore || !runtime.restoreConversation) return { ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "Conversation recovery is not available." } };
    try {
      const conversation = await this.conversationStore.getConversation(payload.conversationId);
      if (!conversation) return { ok: false as const,
        error: { code: "conversation_not_found" as const, message: "The conversation does not exist." } };
      const page = await this.conversationStore.listMessages(payload.conversationId, { limit: 100 });
      if (this.conversationId !== payload.conversationId)
        runtime.restoreConversation(payload.conversationId, page.messages.filter(message => message.content.trim().length > 0)
          .map(({ role, content }) => ({ role, content })));
      this.conversationId = payload.conversationId;
      return { ok: true as const, conversationId: payload.conversationId,
        messages: exposedMessages(page.messages), nextCursor: page.nextCursor, incompleteTail: page.incompleteTail };
    } catch {
      this.trace("conversation_open_failed", { stage: "persistent_read" });
      return { ok: false as const, error: { code: "operation_failed" as const, message: "The conversation could not be opened." } };
    }
  }

  async listMessages(event: ChatIpcEvent, payload: unknown) {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isChatConversationMessagesRequest(payload)) return { ok: false as const,
      error: { code: "operation_failed" as const, message: "The conversation request is invalid." } };
    if (!this.conversationStore) return { ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "Conversation storage is not available." } };
    try {
      const conversation = await this.conversationStore.getConversation(payload.conversationId);
      if (!conversation) return { ok: false as const,
        error: { code: "conversation_not_found" as const, message: "The conversation does not exist." } };
      const page = await this.conversationStore.listMessages(payload.conversationId, { limit: 100, cursor: payload.cursor ?? null });
      return { ok: true as const, conversationId: payload.conversationId,
        messages: exposedMessages(page.messages), nextCursor: page.nextCursor, incompleteTail: page.incompleteTail };
    } catch {
      this.trace("conversation_messages_read_failed", { stage: "persistent_read" });
      return { ok: false as const, error: { code: "operation_failed" as const, message: "Conversation messages could not be read." } };
    }
  }

  async listConversations(event: ChatIpcEvent, payload: unknown = {}) {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isChatConversationListRequest(payload)) return { ok: false as const,
      error: { code: "operation_failed" as const, message: "The conversation list request is invalid." } };
    if (!this.conversationStore) return { ok: false as const,
      error: { code: "runtime_unavailable" as const, message: "Conversation storage is not available." } };
    try {
      const page = await this.conversationStore.listConversations(payload);
      return { ok: true as const, conversations: page.conversations, nextCursor: page.nextCursor };
    } catch {
      this.trace("conversation_list_failed", { stage: "persistent_read" });
      return { ok: false as const, error: { code: "operation_failed" as const, message: "Conversations could not be listed." } };
    }
  }

  send(event: ChatIpcEvent, payload: unknown) {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isChatSendMessageRequest(payload)) return failure(
      typeof (payload as { requestId?: unknown } | null)?.requestId === "string" ? (payload as { requestId: string }).requestId : "",
      "invalid_request", "The chat request is invalid.",
    );
    const reject = (code: ChatIpcErrorCode, message: string) => {
      if (payload.source === "voice") {
        try { this.voiceHooks.onVoiceRequestTerminal?.(payload.requestId, "error"); } catch { /* Voice cleanup cannot block chat IPC. */ }
      }
      return failure(payload.requestId, code, message, payload.conversationId);
    };
    if (this.runtimeSwitching) return reject("busy", "Runtime is changing memory mode.");
    const request = Object.freeze({ ...payload });
    const runtime = this.getRuntime();
    if (!runtime) return reject("runtime_unavailable", "Runtime is not connected.");
    if (!this.conversationId || request.conversationId !== this.conversationId) return reject(
      "conversation_not_found", "The conversation is not available to this window.",
    );
    const seen = this.seenRequestIds.get(window as object) ?? new Set<string>();
    if (seen.has(request.requestId)) return reject("busy", "This request identifier was already used.");
    // Runtime enforces one active request across all conversations it owns.
    if (this.activeByRequest.size > 0) return reject("busy", "Runtime is processing another conversation request.");
    seen.add(request.requestId);
    if (seen.size > 1_024) seen.delete(seen.values().next().value as string);
    this.seenRequestIds.set(window as object, seen);
    const active: ActiveRequest = { window, request, terminal: false, cancelPending: false, startedAt: performance.now() };
    this.activeByRequest.set(request.requestId, active);
    if (request.source === "typed" || request.source === "voice") {
      try { this.voiceHooks.onNewInteraction?.(request.requestId, request.source); } catch { /* Speech cancellation must not block chat. */ }
    }
    let operation: Promise<RuntimeMessageResult>;
    const sendToRuntime = (): Promise<RuntimeMessageResult> => {
      if (active.cancellationRequested) return Promise.resolve({ conversationId: request.conversationId,
        requestId: request.requestId, status: "cancelled" });
      try { return runtime.sendMessage(request); }
      catch { return Promise.reject(new Error("runtime_send_failed")); }
    };
    if (this.conversationStore) {
      active.persistencePending = true;
      operation = this.conversationStore.appendMessage(request.conversationId, { role: "user", content: request.text })
        .then(() => { active.persistencePending = false; return sendToRuntime(); }).catch((error) => {
          active.persistencePending = false;
          this.trace("conversation_persist_failed", { stage: "user_message" });
          throw error;
        });
    } else operation = sendToRuntime();
    this.trace("ipc_request_accepted", { conversationId: request.conversationId, requestId: request.requestId });
    void operation.then((result) => {
      if (active.terminal) return;
      this.completeFromResult(active, result);
    }).catch(() => {
      if (!active.terminal) this.complete(active, {
        conversationId: request.conversationId, requestId: request.requestId, status: "error",
        error: { code: "operation_failed", message: "The conversation could not be saved or completed." },
      });
    });
    return { ok: true as const, accepted: true as const, conversationId: request.conversationId, requestId: request.requestId };
  }

  cancel(event: ChatIpcEvent, payload: unknown) {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isChatCancelRequest(payload)) return failure(
      typeof (payload as { requestId?: unknown } | null)?.requestId === "string" ? (payload as { requestId: string }).requestId : "",
      "invalid_request", "The cancellation request is invalid.",
    );
    const active = this.activeByRequest.get(payload.requestId);
    if (!active || active.window !== window || active.terminal) return failure(
      payload.requestId, "request_not_found", "No active request matches this identifier.",
    );
    if (active.cancelPending) return failure(payload.requestId, "busy", "Cancellation is already pending.", active.request.conversationId);
    this.trace("cancel_ipc_received", { conversationId: active.request.conversationId,
      requestId: payload.requestId, origin: "renderer_cancel_action" });
    active.cancelPending = true;
    try {
      if (active.persistencePending) {
        active.cancellationRequested = true;
        active.cancelPending = false;
        return { ok: true as const, accepted: true as const, requestId: payload.requestId };
      }
      const accepted = this.getRuntime()?.cancelRequest(payload.requestId, "user") ?? false;
      if (!accepted || active.terminal) {
        active.cancelPending = false;
        return failure(payload.requestId, "cancel_not_accepted", "Runtime did not accept the cancellation request.", active.request.conversationId);
      }
      // The ACK reports that cancellation was requested; only Runtime's terminal event confirms cancellation.
      return { ok: true as const, accepted: true as const, requestId: payload.requestId };
    } catch {
      active.cancelPending = false;
      return failure(payload.requestId, "operation_failed", "Cancellation could not be requested.", active.request.conversationId);
    }
  }

  cleanupWindow(window: ChatWindowContext, origin: ChatCleanupOrigin = "window_closed"): void {
    for (const active of [...this.activeByRequest.values()]) {
      if (active.window !== window) continue;
      this.trace("request_cleanup_cancel", { conversationId: active.request.conversationId,
        requestId: active.request.requestId, origin });
      active.terminal = true;
      try { this.getRuntime()?.cancelRequest(active.request.requestId, origin); } catch { /* Runtime closes with the app. */ }
      this.activeByRequest.delete(active.request.requestId);
    }
  }

  dispose(): void {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
  }

  beginRuntimeSwitch(): boolean {
    if (this.runtimeSwitching || this.activeByRequest.size > 0) return false;
    this.runtimeSwitching = true;
    return true;
  }

  refreshRuntimeAfterSwitch(): void {
    if (!this.runtimeSwitching) throw new Error("chat_runtime_switch_not_started");
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.conversationId = null;
    const runtime = this.getRuntime();
    if (runtime) this.unsubscribeRuntime = runtime.onEvent((event) => this.handleRuntimeEvent(event));
  }

  endRuntimeSwitch(): void { this.runtimeSwitching = false; }

  private handleRuntimeEvent(event: RuntimeMessageEvent): void {
    if (!isRuntimeEvent(event)) return;
    const active = this.activeByRequest.get(event.requestId);
    if (!active || active.terminal || event.conversationId !== active.request.conversationId) return;
    this.trace("runtime_event_received", { conversationId: event.conversationId, requestId: event.requestId,
      status: event.status });
    if (event.status === "processing") {
      this.emit(active, { conversationId: event.conversationId, requestId: event.requestId, status: "processing" });
      return;
    }
    if (event.status === "authorization_required" || event.status === "spotify_now_playing") {
      this.emit(active, event);
      return;
    }
    this.completeFromResult(active, event);
  }

  private completeFromResult(active: ActiveRequest, result: RuntimeMessageResult): void {
    if (!result || result.requestId !== active.request.requestId || result.conversationId !== active.request.conversationId) {
      this.complete(active, {
        conversationId: active.request.conversationId, requestId: active.request.requestId, status: "error",
        error: { code: "operation_failed", message: "Runtime returned a result with mismatched correlation." },
      });
      return;
    }
    if (result.status === "completed") {
      if (this.conversationStore) {
        if (active.completionPromise) return;
        active.completionPromise = this.conversationStore.appendMessage(result.conversationId,
          { role: "assistant", content: result.text }).then(() => {
          this.dispatchCompletedResult(active, result);
        }).catch(() => {
          this.trace("conversation_persist_failed", { stage: "assistant_message" });
          this.complete(active, { conversationId: active.request.conversationId,
            requestId: active.request.requestId, status: "error",
            error: { code: "operation_failed", message: "The response could not be saved to conversation history." } });
        });
        return;
      }
      this.dispatchCompletedResult(active, result);
    }
    else if (result.status === "cancelled") this.complete(active, {
      conversationId: result.conversationId, requestId: result.requestId, status: "cancelled",
    });
    else {
      this.complete(active, {
        conversationId: result.conversationId, requestId: result.requestId, status: "error",
        error: { code: runtimeErrorCode(result.error.code), message: result.error.message.slice(0, 300) },
      });
    }
  }

  private dispatchCompletedResult(active: ActiveRequest, result: Extract<RuntimeMessageResult, { status: "completed" }>): void {
      if (active.request.source === "voice") {
        try { this.voiceHooks.onVoiceRuntimeCompleted?.(active.window, result.requestId, performance.now() - active.startedAt); }
        catch { /* Diagnostic failures do not change the final answer. */ }
        try { this.voiceHooks.onVoiceResponse?.(active.window, result.requestId, result.text); }
        catch { /* A speech output failure must not change the completed text response. */ }
      }
      else if (active.request.source === "typed") {
        try { this.voiceHooks.onTypedResponse?.(active.window, result.requestId, result.text); }
        catch { /* Optional speech must not change the completed text response. */ }
      }
      this.complete(active, {
        conversationId: result.conversationId, requestId: result.requestId, status: "completed", response: result.text,
        ...(result.presentation ? { presentation: result.presentation } : {}),
      });
  }

  private complete(active: ActiveRequest, event: ChatEventEnvelope): void {
    if (active.terminal) return;
    active.terminal = true;
    const safeEvent = isChatEventEnvelope(event) ? event : {
      conversationId: active.request.conversationId, requestId: active.request.requestId, status: "error" as const,
      error: { code: "operation_failed" as const, message: "Runtime returned an invalid conversation result." },
    };
    this.emit(active, safeEvent);
    this.activeByRequest.delete(active.request.requestId);
    if (active.request.source === "voice" && (safeEvent.status === "cancelled" || safeEvent.status === "error")) {
      try { this.voiceHooks.onVoiceRequestTerminal?.(active.request.requestId, safeEvent.status); }
      catch { /* Voice cleanup cannot affect the terminal chat result. */ }
    }
  }

  private emit(active: ActiveRequest, payload: ChatEventEnvelope): void {
    if (active.window.isDestroyed?.() || !isChatEventEnvelope(payload)) return;
    try {
      active.window.webContents.send(CHAT_EVENT_CHANNEL, payload);
      if (payload.status === "completed") {
        try { this.voiceHooks.onResponseDispatched?.(payload.requestId, active.request.source); }
        catch { /* Diagnostic timing must not affect response delivery. */ }
      }
      this.trace("renderer_event_send_called", { conversationId: payload.conversationId,
        requestId: payload.requestId, status: payload.status });
    } catch {
      this.trace("renderer_event_forward_failed", { conversationId: payload.conversationId,
        requestId: payload.requestId, status: payload.status });
    }
  }

  private trace(event: string, details: Readonly<Record<string, string | number | boolean | null>>): void {
    try { this.diagnostic(event, details); } catch { /* Diagnostics must not affect IPC behavior. */ }
  }
}

let service: ChatIpcService | null = null;
export function registerChatIpcHandlers(
  getWindow: () => BrowserWindow | null,
  getRuntime: () => ConversationRuntimeApi | null,
  ipc: IpcMainLike = ipcMain,
  diagnostic: ChatDiagnostic = () => undefined,
  voiceHooks: ChatVoiceHooks = {},
  conversationStore: ConversationStoreApi | null = null,
): ChatIpcService {
  removeChatIpcHandlers(ipc);
  service = new ChatIpcService(getWindow, getRuntime, diagnostic, voiceHooks, conversationStore);
  ipc.handle(CHAT_CREATE_CONVERSATION_CHANNEL, (event, payload) => service!.createConversation(event, payload));
  if (conversationStore) {
    ipc.handle(CHAT_OPEN_CONVERSATION_CHANNEL, (event, payload) => service!.openConversation(event, payload));
    ipc.handle(CHAT_LIST_MESSAGES_CHANNEL, (event, payload) => service!.listMessages(event, payload));
    ipc.handle(CHAT_LIST_CONVERSATIONS_CHANNEL, (event, payload) => service!.listConversations(event, payload));
  }
  ipc.handle(CHAT_SEND_MESSAGE_CHANNEL, (event, payload) => service!.send(event, payload));
  ipc.handle(CHAT_CANCEL_REQUEST_CHANNEL, (event, payload) => service!.cancel(event, payload));
  return service;
}
export function cleanupChatWindow(window: BrowserWindow, origin: ChatCleanupOrigin = "window_closed", current = service): void {
  current?.cleanupWindow(window, origin);
}
export function beginChatRuntimeSwitch(): boolean { return service?.beginRuntimeSwitch() ?? false; }
export function refreshChatRuntimeAfterSwitch(): void { service?.refreshRuntimeAfterSwitch(); }
export function endChatRuntimeSwitch(): void { service?.endRuntimeSwitch(); }
export function removeChatIpcHandlers(ipc: IpcMainLike = ipcMain): void {
  ipc.removeHandler(CHAT_CREATE_CONVERSATION_CHANNEL);
  ipc.removeHandler(CHAT_OPEN_CONVERSATION_CHANNEL);
  ipc.removeHandler(CHAT_LIST_MESSAGES_CHANNEL);
  ipc.removeHandler(CHAT_LIST_CONVERSATIONS_CHANNEL);
  ipc.removeHandler(CHAT_SEND_MESSAGE_CHANNEL);
  ipc.removeHandler(CHAT_CANCEL_REQUEST_CHANNEL);
  service?.dispose();
  service = null;
}
