import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, UIEvent } from "react";
import type { PttVoiceSnapshot } from "../voice/ptt-voice-controller";
import type { VoiceFollowupStatus } from "../voice/voice-followup-controller";
import type { AuthorizationProvider, ChatAuthorizationRequirement, ChatPresentationMetadata, SpotifyNowPlayingCard } from "../../shared/ipc-contract";
import { HolographicFrame } from "./HolographicFrame";

export interface VoiceTranscriptItem {
  readonly sessionId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly text: string;
  readonly language: string | null;
}

export interface ConversationChatMessage {
  readonly id: string;
  readonly requestId: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly source: "typed" | "voice";
  readonly status: "sending" | "processing" | "completed" | "cancelled" | "error";
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly error?: string;
  readonly originalRequestText?: string;
  readonly presentation?: ChatPresentationMetadata;
}

interface ConversationPanelProps {
  snapshot: PttVoiceSnapshot;
  transcripts: readonly VoiceTranscriptItem[];
  chatMessages?: readonly ConversationChatMessage[];
  authorizationRequirements?: Readonly<Record<string, ChatAuthorizationRequirement>>;
  spotifyNowPlayingCards?: Readonly<Record<string, SpotifyNowPlayingCard>>;
  authorizationAttempts?: Readonly<Record<string, { state: "connecting" | "connected" | "cancelled" | "error"; message?: string }>>;
  chatNotice?: string | null;
  voiceSpeechStatus?: { requestId: string; state: "preparing" | "speaking" | "cancelling" | "error"; message?: string } | null;
  followupStatus?: VoiceFollowupStatus;
  followupError?: string | null;
  interactionCancelable?: boolean;
  cancellationPending?: boolean;
  chatBusy?: boolean;
  onSendMessage?(text: string): void;
  onCancelInteraction?(): void;
  onConnectAuthorization?(provider: AuthorizationProvider, requestId: string): void;
  onCancelAuthorization?(provider: AuthorizationProvider, requestId: string): void;
  onRetryAuthorizedRequest?(text: string, requestId: string): void;
  onOpenSpotifyTrack?(url: string): void;
  transcriptNotice: string | null;
  onStart(): void;
  onFinish(): void;
  onRecover(): void;
}

const ERROR_MESSAGES: Record<string, string> = {
  permission_denied: "Permiso del micrófono denegado. Revisa los permisos de Windows y vuelve a intentarlo.",
  microphone_unavailable: "No se encontró un micrófono disponible.",
  microphone_error: "No se pudo capturar audio. Comprueba el micrófono e inténtalo de nuevo.",
  audio_conversion_failed: "No se pudo preparar el audio para la transcripción.",
  audio_too_large: "La grabación supera el tamaño permitido.",
  audio_too_long: "La grabación superó los 30 segundos.",
  main_cancel_unconfirmed: "Main no confirmó la cancelación. Recupera la sesión antes de volver a grabar.",
  session_cleanup_required: "Hay una sesión anterior pendiente de recuperación.",
  VOICE_PTT_TRANSCRIPTION_FAILED: "No se pudo transcribir la grabación. Puedes intentarlo de nuevo.",
  voice_session_unavailable: "La sesión de voz ya no está disponible.",
};

const STATUS_ANNOUNCEMENTS: Record<PttVoiceSnapshot["status"], string> = {
  idle: "",
  starting: "Solicitando acceso al micrófono.",
  listening: "Grabación activa. Puedes finalizar o cancelar.",
  finishing: "Preparando el audio grabado.",
  processing: "Transcripción en curso.",
  cancelling: "Cancelando la sesión de voz.",
  recovering: "Recuperando la cancelación pendiente.",
  "transcript-ready": "",
  error: "La operación de voz encontró un error.",
  "recovery-required": "Se requiere recuperar la sesión anterior antes de grabar.",
};

function errorMessage(snapshot: PttVoiceSnapshot): string | null {
  if (!snapshot.error) return null;
  return ERROR_MESSAGES[snapshot.error.code] ?? snapshot.error.message;
}

function primaryActionLabel(snapshot: PttVoiceSnapshot): string {
  switch (snapshot.status) {
    case "listening": return "Finalizar grabación y transcribir";
    case "starting": return "Solicitando acceso al micrófono";
    case "finishing": return "Preparando audio para transcribir";
    case "processing": return "Transcripción en curso";
    case "cancelling": return "Cancelando grabación";
    case "recovering": return "Recuperando sesión Voice";
    case "transcript-ready": return "Iniciar una nueva grabación de voz";
    case "error": return snapshot.canStart ? "Reintentar grabación de voz" : "Grabación no disponible";
    case "recovery-required": return "Se requiere recuperar la sesión anterior";
    default: return "Iniciar grabación de voz";
  }
}

function resizeComposer(textarea: HTMLTextAreaElement): boolean {
  textarea.style.height = "auto";
  const styles = window.getComputedStyle(textarea);
  const parsedLineHeight = Number.parseFloat(styles.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0 ? parsedLineHeight : 18;
  const parsedPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  const verticalPadding = Number.isFinite(parsedPadding) ? parsedPadding : 4;
  const minHeight = lineHeight + verticalPadding;
  const maxHeight = lineHeight * 6 + verticalPadding;
  const contentHeight = Math.max(textarea.scrollHeight, minHeight);
  textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  return contentHeight > minHeight + 1;
}

export function ConversationPanel({ snapshot, transcripts, chatMessages = [], authorizationRequirements = {}, spotifyNowPlayingCards = {},
  authorizationAttempts = {}, chatNotice, chatBusy = false, onSendMessage, onCancelInteraction,
  onConnectAuthorization, onCancelAuthorization, onRetryAuthorizedRequest, onOpenSpotifyTrack, transcriptNotice,
  voiceSpeechStatus = null, interactionCancelable = false, cancellationPending = false,
  followupStatus = "idle", followupError = null,
  onStart, onFinish, onRecover }: ConversationPanelProps) {
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [composerText, setComposerText] = useState("");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const runtimeProcessing = chatMessages.some((entry) => entry.role === "user"
    && (entry.status === "sending" || entry.status === "processing"));
  const [processingPhase, setProcessingPhase] = useState<ProcessingPhase>(() => runtimeProcessing ? "visible" : "hidden");
  const followTailRef = useRef(true);
  const lastTranscriptKeyRef = useRef<string | null>(null);
  const canStart = snapshot.canStart;
  const canFinish = snapshot.status === "listening";
  const message = errorMessage(snapshot);

  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (textarea) setComposerExpanded(resizeComposer(textarea));
  }, [composerText]);

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (typeof nextWidth !== "number" || nextWidth === width) return;
      width = nextWidth;
      setComposerExpanded(resizeComposer(textarea));
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (runtimeProcessing) {
      setProcessingPhase("visible");
      return;
    }
    setProcessingPhase((phase) => phase === "hidden" ? "hidden" : "fading");
    const timeout = window.setTimeout(() => setProcessingPhase("hidden"), 190);
    return () => window.clearTimeout(timeout);
  }, [runtimeProcessing]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const latestMessage = [...chatMessages].sort((a, b) => a.createdAt - b.createdAt).at(-1);
    const lastTranscript = transcripts.at(-1);
    const lastTranscriptKey = latestMessage ? latestMessage.id
      : lastTranscript ? `${lastTranscript.sessionId}:${lastTranscript.turnId}` : null;
    const ownMessageAdded = latestMessage
      ? latestMessage.role === "user" && latestMessage.id !== lastTranscriptKeyRef.current
      : lastTranscriptKey !== null && lastTranscriptKey !== lastTranscriptKeyRef.current;
    lastTranscriptKeyRef.current = lastTranscriptKey;
    if (!ownMessageAdded && !followTailRef.current) return;
    const bottom = Math.max(0, list.scrollHeight - list.clientHeight);
    if (Math.abs(list.scrollTop - bottom) > 1) list.scrollTop = bottom;
  }, [transcripts, chatMessages, transcriptNotice]);

  function updateTailFollowing(event: UIEvent<HTMLDivElement>) {
    const list = event.currentTarget;
    followTailRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 64;
  }

  return (
    <section className="conversation-panel surface-panel" aria-labelledby="conversation-title">
      <HolographicFrame />
      <header className="panel-heading conversation-heading">
        <h2 id="conversation-title">Conversación</h2>
      </header>

      <div ref={messageListRef} className="message-list" aria-label="Historial de conversación" tabIndex={0} onScroll={updateTailFollowing}>
        {[...transcripts.map((transcript): ConversationChatMessage => ({
          id: `${transcript.sessionId}:${transcript.turnId}`, requestId: transcript.requestId, conversationId: "voice",
          role: "user", text: transcript.text, source: "voice", status: "completed", createdAt: 0,
          sessionId: transcript.sessionId, turnId: transcript.turnId,
        })), ...chatMessages].sort((a, b) => a.createdAt - b.createdAt).map((entry) => entry.role === "user" ? (
          <article className={`message message--user${entry.source === "voice" ? " message--voice-transcript" : " message--runtime-chat"}`}
            data-message-source={entry.source} key={entry.id}>
            <div className="message-meta">
              <span className="message-marker message-marker--voice" aria-hidden="true">J</span>
              <strong>Jor</strong>
              {entry.source === "voice" ? <span className="voice-transcript-badge" aria-label="Transcripción real recibida por voz">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.7"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-4 0h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
                <span>Voz</span>
              </span> : <span className="message-source-badge">Texto</span>}
              {(entry.status === "cancelled" || entry.status === "error") && <span className={`chat-message-status chat-message-status--${entry.status}`}>{entry.error ?? (entry.status === "cancelled" ? "Cancelado" : "Error")}</span>}
            </div>
            <p>{entry.text}</p>
          </article>
        ) : (
          <article className="message message--nexa message--runtime-response" data-message-source="runtime" key={entry.id}>
            <div className="message-meta"><span className="message-marker message-marker--nexa" aria-hidden="true">N</span><strong>Nexa</strong><time>{new Date(entry.createdAt).toLocaleTimeString()}</time></div>
            <div className="assistant-message-bubble">
              <AssistantResponseText text={entry.text} presentation={entry.presentation} />
              {authorizationRequirements[entry.requestId] && (() => {
              const requirement = authorizationRequirements[entry.requestId];
              const attempt = authorizationAttempts[entry.requestId];
              const label = requirement.provider === "spotify" ? "Spotify" : "Microsoft";
              return <div className="authorization-card" data-authorization-request-id={entry.requestId}
                role="group" aria-label={`Conexión ${label} requerida`}>
                <div><strong>{requirement.canConnect ? `Conectar ${label}` : `Permisos de ${label} insuficientes`}</strong>
                  <span>{attempt?.message ?? (attempt?.state === "connected" ? `${label} conectado.`
                    : requirement.state === "reauthorization_required" ? `La sesión de ${label} necesita reconectarse.`
                      : requirement.state === "insufficient_permissions" ? `La operación requiere permisos que ${label} no concedió.`
                        : `${label} todavía no está conectado.`)}</span></div>
                {requirement.canConnect && attempt?.state !== "connected" && <button type="button"
                  disabled={attempt?.state === "connecting"} onClick={() => onConnectAuthorization?.(requirement.provider, entry.requestId)}>
                  {attempt?.state === "connecting" ? "Conectando…" : `Conectar ${label}`}
                </button>}
                {requirement.canConnect && attempt?.state === "connecting" && <button type="button"
                  onClick={() => onCancelAuthorization?.(requirement.provider, entry.requestId)}>Cancelar</button>}
                {attempt?.state === "connected" && requirement.retrySafe && entry.originalRequestText && <button type="button"
                  onClick={() => onRetryAuthorizedRequest?.(entry.originalRequestText!, entry.requestId)}>Reintentar solicitud</button>}
              </div>;
              })()}
              {spotifyNowPlayingCards[entry.requestId] && <SpotifyNowPlaying card={spotifyNowPlayingCards[entry.requestId]}
                onOpenTrack={onOpenSpotifyTrack} />}
            </div>
          </article>
        ))}
        {processingPhase !== "hidden" && (
          <div className={`assistant-processing${processingPhase === "fading" ? " assistant-processing--fading" : ""}`}
            data-phase={processingPhase} role="status">
            <span className="sr-only">Nexa está procesando la respuesta.</span>
            <span className="assistant-processing-dots" aria-hidden="true">
              <span /><span /><span />
            </span>
          </div>
        )}
        {chatNotice && <p className="chat-notice" role="status" aria-live="polite">{chatNotice}</p>}
        {transcriptNotice && <p className="voice-transcript-notice" role="status" aria-live="polite">{transcriptNotice}</p>}
      </div>

      <div className="composer-wrap">
        <form className="composer-form" data-expanded={composerExpanded} onSubmit={(event) => {
          event.preventDefault();
          const text = composerText.trim();
          if (!text || chatBusy) return;
          onSendMessage?.(text);
          setComposerText("");
          composerRef.current?.focus({ preventScroll: true });
        }}>
          <div className="composer-field">
            <span className="composer-prompt" aria-hidden="true">›</span>
            <label className="sr-only" htmlFor="message-composer">Escribir mensaje a Nexa</label>
            <textarea ref={composerRef} id="message-composer" className="composer-textarea" rows={1}
              placeholder="Escribí un mensaje a Nexa…" value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                if (composerText.trim() && !chatBusy) event.currentTarget.form?.requestSubmit();
              }} maxLength={16_000} />
            <button className="composer-send" type="submit" disabled={!composerText.trim() || chatBusy} aria-label="Enviar mensaje a Nexa">
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M3 10h13M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
          <div className="voice-ptt-controls" role="group" aria-label="Controles de voz">
            {interactionCancelable && <button
              className="voice-stop-button" type="button" onClick={onCancelInteraction}
              disabled={cancellationPending || voiceSpeechStatus?.state === "cancelling"}
              aria-label="Detener interacción" title="Detener interacción">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>
            </button>}
            {snapshot.status === "recovery-required" && (
              <button className="voice-secondary-button voice-recover-button" type="button" onClick={onRecover} aria-label="Recuperar cancelación pendiente de Main">Recuperar</button>
            )}
            <button
              className={`voice-ptt-button${canFinish ? " voice-ptt-button--listening" : ""}`}
              type="button"
              onClick={canFinish ? onFinish : onStart}
              disabled={(!canStart && !canFinish) || (chatBusy && !canFinish)}
              aria-label={primaryActionLabel(snapshot)}
              title={primaryActionLabel(snapshot)}
              data-voice-state={snapshot.status}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.7"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-4 0h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
            </button>
          </div>
        </form>
        <div className="composer-hint">
          {STATUS_ANNOUNCEMENTS[snapshot.status] && <span className="voice-status-copy" role="status" aria-live="polite">{STATUS_ANNOUNCEMENTS[snapshot.status]}</span>}
          {followupStatus === "preparing" && <span className="voice-status-copy voice-followup-status" role="status" aria-live="polite">Preparando escucha…</span>}
          {followupStatus === "listening" && <span className="voice-status-copy voice-followup-status" role="status" aria-live="polite">Escuchando… Podés hablar.</span>}
        </div>
        {message && <p className="voice-error-message" role="alert">{message}</p>}
        {voiceSpeechStatus?.state === "error" && <p className="voice-error-message" role="alert">{voiceSpeechStatus.message}</p>}
        {followupError && <p className="voice-error-message" role="alert">{followupError}</p>}
      </div>
    </section>
  );
}

type ProcessingPhase = "hidden" | "visible" | "fading";

function AssistantResponseText({ text, presentation }: { text: string; presentation?: ChatPresentationMetadata }) {
  const [visibleCharacters, setVisibleCharacters] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (typeof window === "undefined" || !text) {
      setVisibleCharacters(text.length);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setVisibleCharacters(text.length);
      return;
    }

    const startedAt = Date.now();
    const duration = Math.min(1_100, Math.max(260, text.length * 10));
    const reveal = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const nextLength = progress === 1 ? text.length : Math.max(1, Math.floor(text.length * progress));
      setVisibleCharacters(nextLength);
      if (progress === 1) window.clearInterval(timer);
    };
    setVisibleCharacters(0);
    const timer = window.setInterval(reveal, 20);
    reveal();
    return () => window.clearInterval(timer);
  }, [text]);

  const isTyping = visibleCharacters < text.length;
  async function copyTechnicalDetail() {
    if (!presentation?.technicalDetail) return;
    try {
      await window.nexaDesktop.copyTechnicalDetail(presentation.technicalDetail);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <div className="assistant-response-content">
      <div className="assistant-response-visual" aria-live={isTyping ? "off" : "polite"}>
        <SafeMarkdown text={`${text.slice(0, visibleCharacters)}${isTyping ? "▍" : ""}`} />
      </div>
      {presentation?.technicalDetail && <div className="technical-detail-action">
        <button type="button" onClick={() => { void copyTechnicalDetail(); }} aria-label="Copiar detalle técnico">
          Copiar detalle técnico
        </button>
        {copyState !== "idle" && <span role="status">{copyState === "copied" ? "Detalle copiado" : "No se pudo copiar el detalle"}</span>}
      </div>}
    </div>
  );
}

function SafeMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/u);
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  const flushParagraph = () => { if (paragraph.length) { blocks.push(<p key={`p-${blocks.length}`}>{renderInline(paragraph.join(" "))}</p>); paragraph = []; } };
  const flushList = () => { if (list) { const Tag = list.ordered ? "ol" : "ul"; blocks.push(<Tag key={`l-${blocks.length}`}>{list.items.map((item, index) => <li key={index}>{renderInline(item)}</li>)}</Tag>); list = null; } };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph(); flushList();
      if (code) { blocks.push(<pre key={`c-${blocks.length}`}><code>{code.join("\n")}</code></pre>); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line.trim());
    if (heading) { flushParagraph(); flushList(); const Tag = `h${heading[1].length}` as "h1" | "h2" | "h3"; blocks.push(<Tag key={`h-${blocks.length}`}>{renderInline(heading[2])}</Tag>); continue; }
    const bullet = /^\s*[-*+]\s+(.+)$/u.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (bullet || numbered) {
      flushParagraph(); const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] }; list.items.push((bullet ?? numbered)![1]); continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    flushList(); paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  if (code) blocks.push(<pre key={`c-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
  return <>{blocks}</>;
}

function renderInline(source: string): ReactNode[] {
  const parts: React.ReactNode[] = [];
  const token = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu;
  let last = 0; let match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    if (match.index > last) parts.push(source.slice(last, match.index));
    const value = match[0];
    if (value.startsWith("**")) parts.push(<strong key={match.index}>{value.slice(2, -2)}</strong>);
    else if (value.startsWith("`")) parts.push(<code key={match.index}>{value.slice(1, -1)}</code>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(value)!;
      let safeUrl: string | null = null;
      try { const parsed = new URL(link[2]); if (["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password) safeUrl = parsed.href; } catch { /* Render unsafe links as text. */ }
      parts.push(safeUrl ? <a key={match.index} href={safeUrl} target="_blank" rel="noopener noreferrer">{link[1]}</a> : link[1]);
    }
    last = match.index + value.length;
  }
  if (last < source.length) parts.push(source.slice(last));
  return parts;
}

function SpotifyNowPlaying({ card, onOpenTrack }: { card: SpotifyNowPlayingCard; onOpenTrack?: (url: string) => void }) {
  return <section className="spotify-now-playing" aria-label="Reproducción actual de Spotify">
    {card.imageUrl ? <img className="spotify-now-playing__artwork" src={card.imageUrl} alt="" referrerPolicy="no-referrer" />
      : <div className="spotify-now-playing__placeholder" aria-label="Carátula no disponible"><span>♫</span></div>}
    <div className="spotify-now-playing__details">
      <span className="spotify-now-playing__status">{card.playing ? "SONANDO AHORA" : "EN PAUSA"}</span>
      <strong>{card.name}</strong>
      <span>{card.artists.length ? card.artists.join(", ") : "Artistas no disponibles"}</span>
      {card.spotifyUrl && <button type="button" className="spotify-now-playing__link"
        onClick={() => onOpenTrack?.(card.spotifyUrl!)}>Abrir en Spotify</button>}
    </div>
  </section>;
}
