// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationPanel } from "../src/renderer/components/ConversationPanel";
import type { PttVoiceSnapshot } from "../src/renderer/voice/ptt-voice-controller";

afterEach(cleanup);

const snapshot: PttVoiceSnapshot = { status: "idle", canStart: true };

describe("conversation voice replies switch", () => {
  it("uses the shared preference callback and reflects its current value accessibly", () => {
    const onVoiceRepliesChange = vi.fn();
    const view = render(<ConversationPanel snapshot={snapshot} transcripts={[]} transcriptNotice={null}
      onStart={vi.fn()} onFinish={vi.fn()} onRecover={vi.fn()} showVoiceRepliesToggle
      voiceRepliesEnabled={false} onVoiceRepliesChange={onVoiceRepliesChange} />);

    const toggle = screen.getByRole("switch", { name: "Respuestas por voz" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("DESACTIVADO")).toBeTruthy();
    fireEvent.click(toggle);
    expect(onVoiceRepliesChange).toHaveBeenCalledOnce();
    expect(onVoiceRepliesChange).toHaveBeenCalledWith(true);

    view.rerender(<ConversationPanel snapshot={snapshot} transcripts={[]} transcriptNotice={null}
      onStart={vi.fn()} onFinish={vi.fn()} onRecover={vi.fn()} showVoiceRepliesToggle
      voiceRepliesEnabled onVoiceRepliesChange={onVoiceRepliesChange} />);
    expect(screen.getByRole("switch", { name: "Respuestas por voz" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("ACTIVADO")).toBeTruthy();
  });
});
