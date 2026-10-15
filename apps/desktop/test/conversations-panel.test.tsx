// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationsPanel } from "../src/renderer/components/ConversationsPanel";
import type { ChatConversationSummary } from "../src/shared/ipc-contract";

const conversations: ChatConversationSummary[] = [
  { conversationId: "00000000-0000-4000-8000-000000000001", title: "Primera", createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-15T09:30:00.000Z", messageCount: 4 },
  { conversationId: "00000000-0000-4000-8000-000000000002", title: "Nueva conversación", createdAt: "2026-10-15T09:00:00.000Z",
    updatedAt: "2026-10-15T09:00:00.000Z", messageCount: 0 },
];

afterEach(cleanup);

describe("Conversations panel", () => {
  it("shows persisted conversations and marks the active one", () => {
    render(<ConversationsPanel conversations={conversations} activeConversationId={conversations[0].conversationId}
      busy={false} loading={false} hasMore={false} error={null} onNew={vi.fn()} onSelect={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByText("Primera").closest("button")?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("4 mensajes")).toBeTruthy();
    expect(screen.getByText("Primera").classList.contains("conversation-history-title")).toBe(true);
    expect(screen.getByText("4 mensajes").classList.contains("conversation-history-count")).toBe(true);
    expect(document.querySelector(".conversation-history-time")?.textContent).toMatch(/\d/);
    expect(screen.getByRole("button", { name: "Nueva conversación" })).toBeTruthy();
  });

  it("routes new/select/page actions and blocks them while the chat is busy", () => {
    const onNew = vi.fn(); const onSelect = vi.fn(); const onLoadMore = vi.fn();
    const view = render(<ConversationsPanel conversations={conversations} activeConversationId={null} busy={false}
      loading={false} hasMore={true} error={null} onNew={onNew} onSelect={onSelect} onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
    fireEvent.click(screen.getByRole("button", { name: /Primera/ }));
    fireEvent.click(screen.getByRole("button", { name: /Ver conversaciones anteriores/ }));
    expect(onNew).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(conversations[0].conversationId);
    expect(onLoadMore).toHaveBeenCalledOnce();

    view.rerender(<ConversationsPanel conversations={conversations} activeConversationId={null} busy={true} loading={false}
      hasMore={true} error={null} onNew={onNew} onSelect={onSelect} onLoadMore={onLoadMore} />);
    expect((screen.getByRole("button", { name: "Nueva conversación" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Primera/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows loading, empty, and error states", () => {
    const view = render(<ConversationsPanel conversations={[]} activeConversationId={null} busy={false} loading
      hasMore={false} error={null} onNew={vi.fn()} onSelect={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Cargando");
    view.rerender(<ConversationsPanel conversations={[]} activeConversationId={null} busy={false} loading={false}
      hasMore={false} error={null} onNew={vi.fn()} onSelect={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByText("Todavía no hay conversaciones guardadas.")).toBeTruthy();
    view.rerender(<ConversationsPanel conversations={[]} activeConversationId={null} busy={false} loading={false}
      hasMore={false} error="No se pudo cargar" onNew={vi.fn()} onSelect={vi.fn()} onLoadMore={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("No se pudo cargar");
  });
});
