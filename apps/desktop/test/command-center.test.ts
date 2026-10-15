import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConversationPanel } from "../src/renderer/components/ConversationPanel";
import { PresencePanel } from "../src/renderer/components/PresencePanel";
import { Sidebar } from "../src/renderer/components/Sidebar";
import { WindowChrome } from "../src/renderer/components/WindowChrome";
import { HolographicFrame } from "../src/renderer/components/HolographicFrame";
import { DashboardModules } from "../src/renderer/components/DashboardModules";
import App from "../src/renderer/App";
import type { PttVoiceController } from "../src/renderer/voice/ptt-voice-controller";
import type { PttVoiceSnapshot, PttVoiceStatus } from "../src/renderer/voice/ptt-voice-controller";
import type { VoiceTranscriptItem } from "../src/renderer/components/ConversationPanel";
import { MicrophoneDeviceStore } from "../src/renderer/audio/microphone-device-store";
import { CommandHeader } from "../src/renderer/components/CommandHeader";
import { DEFAULT_DESKTOP_PREFERENCES } from "../src/renderer/desktop-preferences";

const idleSnapshot: PttVoiceSnapshot = { status: "idle", canStart: true };
const noop = () => undefined;
const testController = {
  getSnapshot: () => idleSnapshot,
  subscribe: () => () => undefined,
  start: async () => undefined,
  finish: async () => undefined,
  cancel: async () => undefined,
  recoverMainCancellation: async () => undefined,
} as unknown as PttVoiceController;

const testMicrophoneDevices = new MicrophoneDeviceStore({
  mediaDevices: { enumerateDevices: async () => [], addEventListener: () => undefined, removeEventListener: () => undefined },
});

function renderApp() {
  return renderToStaticMarkup(createElement(App, { voiceController: testController, microphoneDevices: testMicrophoneDevices }));
}

function renderConversation(snapshot: PttVoiceSnapshot = idleSnapshot, transcripts: VoiceTranscriptItem[] = []) {
  return renderToStaticMarkup(createElement(ConversationPanel, {
    snapshot, transcripts, transcriptNotice: null, onStart: noop, onFinish: noop, onCancel: noop, onRecover: noop,
  }));
}

function renderPresence(status: PttVoiceStatus = "idle", statusLabel = "PTT en espera") {
  return renderToStaticMarkup(createElement(PresencePanel, { status, statusLabel }));
}

describe("Command Center visual structure", () => {
  it("renders the primary date without the old timezone label and keeps the clocks", () => {
    const markup = renderToStaticMarkup(createElement(CommandHeader, {
      preferences: DEFAULT_DESKTOP_PREFERENCES,
      weather: { available: false, location: "Barcelona", temperatureC: null, condition: null, updatedAt: 0 },
    }));
    expect(markup).not.toContain("FECHA /");
    expect(markup).toContain("command-header-date");
    expect(markup).toContain("command-header-clocks");
    expect(markup.indexOf('class="command-header-left"')).toBeLessThan(markup.indexOf('class="command-header-clocks"'));
    expect(markup).toContain('class="command-weather"');
    expect(markup).not.toContain("holographic-frame");
  });
  it("keeps the primary workspace clean and preserves the existing panels", () => {
    const markup = renderApp();

    expect(markup).toContain("COMMAND CENTER");
    expect(markup).not.toContain('aria-label="Fondo de Windows activado"');
    expect(markup).not.toContain('aria-label="Actualizar el wallpaper de Windows"');
    expect(markup).toContain('aria-labelledby="conversation-title"');
    expect(markup).toContain('data-renderer-slot="presence"');
  });

  it("replaces development controls with the international header", () => {
    const markup = renderApp();

    expect(markup).not.toContain("<h1");
    expect(markup).toContain('aria-label="Nexa Command Center"');
    expect(markup).toContain("Barcelona");
    expect(markup).toContain("Buenos Aires");
    expect(markup).toContain("Costa Rica");
    expect(markup).not.toContain('class="command-header-brand"');
    expect(markup).not.toContain("FECHA ·");
    expect(markup).toContain("Consultando clima");
    expect(markup).not.toContain("Estado simulado");
    expect(markup).not.toContain("Probar IPC");
    expect(markup).not.toContain("Wallpaper ON");
    expect(markup).not.toContain("Actualizar");
    expect(markup).not.toContain("workspace-footer");
    expect(markup).toContain('class="nexa-core-mark"');
    expect(markup).toContain('class="nexa-core-mark__core"');
  });

  it("renders the three lower dashboard modules with clearly labeled mock and future data", () => {
    const markup = renderToStaticMarkup(createElement(DashboardModules, { assistantState: "En espera" }));

    expect(markup).toContain("Actividad reciente");
    expect(markup).toContain("DEMO · MOCK");
    expect(markup).toContain("Herramientas disponibles");
    expect(markup).toContain("Capacidades futuras, aún no conectadas");
    expect(markup).toContain("Estado del sistema");
    expect(markup).toContain("Los demás indicadores son demostrativos.");
    expect(markup).toContain("Sin conexión");
  });

  it("cleans panel and navigation labels while preserving their useful titles and the composer", () => {
    const conversation = renderConversation();
    const presence = renderPresence();
    const sidebar = renderToStaticMarkup(createElement(Sidebar));

    expect(conversation).toContain("Conversación");
    expect(conversation).not.toContain("ESPACIO DE TRABAJO");
    expect(conversation).not.toContain("INTERFAZ INACTIVA");
    expect(conversation).not.toContain("Entrada conectada a Runtime; no se muestran respuestas simuladas");
    expect(conversation).not.toContain("DEMO · MOCK");
    expect(conversation).not.toContain("Voz en espera. El micrófono se activa al iniciar una grabación.");
    expect(conversation).not.toContain("Sesión de demostración");
    expect(conversation).not.toContain("Los mensajes siguientes son contenido de muestra.");
    expect(conversation).not.toContain("LOCAL</span>");
    expect(conversation).toContain('id="message-composer"');
    expect(presence).toContain("Nexa Presence");
    expect(presence).not.toContain("PRESENCE · C-4");
    expect(presence).not.toContain("Contenedor independiente");
    expect(presence).toContain("Sin visualización");
    expect(sidebar).not.toContain("ESPACIO DE TRABAJO");
    expect(sidebar).not.toContain("ENTORNO LOCAL");
    expect(sidebar).not.toContain("Interfaz de demostración");
    expect(sidebar).toContain("NEXA");
    expect(sidebar).toContain("COMMAND CENTER");
    expect(sidebar).toContain('tabindex="0"');
  });

  it("keeps the dashboard modules inside the fixed viewport with only localized compact scrolling", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    const markup = renderApp();

    expect(styles).toMatch(/html\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/body\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 184px/s);
    expect(styles).toMatch(/\.workspace-grid\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/s);
    expect(styles).toMatch(/\.dashboard-modules\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*grid-row:\s*2[^}]*padding:/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.dashboard-modules\s*\{[^}]*overflow-x:\s*auto/);
    expect(styles).toMatch(/\.tool-list\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/s);
    expect(styles).toMatch(/@container \(max-width:\s*300px\)[\s\S]*?\.tool-list\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
    expect(markup).toContain('id="message-composer"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-label="Mostrar controles de ventana"');
  });

  it("adapts the international header and Settings modal to compact windows", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.workspace-header\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
    expect(styles).toMatch(/\.command-header-left\s*\{[^}]*display:\s*flex/s);
    expect(styles).toMatch(/\.command-header-clocks\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(102px, 1fr\)\)[^}]*justify-self:\s*end/s);
    expect(styles).toMatch(/\.command-weather\s*\{[^}]*border:\s*0[^}]*background:\s*transparent[^}]*box-shadow:\s*none/s);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.workspace-header\s*\{[^}]*grid-template-rows:\s*auto auto/s);
    expect(styles).toMatch(/\.settings-dialog\s*\{[^}]*max-height:\s*min\(850px, 92dvh\)/s);
    expect(styles).toMatch(/@media \(max-width:\s*390px\)[\s\S]*?\.settings-add-clock, \.settings-weather-form\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });

  it("uses one horizontal gap token and hides only the conversation history scrollbar", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    const conversation = renderConversation();

    expect(styles).toMatch(/--nexa-layout-column-gap:\s*18px/);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*column-gap:\s*var\(--nexa-layout-column-gap\)/s);
    expect(styles).toMatch(/\.workspace-grid\s*\{[^}]*column-gap:\s*var\(--nexa-layout-column-gap\)/s);
    expect(styles).toMatch(/\.dashboard-modules\s*\{[^}]*column-gap:\s*var\(--nexa-layout-column-gap\)/s);
    expect(styles).toMatch(/\.message-list\s*\{[^}]*overflow:\s*auto[^}]*scrollbar-width:\s*none/s);
    expect(styles).toMatch(/\.message-list::-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
    expect(styles).toMatch(/\.composer-wrap\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(styles).toMatch(/html\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/body\s*\{[^}]*overflow:\s*hidden/s);
    expect(conversation).toContain('class="message-list"');
    expect(conversation).toContain('tabindex="0"');
  });

  it("keeps the expanded conversation voice switch synchronized and defines reduced-motion transitions", () => {
    const markup = renderToStaticMarkup(createElement(ConversationPanel, {
      snapshot: idleSnapshot, transcripts: [], transcriptNotice: null, onStart: noop, onFinish: noop,
      onCancelInteraction: noop, onRecover: noop, showVoiceRepliesToggle: true, voiceRepliesEnabled: true,
    }));
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    expect(markup).toContain('role="switch" aria-label="Respuestas por voz" aria-checked="true"');
    expect(markup).toContain('id="conversation-voice-replies-state">ACTIVADO</small>');
    expect(styles).toMatch(/\.workspace-grid\s*\{[^}]*grid-template-columns 820ms/s);
    expect(styles).toMatch(/\.conversations-history\s*\{[^}]*transform 820ms/s);
    expect(styles).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition-duration:\s*0\.01ms/s);
  });

  it("renders accessible controls for frameless window operations", () => {
    const markup = renderToStaticMarkup(createElement(WindowChrome));

    expect(markup).toContain('data-visible="false"');
    expect(markup).toContain('aria-label="Mostrar controles de ventana"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('aria-label="Controles de ventana"');
    expect(markup).toContain('aria-label="Minimizar ventana"');
    expect(markup).toContain('aria-label="Maximizar ventana"');
    expect(markup).toContain('aria-label="Cerrar ventana"');
    expect(markup).toContain("window-drag-region");
  });

  it("uses a fixed viewport and keeps scrolling inside the intended regions", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    const sidebar = renderToStaticMarkup(createElement(Sidebar));

    expect(styles).toMatch(/html\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/body\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.workspace-shell\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.message-list\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.presence-panel\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-width:\s*none/s);
    expect(styles).toMatch(/\.primary-nav\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-width:\s*none/s);
    expect(styles).toMatch(/\.window-chrome\s*\{[^}]*position:\s*absolute[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/s);
    expect(styles).toMatch(/\.window-chrome-reveal\s*\{[^}]*height:\s*6px/s);
    expect(sidebar).toContain('tabindex="0"');
  });

  it("keeps the drag region separate from non-draggable window buttons and decorative borders", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    const chrome = readFileSync(new URL("../src/renderer/components/WindowChrome.tsx", import.meta.url), "utf8");

    expect(styles).toMatch(/\.window-drag-region\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(styles).toMatch(/\.window-drag-region\s*\{[^}]*height:\s*100%[^}]*flex:\s*1[^}]*-webkit-app-region:\s*drag/s);
    expect(styles).toMatch(/\.window-drag-region\s*\{[^}]*-webkit-user-select:\s*none[^}]*user-select:\s*none/s);
    expect(styles).toMatch(/\.window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(styles).toMatch(/\.window-control\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(styles).toMatch(/\.holographic-frame\s*\{[^}]*pointer-events:\s*none/s);
    expect(chrome).toMatch(/className="window-chrome-reveal"[\s\S]*?onPointerEnter=\{showChrome\}[\s\S]*?onFocus=\{showChrome\}/);
    expect(chrome).toMatch(/window-chrome-dismiss[\s\S]*?onPointerEnter=\{\(event\) => \{[\s\S]*event\.buttons === 0/);
  });

  it("locks the app viewport and confines scrolling to navigation, history, and Presence", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    const sidebar = renderToStaticMarkup(createElement(Sidebar));

    expect(styles).toMatch(/html\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/body\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.workspace-shell\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.primary-nav\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-width:\s*none/s);
    expect(styles).toMatch(/\.message-list\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.composer-wrap\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(styles).toMatch(/\.presence-panel\s*\{[^}]*overflow-y:\s*auto[^}]*scrollbar-width:\s*none/s);
    expect(sidebar).toContain('tabindex="0"');
  });

  it("keeps the top-edge reveal small and the hidden chrome offscreen and inert", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    const markup = renderToStaticMarkup(createElement(WindowChrome));

    expect(styles).toMatch(/\.window-chrome-reveal\s*\{[^}]*top:\s*0[^}]*height:\s*6px/s);
    expect(styles).toMatch(/\.window-chrome\s*\{[^}]*position:\s*absolute[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none[^}]*transition:\s*opacity/s);
    expect(styles).toMatch(/\.window-chrome--visible\s*\{[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/s);
    expect(styles).not.toMatch(/\.window-chrome(?:--visible)?\s*\{[^}]*transform:/s);
    expect(styles).toMatch(/\.window-chrome-dismiss\s*\{[^}]*top:\s*32px[^}]*height:\s*4px[^}]*pointer-events:\s*none/s);
    expect(styles).toMatch(/\.window-chrome-dismiss--active\s*\{[^}]*pointer-events:\s*auto/s);
    expect(markup).toContain('aria-controls="nexa-window-chrome"');
  });

  it("marks Command Center active and keeps future sections disabled", () => {
    const markup = renderToStaticMarkup(createElement(Sidebar));
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Command Center");
    expect(markup).toContain("Conversations");
    expect(markup).toContain("Tools");
    expect(markup).toContain("Activity");
    expect(markup).toContain("Settings");
    expect((markup.match(/disabled=""/g) ?? []).length).toBe(5);
    expect(markup).toContain('aria-label="Abrir Settings"');
    expect(markup).toContain("Memory");
    expect(markup).toContain("Files");
    expect(styles).toMatch(/\.sidebar\s*\{[^}]*padding:[^}]*\}/s);
    expect(styles).not.toMatch(/\.sidebar\s*\{[^}]*border-right:\s*1px/s);
    expect(styles).toMatch(/\.nav-item\s*\{[^}]*flex-direction:\s*column/s);
    expect(styles).toMatch(/\.nav-label\s*\{[^}]*text-align:\s*center/s);
    expect(styles).not.toMatch(/\.primary-nav\s*\{[^}]*display:\s*flex/s);
    expect((styles.match(/\.primary-nav\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/g) ?? []).length).toBe(3);
  });

  it("renders all scalable, non-interactive segmented SVG frame variants", () => {
    const panel = renderToStaticMarkup(createElement(HolographicFrame, { variant: "panel" }));
    const navigation = renderToStaticMarkup(createElement(HolographicFrame, { variant: "navigation" }));
    const control = renderToStaticMarkup(createElement(HolographicFrame, { variant: "control" }));
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

    for (const markup of [panel, navigation, control]) {
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('preserveAspectRatio="none"');
      expect(markup).toContain("holographic-frame-primary");
    }
    expect(styles).toMatch(/\.holographic-frame\s*\{[^}]*pointer-events:\s*none/s);
    expect(panel).toContain('data-variant="panel"');
    expect(navigation).toContain('data-variant="navigation"');
    expect(control).toContain('data-variant="control"');
    expect(panel).toContain("holographic-frame-secondary");
    expect(navigation).toContain("holographic-frame-node");
  });

  it("starts with an empty real conversation and enables the real message composer", () => {
    const markup = renderConversation();

    expect(markup).toContain('aria-label="Historial de conversación"');
    expect(markup).not.toContain('class="message message--user"');
    expect(markup).not.toContain('class="message message--nexa');
    expect(markup).not.toContain("MOCK");
    expect(markup).not.toContain("Sesión de demostración");
    expect(markup).toContain('id="message-composer"');
    expect(markup).toContain('placeholder="Escribí un mensaje a Nexa…"');
    expect(markup).toContain('aria-label="Enviar mensaje a Nexa"');
    expect(markup).not.toContain("Nexa · Runtime");
  });

  it("keeps an OAuth action inside its assistant response, not the user's message", () => {
    const requestId = "00000000-0000-4000-8000-000000000002";
    const markup = renderToStaticMarkup(createElement(ConversationPanel, {
      snapshot: idleSnapshot, transcripts: [], transcriptNotice: null, onStart: noop, onFinish: noop, onCancel: noop, onRecover: noop,
      chatMessages: [
        { id: requestId, requestId, conversationId: "conversation", role: "user", text: "¿Qué suena?", source: "typed", status: "completed", createdAt: 1 },
        { id: `${requestId}:response`, requestId, conversationId: "conversation", role: "assistant", text: "Conectá Spotify para consultar la pista.", source: "typed", status: "completed", createdAt: 2, originalRequestText: "¿Qué suena?" },
      ],
      authorizationRequirements: { [requestId]: { provider: "spotify", state: "not_connected", reason: "spotify_auth_required", canConnect: true, retrySafe: true } },
      onConnectAuthorization: noop,
    }));
    const userPosition = markup.indexOf('class="message message--user');
    const assistantPosition = markup.indexOf('class="message message--nexa');
    const authorizationPosition = markup.indexOf('class="authorization-card"');
    expect(userPosition).toBeGreaterThanOrEqual(0);
    expect(assistantPosition).toBeGreaterThan(userPosition);
    expect(authorizationPosition).toBeGreaterThan(assistantPosition);
  });

  it("renders Spotify Now Playing with real metadata, a safe link, and artwork fallback", () => {
    const requestId = "00000000-0000-4000-8000-000000000003";
    const base = {
      id: `${requestId}:response`, requestId, conversationId: "conversation", role: "assistant" as const,
      text: "", source: "typed" as const, status: "completed" as const, createdAt: 2,
    };
    const renderCard = (card: { name: string; artists: string[]; imageUrl: string | null; spotifyUrl: string | null; playing: boolean }) =>
      renderToStaticMarkup(createElement(ConversationPanel, {
        snapshot: idleSnapshot, transcripts: [], transcriptNotice: null, onStart: noop, onFinish: noop, onCancel: noop, onRecover: noop,
        chatMessages: [base], spotifyNowPlayingCards: { [requestId]: card }, onOpenSpotifyTrack: noop,
      }));
    const withImage = renderCard({ name: "Track", artists: ["Artist"], imageUrl: "https://i.scdn.co/image/abc", spotifyUrl: "https://open.spotify.com/track/abc123", playing: true });
    expect(withImage).toContain('src="https://i.scdn.co/image/abc"');
    expect(withImage).toContain("Track");
    expect(withImage).toContain("Artist");
    expect(withImage).toContain('class="spotify-now-playing__link"');
    expect(withImage).toContain("Abrir en Spotify");
    const withoutImage = renderCard({ name: "Track", artists: [], imageUrl: null, spotifyUrl: null, playing: false });
    expect(withoutImage).not.toContain("<img");
    expect(withoutImage).toContain("Carátula no disponible");
    expect(withoutImage).toContain("Artistas no disponibles");
    expect(withoutImage).toContain("Spotify");
    expect(withoutImage.match(/Track/g)?.length).toBe(1);
  });

  it("renders the live Spotify miniplayer and disables controls until a compatible device is available", () => {
    const unavailable = renderToStaticMarkup(createElement(DashboardModules, {
      assistantState: "En espera",
      spotifyStatus: { state: "not_connected", connected: false, deviceAvailable: false, controlsEnabled: false,
        track: null, message: "Conectá Spotify desde Nexa para ver la reproducción.", updatedAt: 1 },
    }));
    expect(unavailable).toContain("Reproductor de Spotify");
    expect(unavailable).toContain("Conectá Spotify desde el chat");
    expect(unavailable).toContain('aria-label="Pista anterior"');
    expect(unavailable).toContain('aria-label="Reanudar Spotify"');
    expect(unavailable).toContain('aria-label="Pista siguiente"');
    expect(unavailable.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(3);

    const playing = renderToStaticMarkup(createElement(DashboardModules, {
      assistantState: "En espera", spotifyStatus: { state: "playing", connected: true, deviceAvailable: true,
        controlsEnabled: true, track: { name: "Blue Hour", artists: ["Nexa Test"], imageUrl: "https://i.scdn.co/image/test",
          spotifyUrl: "https://open.spotify.com/track/abc123", playing: true }, message: null, updatedAt: 2 },
    }));
    expect(playing).toContain("Blue Hour");
    expect(playing).toContain("Nexa Test");
    expect(playing).toContain('aria-label="Pausar Spotify"');
    expect(playing).toContain("i.scdn.co/image/test");
  });

  it("provides an independent empty Presence renderer slot without generic media", () => {
    const markup = renderPresence();

    expect(markup).toContain('data-renderer-slot="presence"');
    expect(markup).toContain('data-renderer-mode="external"');
    expect(markup).toContain("PRESENCE SÍNTESIS");
    expect(markup).toContain("Sin visualización");
    expect(markup).toContain("Mini Presence");
    expect(markup).not.toContain("<canvas");
    expect(markup).not.toContain("<iframe");
  });
});
