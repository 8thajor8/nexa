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

describe("Command Center visual structure", () => {
  it("provides wallpaper enable and manual refresh controls without replacing panels", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('aria-label="Fondo de Windows activado"');
    expect(markup).toContain('aria-label="Actualizar el wallpaper de Windows"');
    expect(markup).toContain('aria-labelledby="conversation-title"');
    expect(markup).toContain('data-renderer-slot="presence"');
  });

  it("removes the redundant title while keeping the compact top controls", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).not.toContain("<h1");
    expect(markup).toContain('aria-label="Controles del Command Center"');
    expect(markup).toContain("Estado simulado");
    expect(markup).toContain('aria-label="Comprobar el puente IPC local"');
    expect(markup).toContain('aria-label="Fondo de Windows activado"');
    expect(markup).toContain('aria-label="Actualizar el wallpaper de Windows"');
  });

  it("renders the three lower dashboard modules with clearly labeled mock and future data", () => {
    const markup = renderToStaticMarkup(createElement(DashboardModules, { assistantState: "En espera" }));

    expect(markup).toContain("Actividad reciente");
    expect(markup).toContain("DEMO · MOCK");
    expect(markup).toContain("Herramientas disponibles");
    expect(markup).toContain("Capacidades futuras, aún no conectadas");
    expect(markup).toContain("Estado del sistema");
    expect(markup).toContain("Sin métricas de rendimiento ni monitorización real.");
    expect(markup).toContain("Sin conexión");
  });

  it("cleans panel and navigation labels while preserving their useful titles and the composer", () => {
    const conversation = renderToStaticMarkup(createElement(ConversationPanel));
    const presence = renderToStaticMarkup(createElement(PresencePanel));
    const sidebar = renderToStaticMarkup(createElement(Sidebar));

    expect(conversation).toContain("Conversación");
    expect(conversation).not.toContain("ESPACIO DE TRABAJO");
    expect(conversation).not.toContain("INTERFAZ INACTIVA");
    expect(conversation).toContain("Entrada no habilitada");
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
    const markup = renderToStaticMarkup(createElement(App));

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

  it("uses one horizontal gap token and hides only the conversation history scrollbar", () => {
    const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
    const conversation = renderToStaticMarkup(createElement(ConversationPanel));

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
    expect((markup.match(/disabled=""/g) ?? []).length).toBe(6);
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

  it("labels sample messages and keeps the composer inactive", () => {
    const markup = renderToStaticMarkup(createElement(ConversationPanel));

    expect(markup).toContain("DEMO · MOCK");
    expect(markup).toContain("Mensajes de ejemplo");
    expect(markup).toContain("no se han enviado a un modelo ni se han guardado");
    expect(markup).toContain('id="message-composer"');
    expect(markup).toContain('placeholder="La entrada de mensajes no está activa"');
    expect(markup).toContain('aria-label="Enviar mensaje, no disponible en esta versión"');
  });

  it("provides an independent empty Presence renderer slot without generic media", () => {
    const markup = renderToStaticMarkup(createElement(PresencePanel));

    expect(markup).toContain('data-renderer-slot="presence"');
    expect(markup).toContain('data-renderer-mode="external"');
    expect(markup).toContain("PRESENCE SÍNTESIS");
    expect(markup).toContain("Sin visualización");
    expect(markup).toContain("Mini Presence");
    expect(markup).not.toContain("<canvas");
    expect(markup).not.toContain("<iframe");
  });
});
