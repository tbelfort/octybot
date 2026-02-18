import {
  WORKER_URL, TOKEN, TITLE_MAX_LENGTH,
  currentConvId, isStreaming, setIsStreaming,
  isSending, setIsSending,
  activeEventSource, setActiveEventSource,
  ttsEnabled, handsfreeActive,
} from "./state";
import {
  msgContainer, msgInput, sendBtn, stopBtn, convTitle,
} from "./dom";
import { api } from "./api";
import { esc, scrollToBottom, cancelRecording } from "./ui-helpers";
import { createPlayBtn, speak, stopAudio } from "./tts";
import { createConversation, loadConversations } from "./conversations";
import { stabilizeKeyboardViewport, queueViewportSync } from "./viewport";
import type { Message } from "../shared/api-types";

// Forward declaration
let _setHandsfreeState: (state: string) => void = () => {};
export function registerMessagingDeps(deps: { setHandsfreeState: (state: string) => void }) {
  _setHandsfreeState = deps.setHandsfreeState;
}

export function renderMessages(msgs: Message[]) {
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

export function appendMessage(role: string, text: string, isError = false): HTMLDivElement {
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
  return el as HTMLDivElement;
}

export async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || isStreaming || isSending) return;
  setIsSending(true);

  stopAudio();
  cancelRecording();

  // Clear input immediately
  msgInput.value = "";
  autoResize();
  setInputState(true);

  // Create conversation if needed
  if (!currentConvId) {
    const id = await createConversation();
    if (!id) {
      setInputState(false);
      setIsSending(false);
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
      setIsSending(false);
      return;
    }

    // Update title from first message
    if (convTitle.textContent === "New Chat") {
      const shortTitle = text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH) + "..." : text;
      convTitle.textContent = shortTitle;
    }

    // Start streaming response
    streamResponse(data.assistant_message_id);
  } catch (e: any) {
    appendMessage("assistant", `Error: ${e.message}`, true);
    setInputState(false);
    setIsSending(false);
  }
}

function streamResponse(messageId: string) {
  setIsStreaming(true);
  sendBtn.style.display = "none";
  stopBtn.style.display = "";
  const assistantEl = appendMessage("assistant", "");
  assistantEl.classList.add("streaming");
  let fullText = "";

  const url = `${WORKER_URL}/messages/${messageId}/stream?token=${encodeURIComponent(TOKEN)}`;
  const es = new EventSource(url);
  setActiveEventSource(es);

  let currentToolBlock: HTMLDivElement | null = null;
  let lastSeq = -1;

  es.addEventListener("chunk", (e) => {
    let data: any;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.sequence <= lastSeq) return; // skip duplicate on reconnect
    lastSeq = data.sequence;
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
    setActiveEventSource(null);
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
        _setHandsfreeState("green");
      }
    } else if (handsfreeActive) {
      _setHandsfreeState("green");
    }
  });

  es.addEventListener("error", (e) => {
    // EventSource.CONNECTING (0) = transient error, auto-reconnecting — let it retry.
    // EventSource.CLOSED (2) = permanent failure — clean up.
    if (es.readyState === EventSource.CONNECTING) return;

    endStream();
    if (handsfreeActive) _setHandsfreeState("green");
    if (!fullText) {
      const errorEl = document.createElement("span");
      errorEl.className = "msg-text";
      errorEl.textContent = "Error receiving response";
      assistantEl.appendChild(errorEl);
      assistantEl.classList.add("error");
    }
  });
}

export function setInputState(disabled: boolean) {
  sendBtn.disabled = disabled || !msgInput.value.trim();
  msgInput.disabled = disabled;
  if (!disabled) msgInput.focus();
}

export function resetStreamingState() {
  setIsStreaming(false);
  setIsSending(false);
  stopBtn.style.display = "none";
  sendBtn.style.display = "";
  setInputState(false);
}

export function autoResize() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + "px";
}

export function initInputListeners() {
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
      setActiveEventSource(null);
    }
    resetStreamingState();
    const streaming = msgContainer.querySelector(".msg.streaming");
    if (streaming) {
      streaming.classList.remove("streaming");
      const textSpan = streaming.querySelector(".msg-text");
      const hasText = textSpan ? textSpan.textContent!.trim() : streaming.textContent!.trim();
      if (!hasText) {
        const stoppedEl = document.createElement("span");
        stoppedEl.className = "msg-text";
        stoppedEl.textContent = "(stopped)";
        streaming.appendChild(stoppedEl);
        streaming.classList.add("error");
      }
    }
  });
}
