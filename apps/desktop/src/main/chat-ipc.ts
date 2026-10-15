import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { performance } from "node:perf_hooks";
import { createHash, type Hash } from "node:crypto";
import { isChatCancelRequest, isChatConversationCreateRequest, isChatConversationListRequest, isChatConversationMessagesRequest, isChatConversationOpenRequest,
  isChatConversationRenameRequest, isChatConversationResponse, isChatEventEnvelope, isChatSendMessageRequest } from "../shared/chat-ipc-validation.js";
import {
  CHAT_CANCEL_REQUEST_CHANNEL, CHAT_CREATE_CONVERSATION_CHANNEL, CHAT_EVENT_CHANNEL, CHAT_LIST_CONVERSATIONS_CHANNEL,
  CHAT_LIST_MESSAGES_CHANNEL, CHAT_OPEN_CONVERSATION_CHANNEL, CHAT_RENAME_CONVERSATION_CHANNEL, CHAT_SEND_MESSAGE_CHANNEL,
  type AuthorizationRequiredEvent, type ChatConversationMessage, type ChatConversationMessagesRequest,
  type ChatConversationResponse, type ChatMessageCursor, type ChatConversationListRequest, type SpotifyNowPlayingEvent,
  type ChatEventEnvelope, type ChatIpcErrorCode, type ChatSendMessageRequest,
} from "../shared/ipc-contract.js";
import { isTrustedIpcSender } from "../shared/ipc-security.js";

export interface ConversationRuntimeApi {
  createConversation(): string;
  restoreConversation?(conversationId: string, messages: readonly (Pick<ChatConversationMessage, "role" | "content"> & { sequence?: number })[],
    toolRecords?: readonly unknown[]): boolean;
  sendMessage(input: Readonly<ChatSendMessageRequest>): Promise<RuntimeMessageResult>;
  cancelRequest(requestId: string, origin?: string): boolean;
  onEvent(listener: (event: RuntimeMessageEvent) => void): () => void;
  getMemoryMode?(): string;
  close(): Promise<void>;
}
export interface ConversationStoreApi {
  createConversation(conversationId?: string): Promise<{ conversationId: string }>;
  listConversations(options?: ChatConversationListRequest): Promise<{
    conversations: Array<{ conversationId: string; title: string; createdAt: string; updatedAt: string; messageCount: number }>;
    nextCursor: { updatedAt: string; conversationId: string } | null;
  }>;
  getConversation(conversationId: string): Promise<unknown | null>;
  appendMessage(conversationId: string, message: { role: "user" | "assistant"; content: string }): Promise<unknown>;
  appendToolRecord?(conversationId: string, record: { turnId: string; userSequence: number; toolName: string;
    callIdHash: string; status: "succeeded" | "failed" | "unknown" }): Promise<unknown>;
  listToolRecords?(conversationId: string, options?: { limit?: number }): Promise<readonly unknown[]>;
  updateTitle?(conversationId: string, title: string, source: "automatic" | "manual"): Promise<boolean>;
  listMessages(conversationId: string, options?: { limit?: number; cursor?: ChatMessageCursor | null }): Promise<{
    messages: Array<ChatConversationMessage & { sequence?: number }>; nextCursor: ChatMessageCursor | null; incompleteTail: boolean;
  }>;
}
export type RuntimeMessageResult =
  | { conversationId: string; requestId: string; status: "completed"; text: string;
      presentation?: { kind: "diagnostic" | "tool_catalog"; technicalDetail: string } }
  | { conversationId: string; requestId: string; status: "cancelled" }
  | { conversationId: string; requestId: string; status: "error"; error: { code: string; message: string; diagnostic?: { stage: string; code: string; durationMs: number } } };
export type RuntimeMessageEvent = RuntimeMessageResult | { conversationId: string; requestId: string; status: "processing" }
  | { conversationId: string; requestId: string; status: "text_delta"; delta: string }
  | { conversationId: string; requestId: string; status: "text_reset" }
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
  firstTextDeltaDispatched?: boolean;
  streamedTextHash?: Hash;
  streamedTextLength?: number;
  streamedTextBytes?: number;
  titleUserMessage?: string;
  queued?: boolean;
}
export type ConversationTitleGenerator = (input: { userMessage: string; assistantMessage: string }) => Promise<string | null>;

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
function safeErrorIdentifier(value: unknown, key: "name" | "code"): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(candidate) ? candidate : null;
}
function safeValidationReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const reason = (error as Record<string, unknown>).validationReason;
  return typeof reason === "string" && ["invalid_shape", "invalid_role", "content_not_string", "content_too_large",
    "disallowed_control_character", "empty_content", "invalid_status"].includes(reason) ? reason : null;
}
function safePersistenceFailureDetails(error: unknown, resultText: unknown, active: ActiveRequest) {
  const cause = typeof error === "object" && error !== null
    ? (error as { cause?: unknown }).cause : undefined;
  const textType = typeof resultText;
  const text = typeof resultText === "string" ? resultText : null;
  const textBytes = text === null ? null : Buffer.byteLength(text, "utf8");
  const streamedTextMatchesFinal = text !== null && active.streamedTextHash
    ? active.streamedTextHash.copy().digest("hex") === createHash("sha256").update(text, "utf8").digest("hex")
    : null;
  return { stage: "assistant_message", errorName: safeErrorIdentifier(error, "name"),
    errorCode: safeErrorIdentifier(error, "code"), causeName: safeErrorIdentifier(cause, "name"),
    causeCode: safeErrorIdentifier(cause, "code"), validationReason: safeValidationReason(error),
    resultTextType: textType, resultTextLength: text?.length ?? null, resultTextBytes: textBytes,
    resultTextEmpty: text === null ? null : text.trim().length === 0,
    resultTextOverLimit: textBytes === null ? null : textBytes > 1024 * 1024,
    resultTextHasDisallowedControl: text === null ? null : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text),
    streamedTextLength: active.streamedTextLength ?? null, streamedTextBytes: active.streamedTextBytes ?? null,
    streamedTextMatchesFinal };
}
function isRuntimeEvent(value: unknown): value is RuntimeMessageEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.conversationId !== "string" || typeof event.requestId !== "string") return false;
  if (event.status === "processing" || event.status === "cancelled") return true;
  if (event.status === "text_delta") return typeof event.delta === "string" && event.delta.length > 0
    && event.delta.length <= 16_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(event.delta);
  if (event.status === "text_reset") return true;
  if (event.status === "authorization_required" || event.status === "spotify_now_playing") return isChatEventEnvelope(value);
  if (event.status === "completed") return typeof event.text === "string";
  return event.status === "error" && typeof event.error === "object" && event.error !== null
    && typeof (event.error as Record<string, unknown>).code === "string"
    && typeof (event.error as Record<string, unknown>).message === "string";
}

/** Main-process allowlisted transport; Runtime is injected only into this Main-process service. */
export class ChatIpcService {
  private readonly activeByRequest = new Map<string, ActiveRequest>();
  private readonly queuedRequests: ActiveRequest[] = [];
  private runningRequestId: string | null = null;
  private readonly seenRequestIds = new WeakMap<object, Set<string>>();
  private conversationId: string | null = null;
  private conversationPersisted = false;
  private unsubscribeRuntime: (() => void) | null = null;
  private runtimeSwitching = false;

  constructor(
    private readonly getWindow: () => ChatWindowContext | null,
    private readonly getRuntime: () => ConversationRuntimeApi | null,
    private readonly diagnostic: ChatDiagnostic = () => undefined,
    private readonly voiceHooks: ChatVoiceHooks = {},
    private readonly conversationStore: ConversationStoreApi | null = null,
    private readonly titleGenerator?: ConversationTitleGenerator,
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
    if (this.conversationId && (!newConversation || (this.conversationStore && !this.conversationPersisted)))
      return { ok: true, conversationId: this.conversationId };
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
    try {
      const conversationId = runtime.createConversation();
      if (!isChatConversationResponse({ ok: true, conversationId })) throw new Error("runtime_conversation_id_invalid");
      this.conversationId = conversationId;
      this.conversationPersisted = false;
      return { ok: true, conversationId };
    } catch {
      return { ok: false, error: { code: "operation_failed", message: "A conversation could not be prepared." } };
    }
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
      const toolRecords = await this.conversationStore.listToolRecords?.(payload.conversationId, { limit: 512 }) ?? [];
      if (this.conversationId !== payload.conversationId)
        runtime.restoreConversation(payload.conversationId, page.messages.filter(message => message.content.trim().length > 0)
          .map(({ role, content, sequence }) => ({ role, content, sequence })), toolRecords);
      this.conversationId = payload.conversationId;
      this.conversationPersisted = true;
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
      const conversations = page.conversations.map(({ conversationId, title, createdAt, updatedAt, messageCount }) =>
        ({ conversationId, title, createdAt, updatedAt, messageCount }));
      return { ok: true as const, conversations, nextCursor: page.nextCursor };
    } catch (error) {
      const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
      const errorCode = typeof rawCode === "string" && /^[A-Za-z0-9_]{2,40}$/u.test(rawCode) ? rawCode : null;
      const errorName = error instanceof Error && ["ConversationStoreError", "Error", "TypeError"].includes(error.name)
        ? error.name : "UnknownError";
      this.trace("conversation_list_failed", { stage: "persistent_read", errorName, errorCode });
      return { ok: false as const, error: { code: "operation_failed" as const, message: "Conversations could not be listed." } };
    }
  }

  async renameConversation(event: ChatIpcEvent, payload: unknown) {
    const window = this.getWindow();
    if (!window || !isTrustedIpcSender(event, window)) throw new Error("untrusted_ipc_sender");
    if (!isChatConversationRenameRequest(payload)) return { ok: false as const,
      error: { code: "invalid_request" as const, message: "The conversation rename request is invalid." } };
    const store = this.conversationStore;
    if (!store?.updateTitle) return { ok: false as const,
      error: { code: "operation_failed" as const, message: "Conversation titles cannot be changed right now." } };
    const title = payload.title.replace(/\s+/gu, " ").trim();
    if (!title || title.length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(title))
      return { ok: false as const, error: { code: "invalid_title" as const,
        message: "The title must contain 1 to 120 characters." } };
    try {
      const updated = await store.updateTitle(payload.conversationId, title, "manual");
      if (!updated) return { ok: false as const, error: { code: "operation_failed" as const,
        message: "The conversation title could not be updated." } };
      return { ok: true as const, conversationId: payload.conversationId, title };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      this.trace("conversation_rename_failed", { stage: "persistent_write",
        errorCode: typeof code === "string" && ["conversation_not_found", "conversation_title_invalid"].includes(code) ? code : null });
      if (code === "conversation_not_found") return { ok: false as const,
        error: { code: "conversation_not_found" as const, message: "This conversation no longer exists." } };
      if (code === "conversation_title_invalid") return { ok: false as const,
        error: { code: "invalid_title" as const, message: "The title must contain 1 to 120 characters." } };
      return { ok: false as const, error: { code: "operation_failed" as const,
        message: "The conversation title could not be saved." } };
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
    const pendingForConversation = this.queuedRequests.filter((activeRequest) =>
      activeRequest.request.conversationId === request.conversationId).length;
    if (pendingForConversation >= 3) return reject("busy", "The conversation queue is full.");
    seen.add(request.requestId);
    if (seen.size > 1_024) seen.delete(seen.values().next().value as string);
    this.seenRequestIds.set(window as object, seen);
    const active: ActiveRequest = { window, request, terminal: false, cancelPending: false, startedAt: performance.now() };
    this.activeByRequest.set(request.requestId, active);
    this.trace("main_ipc_received", { requestId: request.requestId, source: request.source });
    if (request.source === "typed" || request.source === "voice") {
      try { this.voiceHooks.onNewInteraction?.(request.requestId, request.source); } catch { /* Speech cancellation must not block chat. */ }
    }
    this.trace("ipc_request_accepted", { conversationId: request.conversationId, requestId: request.requestId });
    if (this.runningRequestId) {
      active.queued = true;
      this.queuedRequests.push(active);
      this.trace("request_queued", { conversationId: request.conversationId, requestId: request.requestId,
        queueDepth: pendingForConversation + 1 });
      this.emit(active, { conversationId: request.conversationId, requestId: request.requestId, status: "queued" });
    } else this.startRequest(active);
    return { ok: true as const, accepted: true as const, conversationId: request.conversationId, requestId: request.requestId };
  }

  private startRequest(active: ActiveRequest): void {
    if (active.terminal) return;
    const { request } = active;
    const runtime = this.getRuntime();
    if (!runtime) {
      this.complete(active, { conversationId: request.conversationId, requestId: request.requestId, status: "error",
        error: { code: "runtime_unavailable", message: "Runtime is not connected." } });
      return;
    }
    active.queued = false;
    this.runningRequestId = request.requestId;
    this.trace("request_dequeued", { conversationId: request.conversationId, requestId: request.requestId,
      queueDepth: this.queuedRequests.length });
    const operation = (async (): Promise<RuntimeMessageResult> => {
      if (this.conversationStore) {
        active.persistencePending = true;
        if (!this.conversationPersisted) {
          const persistenceStartedAt = performance.now();
          await this.conversationStore.createConversation(request.conversationId);
          this.conversationPersisted = true;
          this.trace("conversation_created_persisted", { requestId: request.requestId,
            durationMs: performance.now() - persistenceStartedAt });
        }
        const persistenceStartedAt = performance.now();
        const savedUserMessage = await this.conversationStore.appendMessage(request.conversationId,
          { role: "user", content: request.text });
        const savedRecord = typeof savedUserMessage === "object" && savedUserMessage !== null
          ? savedUserMessage as { message?: { sequence?: unknown } } : null;
        if (savedRecord?.message?.sequence === 1) active.titleUserMessage = request.text;
        active.persistencePending = false;
        this.trace("user_message_persisted", { requestId: request.requestId, source: request.source,
          durationMs: performance.now() - persistenceStartedAt });
      }
      if (active.cancellationRequested) return { conversationId: request.conversationId,
        requestId: request.requestId, status: "cancelled" };
      this.trace("runtime_dispatch_started", { requestId: request.requestId, source: request.source,
        durationMs: performance.now() - active.startedAt });
      return runtime.sendMessage(request);
    })();
    void operation.then((result) => {
      if (!active.terminal) this.completeFromResult(active, result);
    }).catch(() => {
      if (!active.terminal) this.complete(active, {
        conversationId: request.conversationId, requestId: request.requestId, status: "error",
        error: { code: "operation_failed", message: "The conversation could not be saved or completed." },
      });
    });
  }

  private drainQueue(): void {
    if (this.runningRequestId) return;
    const next = this.queuedRequests.shift();
    if (!next) return;
    if (next.terminal) { this.drainQueue(); return; }
    this.startRequest(next);
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
    if (active.queued) {
      const index = this.queuedRequests.indexOf(active);
      if (index < 0) return failure(payload.requestId, "request_not_found", "No queued request matches this identifier.",
        active.request.conversationId);
      this.queuedRequests.splice(index, 1);
      this.trace("queued_request_cancelled", { conversationId: active.request.conversationId,
        requestId: active.request.requestId, origin: "user" });
      this.complete(active, { conversationId: active.request.conversationId,
        requestId: active.request.requestId, status: "cancelled" });
      return { ok: true as const, accepted: true as const, requestId: payload.requestId };
    }
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
    for (const queued of [...this.queuedRequests]) {
      if (queued.window !== window) continue;
      const index = this.queuedRequests.indexOf(queued);
      if (index >= 0) this.queuedRequests.splice(index, 1);
      this.complete(queued, { conversationId: queued.request.conversationId,
        requestId: queued.request.requestId, status: "cancelled" });
    }
    for (const active of [...this.activeByRequest.values()]) {
      if (active.window !== window || active.queued) continue;
      this.trace("request_cleanup_cancel", { conversationId: active.request.conversationId,
        requestId: active.request.requestId, origin });
      if (active.persistencePending) active.cancellationRequested = true;
      else {
        try { this.getRuntime()?.cancelRequest(active.request.requestId, origin); }
        catch { /* Runtime closes with the app. */ }
      }
      // The window is no longer a valid recipient. Finalize locally so late Runtime
      // events cannot be forwarded into a torn-down renderer.
      active.terminal = true;
      this.activeByRequest.delete(active.request.requestId);
      if (this.runningRequestId === active.request.requestId) this.runningRequestId = null;
    }
    this.drainQueue();
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
    this.conversationPersisted = false;
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
    if (event.status === "text_delta") {
      active.streamedTextHash ??= createHash("sha256");
      active.streamedTextHash.update(event.delta, "utf8");
      active.streamedTextLength = (active.streamedTextLength ?? 0) + event.delta.length;
      active.streamedTextBytes = (active.streamedTextBytes ?? 0) + Buffer.byteLength(event.delta, "utf8");
      if (!active.firstTextDeltaDispatched) {
        active.firstTextDeltaDispatched = true;
        this.trace("first_text_delta_ipc_dispatched", { requestId: event.requestId, source: active.request.source,
          durationMs: performance.now() - active.startedAt });
      }
      this.emit(active, event);
      return;
    }
    if (event.status === "text_reset") {
      active.streamedTextHash = createHash("sha256");
      active.streamedTextLength = 0;
      active.streamedTextBytes = 0;
      this.emit(active, event);
      return;
    }
    if (event.status === "authorization_required" || event.status === "spotify_now_playing") {
      this.emit(active, event);
      return;
    }
    this.completeFromResult(active, event);
  }

  private completeFromResult(active: ActiveRequest, result: RuntimeMessageResult): void {
    if (active.terminal) return;
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
        const persistenceStartedAt = performance.now();
        active.completionPromise = this.conversationStore.appendMessage(result.conversationId,
          { role: "assistant", content: result.text }).then(() => {
          this.trace("assistant_message_persisted", { requestId: active.request.requestId,
            durationMs: performance.now() - persistenceStartedAt });
          if (active.titleUserMessage) this.startAutomaticTitle(active, result.text);
          this.dispatchCompletedResult(active, result);
        }).catch((error: unknown) => {
          this.trace("conversation_persist_failed", safePersistenceFailureDetails(error, result.text, active));
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

  private startAutomaticTitle(active: ActiveRequest, assistantMessage: string): void {
    const store = this.conversationStore;
    const generateTitle = this.titleGenerator;
    if (!store?.updateTitle || !generateTitle || !active.titleUserMessage) return;
    const { conversationId, requestId } = active.request;
    void generateTitle({ userMessage: active.titleUserMessage, assistantMessage }).then(async (title) => {
      if (!title) return;
      const updated = await store.updateTitle!(conversationId, title, "automatic");
      if (!updated || active.window.isDestroyed?.()) return;
      const event: ChatEventEnvelope = { conversationId, requestId, status: "conversation_title_updated", title, source: "automatic" };
      if (!isChatEventEnvelope(event)) return;
      try {
        active.window.webContents.send(CHAT_EVENT_CHANNEL, event);
        this.trace("conversation_title_updated", { requestId });
      } catch { this.trace("conversation_title_event_failed", { requestId }); }
    }).catch(() => { this.trace("conversation_title_generation_failed", { requestId }); });
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
    if (safeEvent.status === "completed") this.trace("response_ipc_dispatched", { requestId: active.request.requestId,
      source: active.request.source, durationMs: performance.now() - active.startedAt });
    this.activeByRequest.delete(active.request.requestId);
    if (this.runningRequestId === active.request.requestId) this.runningRequestId = null;
    this.drainQueue();
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
  titleGenerator?: ConversationTitleGenerator,
): ChatIpcService {
  removeChatIpcHandlers(ipc);
  service = new ChatIpcService(getWindow, getRuntime, diagnostic, voiceHooks, conversationStore, titleGenerator);
  ipc.handle(CHAT_CREATE_CONVERSATION_CHANNEL, (event, payload) => service!.createConversation(event, payload));
  if (conversationStore) {
    ipc.handle(CHAT_OPEN_CONVERSATION_CHANNEL, (event, payload) => service!.openConversation(event, payload));
    ipc.handle(CHAT_LIST_MESSAGES_CHANNEL, (event, payload) => service!.listMessages(event, payload));
    ipc.handle(CHAT_LIST_CONVERSATIONS_CHANNEL, (event, payload) => service!.listConversations(event, payload));
    ipc.handle(CHAT_RENAME_CONVERSATION_CHANNEL, (event, payload) => service!.renameConversation(event, payload));
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
  ipc.removeHandler(CHAT_RENAME_CONVERSATION_CHANNEL);
  ipc.removeHandler(CHAT_SEND_MESSAGE_CHANNEL);
  ipc.removeHandler(CHAT_CANCEL_REQUEST_CHANNEL);
  service?.dispose();
  service = null;
}
