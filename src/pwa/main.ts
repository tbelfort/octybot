// ---- PWA Entry Point ----
// Imports all modules and wires up cross-module dependencies.

import { initViewportLock } from "./viewport";
import { initVoiceInput, registerVoiceDeps } from "./voice";
import { checkSetup, initSetupListeners, registerAuthDeps } from "./auth-setup";
import { registerStopAudio, registerResetStreamingState } from "./ui-helpers";
import { stopAudio, checkOpenAIKey, registerTtsDeps } from "./tts";
import { enterHandsfree, setHandsfreeState, initHandsfreeListeners } from "./handsfree";
import { renderMessages, sendMessage, resetStreamingState, autoResize, initInputListeners, registerMessagingDeps } from "./messaging";
import { loadConversations, createConversation, registerConversationDeps, initConversationListeners } from "./conversations";
import { loadSidebarProjects, updateNewChatTarget, loadProjects, initProjectListeners } from "./projects";
import { initSettingsListeners, registerSettingsDeps } from "./settings";
import { initUsageListeners } from "./usage";
import {
  sidebar, sidebarOverlay, menuBtn, newChatBtn, convTitle,
  voiceBtn, ttsBtn,
} from "./dom";
import { currentConvId } from "./state";
import { inlineRename } from "./ui-helpers";
import { renameConversation } from "./conversations";

// ---- Wire cross-module dependencies ----

// ui-helpers needs stopAudio and resetStreamingState
registerStopAudio(stopAudio);
registerResetStreamingState(resetStreamingState);

// auth-setup needs several functions
registerAuthDeps({
  stopAudio,
  resetStreamingState,
  loadConversations,
  loadSidebarProjects,
  updateNewChatTarget,
});

// voice needs autoResize, sendMessage, setHandsfreeState
registerVoiceDeps({
  autoResize,
  sendMessage,
  setHandsfreeState,
});

// tts needs setHandsfreeState
registerTtsDeps({
  setHandsfreeState,
});

// messaging needs setHandsfreeState
registerMessagingDeps({
  setHandsfreeState,
});

// conversations needs renderMessages and closeSidebar
registerConversationDeps({
  renderMessages,
  closeSidebar,
});

// settings needs several functions
registerSettingsDeps({
  loadSidebarProjects,
  loadConversations,
  updateNewChatTarget,
  loadProjects,
});

// ---- Sidebar ----
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarOverlay.classList.remove("show");
}

menuBtn.addEventListener("click", () => {
  sidebar.classList.add("open");
  sidebarOverlay.classList.add("show");
});

sidebarOverlay.addEventListener("click", closeSidebar);
newChatBtn.addEventListener("click", createConversation);

// ---- Header Title Rename ----
convTitle.addEventListener("click", () => {
  if (!currentConvId || convTitle.textContent === "New Chat") return;
  inlineRename(convTitle.parentNode as HTMLElement, convTitle, convTitle.textContent!, (newTitle) => {
    renameConversation(currentConvId!, newTitle);
  }, "title-input");
});

// ---- Voice/TTS button handlers ----
voiceBtn.addEventListener("click", async () => {
  if (!window.MediaRecorder) return;
  if (!(await checkOpenAIKey())) return;
  enterHandsfree();
});

ttsBtn.addEventListener("click", async () => {
  if (!(await checkOpenAIKey())) return;
  enterHandsfree();
});

// ---- Init all listeners ----
initSetupListeners();
initSettingsListeners();
initProjectListeners();
initConversationListeners();
initInputListeners();
initHandsfreeListeners();
initUsageListeners();

// ---- Init ----
initViewportLock();
initVoiceInput();
checkSetup();

// Stop all audio on page unload/refresh
window.addEventListener("pagehide", () => {
  stopAudio();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}
// v29 — modularized TypeScript build
