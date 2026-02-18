import {
  TOKEN, setToken, setTtsEnabled, setOpenaiKeyOk, setPendingMicAccess,
  setVoiceChatMode, setHandsfreeActive, setHandsfreeAudioCtx,
  setHandsfreeStream, setHandsfreeSourceNode, setHandsfreeSilentNode,
  globalMicStream, setGlobalMicStream, handsfreeAudioCtx,
  handsfreeSilentNode, handsfreeSourceNode, handsfreeStream,
  activeEventSource, setActiveEventSource,
  activeProject, setActiveProject, activeAgent, setActiveAgent,
  setCachedSettings, micPreRequesting, setMicPreRequesting,
  WORKER_URL,
} from "./state";
import {
  setupEl, appEl, setupCode, setupSave, setupError,
  ttsBtn, handsfreeOverlay,
} from "./dom";
import { api, registerKickToSetup } from "./api";
import { cancelRecording } from "./ui-helpers";

// Forward declarations — set at init time
let _stopAudio: () => void = () => {};
let _resetStreamingState: () => void = () => {};
let _loadConversations: () => void = () => {};
let _loadSidebarProjects: () => void = () => {};
let _updateNewChatTarget: () => void = () => {};

export function registerAuthDeps(deps: {
  stopAudio: () => void;
  resetStreamingState: () => void;
  loadConversations: () => void;
  loadSidebarProjects: () => void;
  updateNewChatTarget: () => void;
}) {
  _stopAudio = deps.stopAudio;
  _resetStreamingState = deps.resetStreamingState;
  _loadConversations = deps.loadConversations;
  _loadSidebarProjects = deps.loadSidebarProjects;
  _updateNewChatTarget = deps.updateNewChatTarget;
}

export function kickToSetup() {
  setToken("");
  localStorage.removeItem("token");

  // Clean up all active operations
  _stopAudio();
  if (activeEventSource) {
    activeEventSource.close();
    setActiveEventSource(null);
  }
  _resetStreamingState();
  setVoiceChatMode(false);
  setTtsEnabled(false);
  setHandsfreeActive(false);
  handsfreeOverlay.classList.add("hidden");
  ttsBtn.classList.remove("active");
  cancelRecording();
  setOpenaiKeyOk(null);
  setPendingMicAccess(false);
  if (handsfreeSilentNode) {
    try { handsfreeSilentNode.stop(); } catch {}
    setHandsfreeSilentNode(null);
  }
  if (handsfreeAudioCtx) {
    handsfreeAudioCtx.close().catch(() => {});
    setHandsfreeAudioCtx(null);
  }
  setHandsfreeSourceNode(null);
  // Kill the global mic stream
  if (globalMicStream) {
    globalMicStream.getTracks().forEach((t) => t.stop());
    setGlobalMicStream(null);
  }
  setHandsfreeStream(null);

  setupEl.classList.remove("hidden");
  appEl.classList.remove("active");
}

// Register kickToSetup with the api module
registerKickToSetup(kickToSetup);

export async function checkSetup() {
  if (TOKEN) {
    setupEl.classList.add("hidden");
    appEl.classList.add("active");
    // Fetch active project/agent before loading conversations
    try {
      const data = await api("/settings");
      if (data && data.settings) {
        setCachedSettings(data.settings);
        if (data.settings.active_project) setActiveProject(data.settings.active_project);
        if (data.settings.active_agent) setActiveAgent(data.settings.active_agent);
      }
    } catch {}
    _loadSidebarProjects();
    _loadConversations();
    _updateNewChatTarget();
    preRequestMic();
  }
}

// Request mic on first user gesture after login
function preRequestMic() {
  if (globalMicStream || !navigator.mediaDevices) return;
  function grabMic() {
    if (globalMicStream || micPreRequesting) return;
    setMicPreRequesting(true);
    document.removeEventListener("click", grabMic, true);
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      setGlobalMicStream(stream);
    }).catch(() => {}).finally(() => {
      setMicPreRequesting(false);
    });
  }
  document.addEventListener("click", grabMic, true);
}

export function initSetupListeners() {
  setupSave.addEventListener("click", async () => {
    const code = setupCode.value.trim().toUpperCase();
    if (!code) return;

    setupSave.disabled = true;
    setupSave.textContent = "Pairing...";
    setupError.style.display = "none";

    try {
      const resp = await fetch(`${WORKER_URL}/devices/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setupError.textContent = data.error || "Pairing failed";
        setupError.style.display = "block";
        return;
      }

      setToken(data.token);
      localStorage.setItem("device_id", data.device_id);
      checkSetup();
    } catch (e: any) {
      setupError.textContent = `Connection failed: ${e.message}`;
      setupError.style.display = "block";
    } finally {
      setupSave.disabled = false;
      setupSave.textContent = "Pair";
    }
  });
}
