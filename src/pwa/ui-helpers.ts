import {
  mediaRecorder, recordingTimeout, setMediaRecorder, setAudioChunks,
  activeEventSource, setActiveEventSource, isStreaming,
} from "./state";
import { voiceBtn } from "./dom";

// Forward declarations — set by modules that own these functions
let _stopAudio: () => void = () => {};
let _resetStreamingState: () => void = () => {};

export function registerStopAudio(fn: () => void) { _stopAudio = fn; }
export function registerResetStreamingState(fn: () => void) { _resetStreamingState = fn; }

export function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function scrollToBottom() {
  const msgContainer = document.querySelector("#messages") as HTMLDivElement;
  requestAnimationFrame(() => {
    msgContainer.scrollTop = msgContainer.scrollHeight;
  });
}

export function showToast(message: string, duration = 3000) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

export function setPlayBtnState(btn: HTMLButtonElement | null, state: string) {
  if (!btn) return;
  btn.classList.remove("playing", "loading", "paused");
  if (state === "play") btn.textContent = "\u25B6";
  else if (state === "stop") { btn.textContent = "\u25A0"; btn.classList.add("playing"); }
  else if (state === "loading") { btn.textContent = "\u00B7\u00B7\u00B7"; btn.classList.add("loading"); }
  else if (state === "paused") { btn.textContent = "\u25B6"; btn.classList.add("paused"); }
}

export function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    clearTimeout(recordingTimeout!);
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    setMediaRecorder(null);
    setAudioChunks([]);
    voiceBtn.classList.remove("recording");
  }
}

export function cancelActiveWork() {
  _stopAudio();
  if (activeEventSource) {
    activeEventSource.close();
    setActiveEventSource(null);
  }
  if (isStreaming) _resetStreamingState();
}

export function inlineRename(
  containerEl: HTMLElement,
  hideEl: HTMLElement,
  currentTitle: string,
  onSave: (newTitle: string) => void,
  inputClass = "rename-input"
) {
  if (containerEl.querySelector(".rename-input") || containerEl.querySelector(".title-input")) return;

  const input = document.createElement("input");
  input.className = inputClass;
  input.type = "text";
  input.value = currentTitle;

  hideEl.style.display = "none";
  const hideActions = containerEl.querySelector(".conv-actions") as HTMLElement | null;
  if (hideActions) hideActions.style.display = "none";
  containerEl.insertBefore(input, hideEl.nextSibling || hideEl);
  input.focus();
  input.select();

  let done = false;
  function finish(save: boolean) {
    if (done) return;
    done = true;
    const newTitle = input.value.trim();
    input.remove();
    hideEl.style.display = "";
    if (hideActions) hideActions.style.display = "";
    if (save && newTitle && newTitle !== currentTitle) {
      onSave(newTitle);
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}
