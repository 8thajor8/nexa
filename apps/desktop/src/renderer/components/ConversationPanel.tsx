import { mockConversation } from "../data/command-center-mock";
import { HolographicFrame } from "./HolographicFrame";

export function ConversationPanel() {
  return (
    <section className="conversation-panel surface-panel" aria-labelledby="conversation-title">
      <HolographicFrame />
      <header className="panel-heading conversation-heading">
        <div className="panel-heading-copy">
          <span className="section-kicker"><span className="kicker-mark" /> ESPACIO DE TRABAJO</span>
          <h2 id="conversation-title">Conversación</h2>
        </div>
        <span className="mock-tag"><span /> DEMO · MOCK</span>
      </header>

      <div className="conversation-context">
        <div className="context-glyph" aria-hidden="true"><span /><span /><span /></div>
        <div><strong>Sesión de demostración</strong><span>Los mensajes siguientes son contenido de muestra.</span></div>
        <span className="context-lock" aria-label="Los mensajes no se envían">LOCAL</span>
      </div>

      <div className="message-list" aria-label="Mensajes de ejemplo">
        {mockConversation.map((message) => (
          <article className={`message message--${message.speaker === "Tú" ? "user" : "nexa"}`} key={message.id}>
            <div className="message-meta">
              <span className={`message-marker${message.speaker === "Nexa" ? " message-marker--nexa" : ""}`} aria-hidden="true">
                {message.speaker === "Nexa" ? "N" : "T"}
              </span>
              <strong>{message.speaker}</strong>
              <span className="message-mock">MOCK</span>
              <time>{message.time}</time>
            </div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>

      <div className="composer-wrap">
        <label className="sr-only" htmlFor="message-composer">Entrada de mensaje de demostración</label>
        <div className="composer-field">
          <span className="composer-prompt" aria-hidden="true">›</span>
          <input id="message-composer" type="text" placeholder="La entrada de mensajes estará disponible en UI-02.2" disabled />
          <button className="composer-send" type="button" disabled aria-label="Enviar mensaje, no disponible en esta versión">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M3 10h13M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        <div className="composer-hint"><span>INTERFAZ INACTIVA</span><span>Los mensajes de demostración no se envían</span></div>
      </div>
    </section>
  );
}
