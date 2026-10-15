import type { ChatConversationSummary } from "../../shared/ipc-contract";
import { HolographicFrame } from "./HolographicFrame";

interface ConversationsPanelProps {
  conversations: readonly ChatConversationSummary[];
  activeConversationId: string | null;
  isVisible?: boolean;
  busy: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  onNew(): void;
  onSelect(conversationId: string): void;
  onLoadMore(): void;
}

function activityLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function ConversationsPanel({ conversations, activeConversationId, isVisible = true, busy, loading, hasMore, error,
  onNew, onSelect, onLoadMore }: ConversationsPanelProps) {
  return <aside className="conversations-history surface-panel" aria-label="Historial de conversaciones"
    aria-hidden={!isVisible} inert={!isVisible}>
    <HolographicFrame />
    <header className="conversation-history-heading">
      <div><span className="section-kicker">ARCHIVO CONVERSACIONAL</span><h2>Conversaciones</h2></div>
      <button className="conversation-new-button" type="button" onClick={onNew} disabled={busy}>
        <span aria-hidden="true">＋</span> Nueva conversación
      </button>
    </header>
    {error && <p className="conversation-history-error" role="alert">{error}</p>}
    <div className="conversation-history-list" aria-live="polite">
      {conversations.map((conversation) => <button key={conversation.conversationId}
        className={`conversation-history-item${conversation.conversationId === activeConversationId ? " conversation-history-item--active" : ""}`}
        type="button" disabled={busy || loading} aria-current={conversation.conversationId === activeConversationId ? "true" : undefined}
        onClick={() => onSelect(conversation.conversationId)}>
        <span className="conversation-history-item-copy"><strong className="conversation-history-title">{conversation.title || "Nueva conversación"}</strong>
          <small className="conversation-history-count">{conversation.messageCount === 0 ? "Sin mensajes" : `${conversation.messageCount} mensajes`}</small></span>
        <time className="conversation-history-time" dateTime={conversation.updatedAt}>{activityLabel(conversation.updatedAt)}</time>
      </button>)}
      {!loading && conversations.length === 0 && !error && <p className="conversation-history-empty">Todavía no hay conversaciones guardadas.</p>}
      {loading && conversations.length === 0 && <p className="conversation-history-empty" role="status">Cargando conversaciones…</p>}
    </div>
    {hasMore && <button className="conversation-history-more" type="button" disabled={busy || loading} onClick={onLoadMore}>
      {loading ? "Cargando…" : "Ver conversaciones anteriores"}
    </button>}
  </aside>;
}
