import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { destroyRendererPttVoiceControllerOwner, getRendererPttVoiceControllerOwner } from "./voice/ptt-voice-controller-owner";
import "./styles.css";

getRendererPttVoiceControllerOwner(window.nexaDesktop.voice);
window.addEventListener("pagehide", () => {
  void destroyRendererPttVoiceControllerOwner().catch(() => undefined);
}, { once: true });

const container = document.getElementById("root");
if (!container) throw new Error("renderer_root_missing");
createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);