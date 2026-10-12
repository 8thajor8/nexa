import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { destroyRendererPttVoiceControllerOwner, getRendererPttVoiceControllerOwner } from "./voice/ptt-voice-controller-owner";
import { MicrophoneDeviceStore } from "./audio/microphone-device-store";
import { PttMicrophoneCapture } from "./audio/ptt-microphone-capture";
import { initializeRendererStartupServices } from "./startup-services";
import "./styles.css";

const isIsolated = window.nexaDesktop.isIsolated;
const microphoneDevices = new MicrophoneDeviceStore({ enabled: !isIsolated });
const rendererStartup = initializeRendererStartupServices({
  isIsolated,
  microphoneDevices,
  spotify: window.nexaDesktop.spotify,
  documentTarget: document,
  windowTarget: window,
  createVoiceController: () => getRendererPttVoiceControllerOwner(window.nexaDesktop.voice, {
    createCapture: (voice) => new PttMicrophoneCapture(voice, {
      getDeviceId: () => microphoneDevices.getCaptureDeviceId(),
      onSelectedDeviceUnavailable: () => microphoneDevices.useDefaultAfterUnavailable(),
    }),
  }).controller,
  destroyVoiceController: destroyRendererPttVoiceControllerOwner,
});

const container = document.getElementById("root");
if (!container) throw new Error("renderer_root_missing");
createRoot(container).render(<React.StrictMode><App voiceController={rendererStartup.voiceController} microphoneDevices={microphoneDevices} /></React.StrictMode>);
