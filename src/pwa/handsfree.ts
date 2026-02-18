import {
  handsfreeActive, setHandsfreeActive,
  setVoiceChatMode, setTtsEnabled,
  handsfreeAudioCtx, setHandsfreeAudioCtx,
  handsfreeStream, setHandsfreeStream,
  handsfreeSourceNode, setHandsfreeSourceNode,
  handsfreeSilentNode, setHandsfreeSilentNode,
  globalMicStream, setGlobalMicStream,
  currentPlayBtn, handsfreeState, setHandsfreeStateVal,
} from "./state";
import {
  ttsBtn, handsfreeOverlay, handsfreeOrb, handsfreeLabel, handsfreeExit,
} from "./dom";
import { showToast } from "./ui-helpers";
import { startRecording, stopRecording } from "./voice";
import { stopAudio } from "./tts";

export async function enterHandsfree() {
  if (handsfreeActive) return;
  // Use the global mic stream if available, otherwise request now.
  if (globalMicStream && globalMicStream.getAudioTracks().some((t) => t.readyState === "live")) {
    setHandsfreeStream(globalMicStream);
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setHandsfreeStream(stream);
      setGlobalMicStream(stream);
    } catch {
      showToast("Microphone access denied");
      return;
    }
  }

  setHandsfreeActive(true);
  setVoiceChatMode(true);
  setTtsEnabled(true);
  ttsBtn.classList.add("active");
  handsfreeOverlay.classList.remove("hidden");

  // Create and unlock AudioContext during user gesture.
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (AC) {
    const ctx = new AC() as AudioContext;
    setHandsfreeAudioCtx(ctx);
    // Keep a silent oscillator running to hold the audio session open.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0; // silent
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setHandsfreeSilentNode(osc);
  }

  // If TTS is currently playing (continued from before), show purple.
  if (currentPlayBtn && currentPlayBtn.classList.contains("playing")) {
    setHandsfreeState("purple");
  } else {
    setHandsfreeState("green");
  }
}

export function exitHandsfree() {
  setHandsfreeActive(false);
  setVoiceChatMode(false);
  setTtsEnabled(false);
  ttsBtn.classList.remove("active");
  handsfreeOverlay.classList.add("hidden");
  stopRecording();

  // Stop WebAudio source but DON'T abort TTS
  if (handsfreeSourceNode) {
    try { handsfreeSourceNode.stop(); } catch {}
    setHandsfreeSourceNode(null);
  }
  if (handsfreeSilentNode) {
    try { handsfreeSilentNode.stop(); } catch {}
    setHandsfreeSilentNode(null);
  }
  if (handsfreeAudioCtx) {
    handsfreeAudioCtx.close().catch(() => {});
    setHandsfreeAudioCtx(null);
  }
  // Keep the mic stream alive globally (don't stop tracks)
  setHandsfreeStream(null);
}

export function setHandsfreeState(state: string) {
  setHandsfreeStateVal(state);

  handsfreeOrb.className = "handsfree-orb " + state;
  if (state === "green") {
    handsfreeLabel.textContent = "Tap to speak";
  } else if (state === "blue") {
    handsfreeLabel.textContent = "Listening... tap to send";
  } else if (state === "amber") {
    handsfreeLabel.textContent = "Thinking...";
  } else if (state === "purple") {
    handsfreeLabel.textContent = "Talking...";
  }
}

export function initHandsfreeListeners() {
  // Tap anywhere on the overlay (except exit button) to toggle state
  handsfreeOverlay.addEventListener("click", (e) => {
    if (e.target === handsfreeExit || handsfreeExit.contains(e.target as Node)) return;
    if (handsfreeState === "green") {
      setHandsfreeState("blue");
      startRecording();
    } else if (handsfreeState === "blue") {
      setHandsfreeState("amber");
      stopRecording();
    } else if (handsfreeState === "purple") {
      // Interrupt TTS and start recording
      stopAudio();
      setHandsfreeState("blue");
      startRecording();
    }
    // amber = waiting, do nothing on tap
  });

  handsfreeExit.addEventListener("click", (e) => {
    e.stopPropagation();
    exitHandsfree();
  });
}
