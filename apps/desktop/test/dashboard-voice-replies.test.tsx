// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardModules } from "../src/renderer/components/DashboardModules";

afterEach(cleanup);

describe("voice replies tool tile", () => {
  it("replaces only the Memory placeholder with a keyboard-accessible voice switch", () => {
    const onVoiceRepliesChange = vi.fn();
    const { container, rerender } = render(createElement(DashboardModules, {
      assistantState: "Listo", voiceRepliesEnabled: false, onVoiceRepliesChange,
    }));

    const toggle = screen.getByRole("switch", { name: "Respuestas por voz" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((toggle as HTMLButtonElement).tabIndex).toBe(0);
    expect(screen.getByText("DESACTIVADO")).toBeTruthy();
    expect(container.querySelectorAll(".tool-item")).toHaveLength(6);
    expect(container.querySelector(".tool-voice-replies")).toBeNull();
    expect(screen.queryByText("Memory")).toBeNull();
    for (const label of ["Aplicaciones", "Spotify", "Web Search", "Archivos", "Email"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    fireEvent.click(toggle);
    expect(onVoiceRepliesChange).toHaveBeenCalledWith(true);
    rerender(createElement(DashboardModules, { assistantState: "Listo", voiceRepliesEnabled: true, onVoiceRepliesChange }));
    expect(screen.getByRole("switch", { name: "Respuestas por voz" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("ACTIVADO")).toBeTruthy();
  });
});
