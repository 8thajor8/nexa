// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "../src/renderer/components/ConversationPanel";

afterEach(cleanup);

function renderResponse(text: string, presentation?: { kind: "diagnostic" | "tool_catalog"; technicalDetail: string },
  copyTechnicalDetail = vi.fn(async () => true)) {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  Object.defineProperty(window, "nexaDesktop", { configurable: true, value: { copyTechnicalDetail } });
  return render(createElement(ConversationPanel, {
    snapshot: { status: "idle", canStart: true }, transcripts: [], transcriptNotice: null,
    onStart: vi.fn(), onFinish: vi.fn(), onCancel: vi.fn(), onRecover: vi.fn(),
    chatMessages: [{ id: "response-1", requestId: "request-1", conversationId: "conversation-1", role: "assistant",
      text, source: "typed", status: "completed", createdAt: 1, ...(presentation ? { presentation } : {}) }],
  }));
}

describe("assistant response formatting", () => {
  it("renders basic Markdown while keeping legacy plain text readable", () => {
    const { container, rerender } = renderResponse("**Estado**\n\nTexto claro.\n- Uno\n- Dos\n`código`");
    expect(container.querySelector(".assistant-response-visual strong")?.textContent).toBe("Estado");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("code")?.textContent).toBe("código");
    rerender(createElement(ConversationPanel, {
      snapshot: { status: "idle", canStart: true }, transcripts: [], transcriptNotice: null,
      onStart: vi.fn(), onFinish: vi.fn(), onCancel: vi.fn(), onRecover: vi.fn(),
      chatMessages: [{ id: "old", requestId: "old", conversationId: "conversation-1", role: "assistant",
        text: "Respuesta antigua sin Markdown", source: "typed", status: "completed", createdAt: 2 }],
    }));
    expect(screen.getAllByText("Respuesta antigua sin Markdown").length).toBeGreaterThan(0);
  });

  it("keeps headings, paragraphs, lists, code, and technical action inside one assistant bubble", () => {
    const { container } = renderResponse("## Estado\n\nTexto introductorio.\n\n- Uno\n- Dos\n\n```js\nconst ok = true;\n```",
      { kind: "diagnostic", technicalDetail: "detalle sintético" });
    const bubbles = container.querySelectorAll(".assistant-message-bubble");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].querySelector("h2")?.textContent).toBe("Estado");
    expect(bubbles[0].querySelectorAll("p")).toHaveLength(1);
    expect(bubbles[0].querySelectorAll("li")).toHaveLength(2);
    expect(bubbles[0].querySelector("pre code")?.textContent).toBe("const ok = true;");
    expect(bubbles[0].querySelector(".technical-detail-action button")).not.toBeNull();
  });

  it("renders raw HTML as text and blocks dangerous link protocols", () => {
    const { container } = renderResponse('<script>alert("x")</script> [enlace](javascript:alert(1))');
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText(/<script>alert/u).length).toBeGreaterThan(0);
    expect(container.querySelector("a")).toBeNull();
  });

  it("copies only the technical detail attached to that diagnostic response", async () => {
    const copyTechnicalDetail = vi.fn(async () => true);
    renderResponse("**Diagnóstico**\n\nTodo claro.", { kind: "diagnostic", technicalDetail: '{"schema":"nexa-system-diagnostic/v1"}' }, copyTechnicalDetail);
    fireEvent.click(screen.getByRole("button", { name: "Copiar detalle técnico" }));
    await waitFor(() => expect(copyTechnicalDetail).toHaveBeenCalledWith('{"schema":"nexa-system-diagnostic/v1"}'));
    expect(screen.getByRole("status").textContent).toBe("Detalle copiado");
  });

  it("copies the technical detail belonging to the button's own response", async () => {
    const copyTechnicalDetail = vi.fn(async () => true);
    Object.defineProperty(window, "nexaDesktop", { configurable: true, value: { copyTechnicalDetail } });
    const presentation = (technicalDetail: string) => ({ kind: "diagnostic" as const, technicalDetail });
    render(createElement(ConversationPanel, {
      snapshot: { status: "idle", canStart: true }, transcripts: [], transcriptNotice: null,
      onStart: vi.fn(), onFinish: vi.fn(), onCancel: vi.fn(), onRecover: vi.fn(),
      chatMessages: ["first", "second"].map((id, index) => ({ id, requestId: id, conversationId: "conversation-1", role: "assistant" as const,
        text: `Informe ${id}`, source: "typed" as const, status: "completed" as const, createdAt: index + 1,
        presentation: presentation(`detail-${id}`) })),
    }));
    fireEvent.click(screen.getAllByRole("button", { name: "Copiar detalle técnico" })[1]);
    await waitFor(() => expect(copyTechnicalDetail).toHaveBeenCalledWith("detail-second"));
    expect(copyTechnicalDetail).toHaveBeenCalledTimes(1);
  });

  it("reports clipboard failures without replacing the assistant response", async () => {
    const copyTechnicalDetail = vi.fn(async () => { throw new Error("blocked"); });
    renderResponse("Respuesta disponible.", { kind: "tool_catalog", technicalDetail: '{"schema":"nexa-tool-catalog/v1"}' }, copyTechnicalDetail);
    fireEvent.click(screen.getByRole("button", { name: "Copiar detalle técnico" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No se pudo copiar el detalle"));
    expect(screen.getAllByText("Respuesta disponible.").length).toBeGreaterThan(0);
  });

  it("does not show copy action on ordinary messages", () => {
    renderResponse("Respuesta sencilla.");
    expect(screen.queryByRole("button", { name: "Copiar detalle técnico" })).toBeNull();
  });
});
