import { useEffect, useRef, useState } from "react";
import type { ChatConversationRenameResponse, ChatConversationSummary } from "../../shared/ipc-contract";
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
  onRenameCommitted(conversationId: string, title: string): void;
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
  onNew, onSelect, onLoadMore, onRenameCommitted }: ConversationsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editingId) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingId]);
  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
    setSaving(false);
  }
  async function saveEdit(conversationId: string) {
    if (saving) return;
    const normalized = draft.replace(/\s+/gu, " ").trim();
    if (!normalized) { setEditError("Escribe un título para guardar."); return; }
    if (normalized.length > 120) { setEditError("El título no puede superar los 120 caracteres."); return; }
    setSaving(true);
    setEditError(null);
    try {
      const result: ChatConversationRenameResponse = await window.nexaDesktop.chat.renameConversation({ conversationId, title: normalized });
      if (!result.ok) {
        setEditError(result.error.code === "invalid_title" ? "El título debe tener entre 1 y 120 caracteres."
          : result.error.message === "This conversation no longer exists." ? "La conversación ya no está disponible."
            : "No se pudo guardar el título. Inténtalo de nuevo.");
        setSaving(false);
        return;
      }
      cancelEdit();
      onRenameCommitted(result.conversationId, result.title);
    } catch {
      setEditError("No se pudo guardar el título. Inténtalo de nuevo.");
      setSaving(false);
    }
  }
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
      {conversations.map((conversation) => <div key={conversation.conversationId}
        className={`conversation-history-item${conversation.conversationId === activeConversationId ? " conversation-history-item--active" : ""}`}
        role="group" aria-label={`Conversación: ${conversation.title || "Nueva conversación"}`}>
        <button className="conversation-history-item-open" type="button" disabled={busy || loading || saving}
          aria-label={`Abrir conversación ${conversation.title || "Nueva conversación"}`}
          aria-current={conversation.conversationId === activeConversationId ? "true" : undefined}
          onClick={() => { cancelEdit(); onSelect(conversation.conversationId); }}>
          <span className="conversation-history-item-copy"><strong className="conversation-history-title">{conversation.title || "Nueva conversación"}</strong>
            <small className="conversation-history-count">{conversation.messageCount === 0 ? "Sin mensajes" : `${conversation.messageCount} mensajes`}</small></span>
          <time className="conversation-history-time" dateTime={conversation.updatedAt}>{activityLabel(conversation.updatedAt)}</time>
        </button>
        {editingId === conversation.conversationId ? <form className="conversation-title-editor" onSubmit={(event) => {
          event.preventDefault(); void saveEdit(conversation.conversationId);
        }} onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) { event.preventDefault(); cancelEdit(); }
          else if (event.key === "Enter") { event.preventDefault(); void saveEdit(conversation.conversationId); }
        }}>
          <input ref={inputRef} aria-label="Nuevo título de conversación" aria-invalid={editError !== null}
            value={draft} onChange={(event) => { setDraft(event.target.value); setEditError(null); }} disabled={saving} />
          <button type="submit" className="conversation-title-save" aria-label="Guardar título" title="Guardar" disabled={saving}>✓</button>
          <button type="button" className="conversation-title-cancel" aria-label="Cancelar renombrado" title="Cancelar" disabled={saving}
            onClick={cancelEdit}>×</button>
          {editError && <span className="conversation-title-edit-error" role="alert">{editError}</span>}
        </form> : <button className="conversation-title-edit-button" type="button" aria-label={`Renombrar ${conversation.title || "Nueva conversación"}`}
          title="Renombrar conversación" disabled={busy || loading} onClick={() => {
            setDraft(conversation.title || ""); setEditError(null); setEditingId(conversation.conversationId);
          }}><svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m12.8 3.2 4 4M3 17l3.9-.8L16.8 6.3a1.4 1.4 0 0 0-2-2L4.9 14.2 4 18Z"/></svg></button>}
      </div>)}
      {!loading && conversations.length === 0 && !error && <p className="conversation-history-empty">Todavía no hay conversaciones guardadas.</p>}
      {loading && conversations.length === 0 && <p className="conversation-history-empty" role="status">Cargando conversaciones…</p>}
    </div>
    {hasMore && <button className="conversation-history-more" type="button" disabled={busy || loading} onClick={onLoadMore}>
      {loading ? "Cargando…" : "Ver conversaciones anteriores"}
    </button>}
  </aside>;
}
