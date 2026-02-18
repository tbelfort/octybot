import {
  pendingMicAccess, setPendingMicAccess,
  mediaRecorder, setMediaRecorder,
  audioChunks, setAudioChunks,
  recordingTimeout, setRecordingTimeout,
  handsfreeStream, globalMicStream, setGlobalMicStream,
  handsfreeActive,
  MAX_RECORDING_MS,
} from "./state";
import { voiceBtn, msgInput } from "./dom";
import { rawFetch } from "./api";
import { showToast } from "./ui-helpers";

// Forward declarations — set at init time
let _autoResize: () => void = () => {};
let _sendMessage: () => void = () => {};
let _setHandsfreeState: (state: string) => void = () => {};

export function registerVoiceDeps(deps: {
  autoResize: () => void;
  sendMessage: () => void;
  setHandsfreeState: (state: string) => void;
}) {
  _autoResize = deps.autoResize;
  _sendMessage = deps.sendMessage;
  _setHandsfreeState = deps.setHandsfreeState;
}

export function initVoiceInput() {
  if (!window.MediaRecorder) {
    voiceBtn.style.display = "none";
  }
}

export function startRecording() {
  if (pendingMicAccess) return;
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  // Reuse global mic stream if available (no permission prompt).
  const stream = handsfreeStream || globalMicStream;
  const canReuse = stream && stream.getAudioTracks().some((t) => t.readyState === "live");
  if (canReuse) {
    beginRecording(stream!, false);
  } else {
    setPendingMicAccess(true);
    navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
      setPendingMicAccess(false);
      setGlobalMicStream(s);
      beginRecording(s, false);
    }).catch(() => {
      setPendingMicAccess(false);
      showToast("Microphone access denied");
    });
  }
}

function beginRecording(stream: MediaStream, stopTracksOnEnd: boolean) {
  setAudioChunks([]);
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
  const mr = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
  setMediaRecorder(mr);

  mr.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mr.onstop = () => {
    clearTimeout(recordingTimeout!);
    if (stopTracksOnEnd) stream.getTracks().forEach((t) => t.stop());
    voiceBtn.classList.remove("recording");
    if (audioChunks.length) {
      const blob = new Blob(audioChunks, { type: mr.mimeType });
      transcribeAndSend(blob, mr.mimeType);
    } else if (handsfreeActive) {
      _setHandsfreeState("green");
    }
  };

  mr.start();
  voiceBtn.classList.add("recording");

  // Auto-stop after 60s
  setRecordingTimeout(setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, MAX_RECORDING_MS));
}

export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
}

async function transcribeAndSend(audioBlob: Blob, mimeType: string) {
  voiceBtn.classList.add("transcribing");
  const savedPlaceholder = msgInput.placeholder;
  msgInput.placeholder = "Transcribing...";

  try {
    const resp = await rawFetch("/transcribe", {
      method: "POST",
      headers: { "Content-Type": mimeType || "audio/webm" },
      body: audioBlob,
    });

    if (!resp) return; // kicked to setup

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Transcription failed (${resp.status})`);
    }

    const data = await resp.json();
    if (data.text && data.text.trim()) {
      msgInput.value = data.text.trim();
      _autoResize();
      _sendMessage();
    } else if (handsfreeActive) {
      _setHandsfreeState("green");
    }
  } catch (e: any) {
    showToast(e.message || "Transcription failed");
    if (handsfreeActive) _setHandsfreeState("green");
  } finally {
    voiceBtn.classList.remove("transcribing");
    msgInput.placeholder = savedPlaceholder;
  }
}
