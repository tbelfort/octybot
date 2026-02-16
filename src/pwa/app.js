// ---- Config ----
const WORKER_URL = "https://octybot-worker.tom-adf.workers.dev";
let TOKEN = localStorage.getItem("token") || "";

// ---- State ----
let currentConvId = null;
let isStreaming = false;
let ttsEnabled = false;
let mediaRecorder = null;
let audioChunks = [];
let recordingTimeout = null;
let pendingMicAccess = false;
const MAX_RECORDING_MS = 60000;
let currentAudio = null;
let currentPlayBtn = null;
let openaiKeyOk = null; // null = unchecked, true/false = cached result
let activeEventSource = null; // SSE stream for cancellation
let ttsAbort = null; // AbortController for chunked TTS
let ttsQueue = []; // audio blob queue for chunked playback
const ttsCache = new Map(); // text → Blob[] cache to avoid re-fetching
const TTS_CACHE_MAX = 20;
let convProcessStatus = {}; // convId → status string or null
let globalMicStream = null; // persistent mic stream, survives handsfree exit

// ---- DOM ----
const $ = (sel) => document.querySelector(sel);
const setupEl = $("#setup");
const appEl = $("#app");
const msgContainer = $("#messages");
const msgInput = $("#msg-input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
const voiceBtn = $("#voice-btn");
const ttsBtn = $("#tts-btn");
const menuBtn = $("#menu-btn");
const sidebar = $("#sidebar");
const sidebarOverlay = $("#sidebar-overlay");
const convList = $("#conv-list");
const convTitle = $("#conv-title");
const newChatBtn = $("#new-chat-btn");
const settingsBtn = $("#settings-btn");
const setupCode = $("#setup-code");
const setupSave = $("#setup-save");
const setupError = $("#setup-error");
const sessionBadge = $("#session-badge");
const sessionStopBtn = $("#session-stop-btn");
const settingsTimeout = $("#settings-timeout");
const settingsPoolMax = $("#settings-pool-max");
const settingsSaveBtn = $("#settings-save-btn");

// ---- Viewport Lock (iOS Safari) ----
let viewportSyncQueued = false;

function syncViewportVars() {
  const viewport = window.visualViewport;
  const rawWidth = viewport ? viewport.width : window.innerWidth;
  const rawHeight = viewport ? viewport.height : window.innerHeight;
  const rawOffsetX = viewport ? viewport.offsetLeft : 0;
  const rawOffsetY = viewport ? viewport.offsetTop : 0;
  if (!rawWidth || !rawHeight) return;

  // Floor values to avoid fractional-pixel overflow causing right-edge drift.
  document.documentElement.style.setProperty("--app-width", `${Math.floor(rawWidth)}px`);
  document.documentElement.style.setProperty("--app-height", `${Math.floor(rawHeight)}px`);
  document.documentElement.style.setProperty("--app-offset-x", `${Math.max(0, Math.floor(rawOffsetX))}px`);
  document.documentElement.style.setProperty("--app-offset-y", `${Math.max(0, Math.floor(rawOffsetY))}px`);
}

function queueViewportSync() {
  if (viewportSyncQueued) return;
  viewportSyncQueued = true;
  requestAnimationFrame(() => {
    viewportSyncQueued = false;
    syncViewportVars();
  });
}

function initViewportLock() {
  const handleViewportGeometryChange = () => queueViewportSync();

  syncViewportVars();
  window.addEventListener("resize", handleViewportGeometryChange, { passive: true });
  window.addEventListener("orientationchange", handleViewportGeometryChange, { passive: true });
  document.addEventListener("focusin", handleViewportGeometryChange, { passive: true });
  document.addEventListener("focusout", handleViewportGeometryChange, { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleViewportGeometryChange, { passive: true });
    window.visualViewport.addEventListener("scroll", handleViewportGeometryChange, { passive: true });
  }

  // Safari can apply keyboard-related viewport shifts a tick later.
  setTimeout(handleViewportGeometryChange, 0);
  setTimeout(handleViewportGeometryChange, 120);
}

function stabilizeKeyboardViewport() {
  const settle = () => queueViewportSync();

  setTimeout(settle, 0);
  setTimeout(settle, 120);
  setTimeout(settle, 260);
  setTimeout(settle, 500);
}

// ---- Auth Helpers ----
function handleAuthHeaders(resp) {
  const refreshToken = resp.headers.get("X-Refresh-Token");
  if (refreshToken) {
    TOKEN = refreshToken;
    localStorage.setItem("token", refreshToken);
  }
}

function kickToSetup() {
  TOKEN = "";
  localStorage.removeItem("token");

  // Clean up all active operations
  stopAudio();
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  resetStreamingState();
  voiceChatMode = false;
  ttsEnabled = false;
  handsfreeActive = false;
  handsfreeOverlay.classList.add("hidden");
  ttsBtn.classList.remove("active");
  openaiKeyOk = null;
  pendingMicAccess = false;
  if (handsfreeSilentNode) {
    try { handsfreeSilentNode.stop(); } catch {}
    handsfreeSilentNode = null;
  }
  if (handsfreeAudioCtx) {
    handsfreeAudioCtx.close().catch(() => {});
    handsfreeAudioCtx = null;
  }
  handsfreeSourceNode = null;
  if (mediaRecorder && mediaRecorder.state === "recording") {
    clearTimeout(recordingTimeout);
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder = null;
    audioChunks = [];
    voiceBtn.classList.remove("recording");
  }
  // Kill the global mic stream (globalMicStream cleanup covers all tracks)
  if (globalMicStream) {
    globalMicStream.getTracks().forEach((t) => t.stop());
    globalMicStream = null;
  }
  handsfreeStream = null;

  setupEl.classList.remove("hidden");
  appEl.classList.remove("active");
}

// ---- API ----
async function api(path, options = {}) {
  const resp = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  handleAuthHeaders(resp);

  if (!resp.ok && resp.status !== 204) {
    if (resp.status === 401 || resp.status === 403) {
      kickToSetup();
      return null;
    }
    throw new Error(`API ${resp.status}: ${await resp.text()}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

// ---- Setup ----
function checkSetup() {
  if (TOKEN) {
    setupEl.classList.add("hidden");
    appEl.classList.add("active");
    loadConversations();
    preRequestMic();
  }
}

// Request mic on first user gesture after login — keeps stream alive globally
// so subsequent handsfree/voice taps never prompt.
let micPreRequesting = false;
function preRequestMic() {
  if (globalMicStream || !navigator.mediaDevices) return;
  function grabMic() {
    if (globalMicStream || micPreRequesting) return;
    micPreRequesting = true;
    document.removeEventListener("click", grabMic, true);
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      globalMicStream = stream;
    }).catch(() => {}).finally(() => {
      micPreRequesting = false;
    });
  }
  document.addEventListener("click", grabMic, true);
}

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

    TOKEN = data.token;
    localStorage.setItem("token", data.token);
    localStorage.setItem("device_id", data.device_id);
    checkSetup();
  } catch (e) {
    setupError.textContent = `Connection failed: ${e.message}`;
    setupError.style.display = "block";
  } finally {
    setupSave.disabled = false;
    setupSave.textContent = "Pair";
  }
});

// ---- Settings Modal ----
const settingsOverlay = $("#settings-overlay");
const settingsDevice = $("#settings-device");
const logoutBtn = $("#logout-btn");

settingsBtn.addEventListener("click", async () => {
  const deviceId = localStorage.getItem("device_id");
  settingsDevice.textContent = deviceId ? deviceId.slice(0, 8) + "..." : "—";
  settingsOverlay.classList.add("show");
  // Load settings
  try {
    const data = await api("/settings");
    if (data && data.settings) {
      if (data.settings.process_idle_timeout_hours) {
        settingsTimeout.value = data.settings.process_idle_timeout_hours;
      }
      if (data.settings.process_pool_max) {
        settingsPoolMax.value = data.settings.process_pool_max;
      }
    }
  } catch {}
});

settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) {
    settingsOverlay.classList.remove("show");
  }
});

logoutBtn.addEventListener("click", () => {
  settingsOverlay.classList.remove("show");
  setupCode.value = "";
  setupError.style.display = "none";
  kickToSetup();
  localStorage.removeItem("device_id");
});

settingsSaveBtn.addEventListener("click", async () => {
  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving...";
  try {
    await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ key: "process_idle_timeout_hours", value: settingsTimeout.value }),
    });
    await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ key: "process_pool_max", value: settingsPoolMax.value }),
    });
    showToast("Settings saved");
  } catch {
    showToast("Failed to save settings");
  } finally {
    settingsSaveBtn.disabled = false;
    settingsSaveBtn.textContent = "Save Settings";
  }
});

// ---- Conversations ----
async function loadConversations() {
  const data = await api("/conversations");
  if (data) {
    // Track process status from conversation data
    convProcessStatus = {};
    for (const conv of data.conversations) {
      if (conv.process_status) {
        convProcessStatus[conv.id] = conv.process_status;
      }
    }
    renderConvList(data.conversations);
    updateSessionBadge(currentConvId);
  }
}

function renderConvList(convs) {
  convList.innerHTML = "";
  for (const conv of convs) {
    const el = document.createElement("div");
    el.className = `conv-item${conv.id === currentConvId ? " active" : ""}`;
    const dotHtml = conv.process_status ? '<span class="process-dot"></span>' : '';
    el.innerHTML = `
      ${dotHtml}<span class="title">${esc(conv.title)}</span>
      <span class="conv-actions">
        <button class="edit-btn">&#9999;&#65039;</button>
        <button class="delete-btn">&times;</button>
      </span>
    `;
    el.querySelector(".title").addEventListener("click", () => openConversation(conv.id, conv.title));
    el.querySelector(".edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      startSidebarRename(el, conv);
    });
    el.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    convList.appendChild(el);
  }
}

function startSidebarRename(el, conv) {
  if (el.querySelector(".rename-input")) return;
  const titleSpan = el.querySelector(".title");
  const actions = el.querySelector(".conv-actions");
  const oldTitle = conv.title;

  const input = document.createElement("input");
  input.className = "rename-input";
  input.type = "text";
  input.value = oldTitle;

  titleSpan.style.display = "none";
  actions.style.display = "none";
  el.insertBefore(input, titleSpan);
  input.focus();
  input.select();

  let done = false;
  function finish(save) {
    if (done) return;
    done = true;
    const newTitle = input.value.trim();
    input.remove();
    titleSpan.style.display = "";
    actions.style.display = "";
    if (save && newTitle && newTitle !== oldTitle) {
      renameConversation(conv.id, newTitle);
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

async function openConversation(id, title) {
  stopAudio();
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  if (isStreaming) resetStreamingState();
  currentConvId = id;
  convTitle.textContent = title || "New Chat";
  closeSidebar();

  const data = await api(`/conversations/${id}`);
  if (data && currentConvId === id) renderMessages(data.messages);
  updateSessionBadge(id);
}

let isCreatingConv = false;
async function createConversation() {
  if (isCreatingConv) return null;
  isCreatingConv = true;
  stopAudio();
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  if (isStreaming) resetStreamingState();
  const prevConvId = currentConvId;
  try {
    const data = await api("/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!data) return null;
    // Guard: another navigation changed context during await
    if (currentConvId !== prevConvId) {
      loadConversations();
      return null;
    }
    currentConvId = data.id;
    convTitle.textContent = "New Chat";
    renderMessages([]);
    loadConversations();
    closeSidebar();
    updateSessionBadge(data.id);
    return data.id;
  } finally {
    isCreatingConv = false;
  }
}

async function deleteConversation(id) {
  // Stop any warm/active process before deleting
  if (convProcessStatus[id]) {
    await api(`/conversations/${id}/process/stop`, { method: "POST" }).catch(() => {});
    delete convProcessStatus[id];
  }
  await api(`/conversations/${id}`, { method: "DELETE" });
  if (currentConvId === id) {
    stopAudio();
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    if (isStreaming) resetStreamingState();
    currentConvId = null;
    convTitle.textContent = "New Chat";
    renderMessages([]);
    updateSessionBadge(null);
  }
  loadConversations();
}

async function renameConversation(id, newTitle) {
  const trimmed = newTitle.trim();
  if (!trimmed) return;
  const data = await api(`/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: trimmed }),
  });
  if (data) {
    if (currentConvId === id) convTitle.textContent = trimmed;
    loadConversations();
  }
}

// ---- Session Badge ----
function updateSessionBadge(convId) {
  if (convId && convProcessStatus[convId] && !isStreaming) {
    sessionBadge.classList.remove("hidden");
  } else {
    sessionBadge.classList.add("hidden");
  }
}

sessionStopBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!currentConvId) return;
  try {
    await api(`/conversations/${currentConvId}/process/stop`, { method: "POST" });
    delete convProcessStatus[currentConvId];
    updateSessionBadge(currentConvId);
    loadConversations();
    showToast("Session stopped");
  } catch (err) {
    showToast("Failed to stop session");
  }
});

// ---- Messages ----
function renderMessages(msgs) {
  msgContainer.innerHTML = "";
  if (!msgs.length) {
    msgContainer.innerHTML = '<div class="empty-state"><span>&#128172;</span><p>Send a message to start</p></div>';
    return;
  }
  for (const msg of msgs) {
    appendMessage(msg.role, msg.content, msg.status === "error");
  }
  scrollToBottom();
}

function appendMessage(role, text, isError = false) {
  // Remove empty state
  const empty = msgContainer.querySelector(".empty-state");
  if (empty) empty.remove();

  const el = document.createElement("div");
  el.className = `msg ${role}${isError ? " error" : ""}`;
  el.textContent = text;
  if (role === "assistant" && !isError && text) {
    el.appendChild(createPlayBtn(text));
  }
  msgContainer.appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    msgContainer.scrollTop = msgContainer.scrollHeight;
  });
}

// ---- Send Message ----
let isSending = false;

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || isStreaming || isSending) return;
  isSending = true;

  stopAudio();

  // Stop any active recording (never kill tracks — stream is reused globally)
  if (mediaRecorder && mediaRecorder.state === "recording") {
    clearTimeout(recordingTimeout);
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder = null;
    audioChunks = [];
    voiceBtn.classList.remove("recording");
  }

  // Clear input immediately
  msgInput.value = "";
  autoResize();
  setInputState(true);

  // Create conversation if needed
  if (!currentConvId) {
    const id = await createConversation();
    if (!id) {
      setInputState(false);
      isSending = false;
      return;
    }
  }

  // Add user message to UI
  appendMessage("user", text);

  try {
    const data = await api(`/conversations/${currentConvId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: text }),
    });

    if (!data) {
      setInputState(false);
      isSending = false;
      return;
    }

    // Update title from first message
    if (convTitle.textContent === "New Chat") {
      const shortTitle = text.length > 30 ? text.slice(0, 30) + "..." : text;
      convTitle.textContent = shortTitle;
    }

    // Start streaming response
    streamResponse(data.assistant_message_id);
  } catch (e) {
    appendMessage("assistant", `Error: ${e.message}`, true);
    setInputState(false);
    isSending = false;
  }
}

function streamResponse(messageId) {
  isStreaming = true;
  sendBtn.style.display = "none";
  stopBtn.style.display = "";
  const assistantEl = appendMessage("assistant", "");
  assistantEl.classList.add("streaming");
  let fullText = "";

  const url = `${WORKER_URL}/messages/${messageId}/stream?token=${encodeURIComponent(TOKEN)}`;
  const es = new EventSource(url);
  es.onerror = () => es.close();
  activeEventSource = es;

  let currentToolBlock = null;

  es.addEventListener("chunk", (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    const chunkType = data.type || "text";

    if (chunkType === "text") {
      fullText += data.text;
      // Rebuild: keep tool blocks, update trailing text
      rebuildAssistantEl();
    } else if (chunkType === "tool_use") {
      currentToolBlock = document.createElement("div");
      currentToolBlock.className = "tool-block";
      currentToolBlock.innerHTML = '<span class="tool-name">' + esc(data.text) + '</span>';
      assistantEl.appendChild(currentToolBlock);
    } else if (chunkType === "tool_input") {
      if (currentToolBlock) {
        currentToolBlock.appendChild(document.createTextNode("\n" + data.text));
      }
    } else if (chunkType === "tool_result" || chunkType === "tool_error") {
      const resultBlock = document.createElement("div");
      resultBlock.className = "tool-block" + (chunkType === "tool_error" ? " tool-error" : "");
      resultBlock.textContent = data.text;
      assistantEl.appendChild(resultBlock);
      currentToolBlock = null;
    }

    scrollToBottom();
  });

  function rebuildAssistantEl() {
    // Find or create the text node at the end
    let textNode = assistantEl.querySelector(".msg-text");
    if (!textNode) {
      textNode = document.createElement("span");
      textNode.className = "msg-text";
      assistantEl.appendChild(textNode);
    }
    textNode.textContent = fullText;
  }

  function endStream() {
    es.close();
    activeEventSource = null;
    assistantEl.classList.remove("streaming");
    resetStreamingState();
  }

  es.addEventListener("done", () => {
    endStream();
    loadConversations();

    if (fullText) {
      const btn = createPlayBtn(fullText);
      assistantEl.appendChild(btn);
      if (ttsEnabled) {
        speak(fullText, btn);
      } else if (handsfreeActive) {
        setHandsfreeState("green");
      }
    } else if (handsfreeActive) {
      setHandsfreeState("green");
    }
  });

  es.addEventListener("error", (e) => {
    endStream();
    if (handsfreeActive) setHandsfreeState("green");
    if (!fullText) {
      const errorEl = document.createElement("span");
      errorEl.className = "msg-text";
      errorEl.textContent = "Error receiving response";
      assistantEl.appendChild(errorEl);
      assistantEl.classList.add("error");
    }
  });
}

function setInputState(disabled) {
  sendBtn.disabled = disabled || !msgInput.value.trim();
  msgInput.disabled = disabled;
  if (!disabled) msgInput.focus();
}

function resetStreamingState() {
  isStreaming = false;
  isSending = false;
  stopBtn.style.display = "none";
  sendBtn.style.display = "";
  setInputState(false);
}

// ---- Input Handling ----
msgInput.addEventListener("input", () => {
  sendBtn.disabled = !msgInput.value.trim() || isStreaming;
  autoResize();
});

msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

msgInput.addEventListener("focus", stabilizeKeyboardViewport);
msgInput.addEventListener("blur", () => {
  setTimeout(queueViewportSync, 0);
  setTimeout(queueViewportSync, 120);
});

sendBtn.addEventListener("click", sendMessage);

stopBtn.addEventListener("click", () => {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  resetStreamingState();
  const streaming = msgContainer.querySelector(".msg.streaming");
  if (streaming) {
    streaming.classList.remove("streaming");
    const textSpan = streaming.querySelector(".msg-text");
    const hasText = textSpan ? textSpan.textContent.trim() : streaming.textContent.trim();
    if (!hasText) {
      const stoppedEl = document.createElement("span");
      stoppedEl.className = "msg-text";
      stoppedEl.textContent = "(stopped)";
      streaming.appendChild(stoppedEl);
      streaming.classList.add("error");
    }
  }
});

function autoResize() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
}

// ---- Voice Input (MediaRecorder + OpenAI Transcription) ----
function initVoiceInput() {
  if (!window.MediaRecorder) {
    voiceBtn.style.display = "none";
  }
}

function startRecording() {
  if (pendingMicAccess) return;
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  // Reuse global mic stream if available (no permission prompt).
  const stream = handsfreeStream || globalMicStream;
  const canReuse = stream && stream.getAudioTracks().some((t) => t.readyState === "live");
  if (canReuse) {
    beginRecording(stream, false);
  } else {
    pendingMicAccess = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
      pendingMicAccess = false;
      globalMicStream = s;
      beginRecording(s, false);
    }).catch(() => {
      pendingMicAccess = false;
      showToast("Microphone access denied");
    });
  }
}

function beginRecording(stream, stopTracksOnEnd) {
  audioChunks = [];
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";
  mediaRecorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    clearTimeout(recordingTimeout);
    if (stopTracksOnEnd) stream.getTracks().forEach((t) => t.stop());
    voiceBtn.classList.remove("recording");
    if (audioChunks.length) {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      transcribeAndSend(blob, mediaRecorder.mimeType);
    } else if (handsfreeActive) {
      setHandsfreeState("green");
    }
  };

  mediaRecorder.start();
  voiceBtn.classList.add("recording");

  // Auto-stop after 60s
  recordingTimeout = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, MAX_RECORDING_MS);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
}

async function transcribeAndSend(audioBlob, mimeType) {
  voiceBtn.classList.add("transcribing");
  const savedPlaceholder = msgInput.placeholder;
  msgInput.placeholder = "Transcribing...";

  try {
    const resp = await fetch(`${WORKER_URL}/transcribe`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": mimeType || "audio/webm",
      },
      body: audioBlob,
    });

    handleAuthHeaders(resp);

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        kickToSetup();
        return;
      }
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Transcription failed (${resp.status})`);
    }

    const data = await resp.json();
    if (data.text && data.text.trim()) {
      msgInput.value = data.text.trim();
      autoResize();
      sendMessage();
    } else if (handsfreeActive) {
      setHandsfreeState("green");
    }
  } catch (e) {
    showToast(e.message || "Transcription failed");
    if (handsfreeActive) setHandsfreeState("green");
  } finally {
    voiceBtn.classList.remove("transcribing");
    msgInput.placeholder = savedPlaceholder;
  }
}

function showToast(message, duration = 3000) {
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

async function checkOpenAIKey() {
  if (openaiKeyOk === true) return true;
  try {
    const resp = await fetch(`${WORKER_URL}/tts`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    handleAuthHeaders(resp);
    if (resp.status === 401 || resp.status === 403) {
      kickToSetup();
      return false;
    }
    const data = await resp.json();
    if (!resp.ok) {
      openaiKeyOk = false;
      showToast(data.error || "OpenAI not available", 60000);
      return false;
    }
    openaiKeyOk = true;
    return true;
  } catch {
    showToast("Connection failed", 5000);
    return false;
  }
}

voiceBtn.addEventListener("click", async () => {
  if (!window.MediaRecorder) return;
  if (!(await checkOpenAIKey())) return;
  enterHandsfree();
});

// ---- Voice Chat Mode (TTS + auto-record) ----
let voiceChatMode = false;

ttsBtn.addEventListener("click", async () => {
  if (!(await checkOpenAIKey())) return;
  enterHandsfree();
});

// ---- Hands-Free Mode ----
const handsfreeOverlay = $("#handsfree-overlay");
const handsfreeOrb = $("#handsfree-orb");
const handsfreeLabel = $("#handsfree-label");
const handsfreeExit = $("#handsfree-exit");
let handsfreeActive = false;
// "green" = ready, "blue" = recording, "amber" = thinking, "purple" = talking
let handsfreeState = "green";
let handsfreeAudioCtx = null; // AudioContext for speaker-routed playback
let handsfreeStream = null; // persistent mic stream to avoid re-prompting
let handsfreeSourceNode = null; // current AudioBufferSourceNode
let handsfreeSilentNode = null; // keeps audio session alive between sentences

async function enterHandsfree() {
  if (handsfreeActive) return;
  // Use the global mic stream if available, otherwise request now.
  if (globalMicStream && globalMicStream.getAudioTracks().some((t) => t.readyState === "live")) {
    handsfreeStream = globalMicStream;
  } else {
    try {
      handsfreeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      globalMicStream = handsfreeStream;
    } catch {
      showToast("Microphone access denied");
      return;
    }
  }

  handsfreeActive = true;
  voiceChatMode = true;
  ttsEnabled = true;
  ttsBtn.classList.add("active");
  handsfreeOverlay.classList.remove("hidden");

  // Create and unlock AudioContext during user gesture.
  // AudioContext always routes through the main speaker (not earpiece).
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    handsfreeAudioCtx = new AC();
    // Keep a silent oscillator running to hold the audio session open.
    // Without this, iOS drops speaker routing between sentences.
    const osc = handsfreeAudioCtx.createOscillator();
    const gain = handsfreeAudioCtx.createGain();
    gain.gain.value = 0; // silent
    osc.connect(gain);
    gain.connect(handsfreeAudioCtx.destination);
    osc.start();
    handsfreeSilentNode = osc;
  }

  // If TTS is currently playing (continued from before), show purple.
  // Otherwise show green (ready).
  if (currentPlayBtn && currentPlayBtn.classList.contains("playing")) {
    setHandsfreeState("purple");
  } else {
    setHandsfreeState("green");
  }
}

function exitHandsfree() {
  handsfreeActive = false;
  voiceChatMode = false;
  ttsEnabled = false;
  ttsBtn.classList.remove("active");
  handsfreeOverlay.classList.add("hidden");
  stopRecording();

  // Stop WebAudio source but DON'T abort TTS — let playback continue
  // via <audio> element. The onended callback will call playNext() which
  // checks mode dynamically and switches to <audio> path.
  if (handsfreeSourceNode) {
    try { handsfreeSourceNode.stop(); } catch {}
    handsfreeSourceNode = null;
  }
  if (handsfreeSilentNode) {
    try { handsfreeSilentNode.stop(); } catch {}
    handsfreeSilentNode = null;
  }
  if (handsfreeAudioCtx) {
    handsfreeAudioCtx.close().catch(() => {});
    handsfreeAudioCtx = null;
  }
  // Keep the mic stream alive globally (don't stop tracks)
  handsfreeStream = null;
}

function setHandsfreeState(state) {
  handsfreeState = state;
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

// Tap anywhere on the overlay (except exit button) to toggle state
handsfreeOverlay.addEventListener("click", (e) => {
  if (e.target === handsfreeExit || handsfreeExit.contains(e.target)) return;
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

function stopAudio() {
  // Cancel pending TTS fetches
  if (ttsAbort) {
    ttsAbort.abort();
    ttsAbort = null;
  }
  ttsQueue = [];

  // Stop AudioContext source (handsfree mode)
  if (handsfreeSourceNode) {
    try { handsfreeSourceNode.stop(); } catch {}
    handsfreeSourceNode = null;
  }

  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio.src && currentAudio.src.startsWith("blob:")) {
      URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio = null;
  }
  if (currentPlayBtn) {
    currentPlayBtn.textContent = "\u25B6";
    currentPlayBtn.classList.remove("playing", "loading", "paused");
    currentPlayBtn = null;
  }
}

function pauseAudio() {
  if (currentAudio) {
    currentAudio.pause();
  }
  if (currentPlayBtn) {
    currentPlayBtn.textContent = "\u25B6";
    currentPlayBtn.classList.remove("playing");
    currentPlayBtn.classList.add("paused");
  }
}

function resumeAudio() {
  if (currentAudio) {
    currentAudio.play().catch(() => {
      // Revert to paused state if resume fails
      if (currentPlayBtn) {
        currentPlayBtn.textContent = "\u25B6";
        currentPlayBtn.classList.remove("playing");
        currentPlayBtn.classList.add("paused");
      }
    });
  }
  if (currentPlayBtn) {
    currentPlayBtn.textContent = "\u25A0";
    currentPlayBtn.classList.remove("paused");
    currentPlayBtn.classList.add("playing");
  }
}

function createPlayBtn(text) {
  const btn = document.createElement("button");
  btn.className = "play-btn";
  btn.textContent = "\u25B6";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (btn.classList.contains("playing")) {
      pauseAudio();
    } else if (btn.classList.contains("paused")) {
      resumeAudio();
    } else if (btn.classList.contains("loading")) {
      stopAudio();
    } else {
      speak(text, btn);
    }
  });
  return btn;
}

function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space/newline
  // Respect common abbreviations (Mr., Dr., etc.)
  const abbrevs = /(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|i\.e|e\.g)\.\s/gi;
  const parts = [];
  let working = text;

  // Temporarily replace abbreviations
  const placeholders = [];
  working = working.replace(abbrevs, (match) => {
    placeholders.push(match);
    return `__ABBR${placeholders.length - 1}__`;
  });

  // Split on .!? followed by space or end
  const raw = working.split(/(?<=[.!?])\s+/);

  for (const chunk of raw) {
    // Restore abbreviations
    let restored = chunk;
    for (let i = 0; i < placeholders.length; i++) {
      restored = restored.replace(`__ABBR${i}__`, placeholders[i]);
    }
    const trimmed = restored.trim();
    if (trimmed) parts.push(trimmed);
  }

  return parts;
}

async function fetchTtsBlob(text, signal) {
  const resp = await fetch(`${WORKER_URL}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal,
  });

  handleAuthHeaders(resp);

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      kickToSetup();
      throw new Error("auth");
    }
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || "TTS failed");
  }

  return resp.blob();
}

async function speak(text, playBtn) {
  stopAudio();

  const sentences = splitSentences(text);
  if (sentences.length === 0) return;

  if (playBtn) {
    playBtn.textContent = "\u00B7\u00B7\u00B7";
    playBtn.classList.add("loading");
    currentPlayBtn = playBtn;
  }

  // Audio element created lazily when needed (non-handsfree or handsfree exit).
  // In handsfree mode, AudioContext routes through the main speaker.
  // playNext checks dynamically so handsfree exit hands off to <audio> seamlessly.
  let audioEl = null;

  function getAudioEl() {
    if (!audioEl) {
      audioEl = new Audio();
      currentAudio = audioEl;
    }
    return audioEl;
  }

  const abort = new AbortController();
  ttsAbort = abort;
  ttsQueue = [];

  let playing = false;
  let allFetched = false;

  function playNext() {
    if (abort.signal.aborted) return;

    if (ttsQueue.length > 0) {
      const blob = ttsQueue.shift();
      playing = true;

      if (playBtn) {
        playBtn.textContent = "\u25A0";
        playBtn.classList.remove("loading");
        playBtn.classList.add("playing");
      }
      if (handsfreeActive) setHandsfreeState("purple");

      // Check dynamically each sentence: WebAudio if handsfree, else <audio>
      if (handsfreeActive && handsfreeAudioCtx) {
        // Decode blob → AudioBuffer → play through AudioContext (speaker)
        blob.arrayBuffer().then((ab) => {
          if (abort.signal.aborted) return null;
          return handsfreeAudioCtx.decodeAudioData(ab);
        }).then((audioBuffer) => {
          if (abort.signal.aborted || !audioBuffer) {
            playing = false;
            handsfreeSourceNode = null;
            if (!abort.signal.aborted) {
              if (ttsQueue.length > 0 || !allFetched) playNext();
              else finishPlayback();
            }
            return;
          }
          const source = handsfreeAudioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(handsfreeAudioCtx.destination);
          handsfreeSourceNode = source;
          source.onended = () => {
            handsfreeSourceNode = null;
            if (abort.signal.aborted) return;
            playing = false;
            playNext();
          };
          source.start();
        }).catch(() => {
          playing = false;
          handsfreeSourceNode = null;
          if (abort.signal.aborted) return;
          if (ttsQueue.length > 0 || !allFetched) playNext();
          else finishPlayback();
        });
      } else {
        const audio = getAudioEl();
        const url = URL.createObjectURL(blob);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (abort.signal.aborted) return;
          playing = false;
          playNext();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          if (abort.signal.aborted) return;
          playing = false;
          if (ttsQueue.length > 0 || !allFetched) playNext();
          else finishPlayback();
        };
        audio.src = url;
        audio.load();
        audio.play().catch(() => {
          URL.revokeObjectURL(url);
          playing = false;
          if (ttsQueue.length > 0 || !allFetched) playNext();
          else finishPlayback();
        });
      }
    } else if (allFetched) {
      finishPlayback();
    }
    // else: waiting for prefetch — will be kicked when blobs arrive
  }

  function finishPlayback() {
    playing = false;
    if (currentPlayBtn === playBtn) {
      if (playBtn) {
        playBtn.textContent = "\u25B6";
        playBtn.classList.remove("playing", "loading", "paused");
      }
      currentPlayBtn = null;
      currentAudio = null;
    }
    if (handsfreeActive) {
      setHandsfreeState("green");
    } else if (voiceChatMode && !isStreaming) {
      startRecording();
    }
  }

  try {
    // Use cached blobs if available (avoids re-fetching TTS)
    if (ttsCache.has(text)) {
      ttsQueue = [...ttsCache.get(text)];
      allFetched = true;
      playNext();
      return;
    }

    // Fetch first batch (up to 5) in parallel BEFORE starting playback.
    // This ensures the queue has multiple items ready, so when onended fires
    // the next blob is immediately available.
    const cacheBlobs = [];
    const firstBatch = sentences.slice(0, Math.min(5, sentences.length));
    const firstBlobs = await Promise.all(
      firstBatch.map((s) => fetchTtsBlob(s, abort.signal).catch((e) => {
        if (e.message === "auth") throw e;
        return null;
      }))
    );
    let sentenceIdx = firstBatch.length;

    if (abort.signal.aborted) return;

    for (const blob of firstBlobs) {
      if (blob) {
        ttsQueue.push(blob);
        cacheBlobs.push(blob);
      }
    }

    if (ttsQueue.length === 0) {
      finishPlayback();
      return;
    }

    allFetched = sentenceIdx >= sentences.length;
    playNext();

    // Prefetch remaining sentences in batches of 5
    while (sentenceIdx < sentences.length && !abort.signal.aborted) {
      const batch = sentences.slice(sentenceIdx, sentenceIdx + 5);
      const promises = batch.map((s) => fetchTtsBlob(s, abort.signal).catch(() => null));
      const blobs = await Promise.all(promises);
      sentenceIdx += batch.length;

      for (const blob of blobs) {
        if (abort.signal.aborted) return;
        if (blob) {
          ttsQueue.push(blob);
          cacheBlobs.push(blob);
          if (!playing) playNext();
        }
      }
    }

    allFetched = true;
    if (!playing) playNext();

    // Cache all blobs for instant replay
    if (cacheBlobs.length > 0) {
      if (ttsCache.size >= TTS_CACHE_MAX) {
        const oldest = ttsCache.keys().next().value;
        ttsCache.delete(oldest);
      }
      ttsCache.set(text, cacheBlobs);
    }
  } catch (e) {
    if (abort.signal.aborted) return;
    stopAudio();
    if (e.message === "auth") return;
    showToast(e.message || "TTS failed", 6000);
  }
}

// ---- Header Title Rename ----
convTitle.addEventListener("click", () => {
  if (!currentConvId || convTitle.textContent === "New Chat") return;

  const oldTitle = convTitle.textContent;
  const input = document.createElement("input");
  input.className = "title-input";
  input.type = "text";
  input.value = oldTitle;

  convTitle.style.display = "none";
  convTitle.parentNode.insertBefore(input, convTitle.nextSibling);
  input.focus();
  input.select();

  let done = false;
  function finish(save) {
    if (done) return;
    done = true;
    const newTitle = input.value.trim();
    input.remove();
    convTitle.style.display = "";
    if (save && newTitle && newTitle !== oldTitle) {
      renameConversation(currentConvId, newTitle);
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
});

// ---- Sidebar ----
menuBtn.addEventListener("click", () => {
  sidebar.classList.add("open");
  sidebarOverlay.classList.add("show");
});

function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarOverlay.classList.remove("show");
}

sidebarOverlay.addEventListener("click", closeSidebar);
newChatBtn.addEventListener("click", createConversation);

// ---- Helpers ----
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---- Usage Dashboard ----
const usageOverlay = $("#usage-overlay");
const usageClose = $("#usage-close");
const usageContent = $("#usage-content");
const usageBtn = $("#usage-btn");
let usageCache = { daily: null, monthly: null };

const CATEGORY_LABELS = {
  memory_l1: "Memory L1",
  memory_l2: "Memory L2",
  memory_curate: "Memory Curate",
  memory_embedding: "Embeddings",
  memory_reconcile: "Reconcile",
  transcribe: "Transcribe",
  tts: "TTS",
};

const CATEGORY_CLASSES = {
  memory_l1: "cat-memory",
  memory_l2: "cat-memory",
  memory_curate: "cat-memory",
  memory_embedding: "cat-memory",
  memory_reconcile: "cat-memory",
  transcribe: "cat-transcribe",
  tts: "cat-tts",
};

function formatCost(usd) {
  if (usd < 0.01) return "$" + usd.toFixed(4);
  return "$" + usd.toFixed(2);
}

function renderUsageData(rows, periodKey) {
  if (!rows || rows.length === 0) {
    usageContent.innerHTML = '<p class="usage-empty">No usage data yet.</p>';
    return;
  }

  // Group by period
  const periods = {};

  for (const row of rows) {
    const key = row[periodKey];
    if (!periods[key]) periods[key] = { rows: [], total: 0 };
    periods[key].rows.push(row);
    periods[key].total += row.cost_usd;
  }

  let html = "";
  for (const [period, data] of Object.entries(periods)) {
    html += '<div class="usage-period">';
    html += `<div class="usage-period-header"><span>${esc(period)}</span><span class="usage-period-total">${formatCost(data.total)}</span></div>`;

    // Merge memory subcategories for display bar proportions
    const maxRowCost = Math.max(...data.rows.map((r) => r.cost_usd));

    for (const row of data.rows) {
      const catClass = CATEGORY_CLASSES[row.category] || "cat-memory";
      const label = CATEGORY_LABELS[row.category] || esc(row.category);
      const barPct = maxRowCost > 0 ? Math.max(2, (row.cost_usd / maxRowCost) * 100) : 0;

      html += `<div class="usage-row">
        <span class="cat-dot ${catClass}"></span>
        <span class="cat-name">${label}</span>
        <span class="usage-bar-wrap"><span class="usage-bar ${catClass}" style="width:${barPct}%"></span></span>
        <span class="cat-cost">${formatCost(row.cost_usd)}</span>
      </div>`;
    }

    html += "</div>";
  }

  usageContent.innerHTML = html;
}

async function loadUsageTab(tab) {
  usageContent.innerHTML = '<p class="usage-loading">Loading...</p>';

  try {
    if (!usageCache[tab]) {
      const data = await api(`/usage/${tab}`);
      if (data) usageCache[tab] = data.rows;
    }

    const periodKey = tab === "daily" ? "date" : "month";
    renderUsageData(usageCache[tab], periodKey);
  } catch (e) {
    usageContent.innerHTML = `<p class="usage-empty">Failed to load: ${esc(e.message)}</p>`;
  }
}

usageBtn.addEventListener("click", () => {
  settingsOverlay.classList.remove("show");
  usageOverlay.classList.add("show");
  usageCache = { daily: null, monthly: null };
  loadUsageTab("daily");
});

usageClose.addEventListener("click", () => {
  usageOverlay.classList.remove("show");
});

document.querySelectorAll(".usage-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".usage-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    loadUsageTab(tab.dataset.tab);
  });
});

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
// v25
