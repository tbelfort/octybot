import {
  currentConvId, setCurrentConvId,
  isStreaming, convProcessStatus, setConvProcessStatus,
  activeProject, activeAgent,
} from "./state";
import {
  convList, convTitle, sidebarProjectSelect, sessionBadge, sessionStopBtn,
} from "./dom";
import { api } from "./api";
import { esc, showToast, cancelActiveWork, inlineRename } from "./ui-helpers";
import type { Conversation, Message } from "../shared/api-types";

// Forward declarations
let _renderMessages: (msgs: Message[]) => void = () => {};
let _closeSidebar: () => void = () => {};
let _updateSessionBadge: (convId: string | null) => void = () => {};

export function registerConversationDeps(deps: {
  renderMessages: (msgs: Message[]) => void;
  closeSidebar: () => void;
}) {
  _renderMessages = deps.renderMessages;
  _closeSidebar = deps.closeSidebar;
}

function formatProjAgent(proj: string, agent: string): string {
  const p = proj && proj !== "default" ? proj : "";
  const b = agent && agent !== "default" ? agent : "";
  if (p && b) return `${p} / ${b}`;
  return p || b || "";
}

export function updateSessionBadge(convId: string | null) {
  if (convId && convProcessStatus[convId] && !isStreaming) {
    sessionBadge.classList.remove("hidden");
  } else {
    sessionBadge.classList.add("hidden");
  }
}

export async function loadConversations() {
  try {
    const project = sidebarProjectSelect.value;
    const url = project === "__all" ? "/conversations" : `/conversations?project=${encodeURIComponent(project)}`;
    const data = await api(url);
    if (data) {
      // Track process status from conversation data
      const newStatus: Record<string, string> = {};
      for (const conv of data.conversations) {
        if (conv.process_status) {
          newStatus[conv.id] = conv.process_status;
        }
      }
      setConvProcessStatus(newStatus);
      renderConvList(data.conversations);
      updateSessionBadge(currentConvId);
    }
  } catch (err) {
    console.error("Failed to load conversations:", err);
    showToast("Failed to load conversations");
  }
}

function renderConvList(convs: Conversation[]) {
  convList.innerHTML = "";
  for (const conv of convs) {
    const el = document.createElement("div");
    el.className = `conv-item${conv.id === currentConvId ? " active" : ""}`;
    const dotHtml = conv.process_status ? '<span class="process-dot"></span>' : '';
    const projAgent = formatProjAgent(conv.project_name, conv.agent_name);
    el.innerHTML = `
      ${dotHtml}<div class="conv-item-text">
        <span class="title">${esc(conv.title)}</span>
        ${projAgent ? `<span class="conv-agent-label">${esc(projAgent)}</span>` : ""}
      </div>
      <span class="conv-actions">
        <button class="edit-btn">&#9999;&#65039;</button>
        <button class="delete-btn">&times;</button>
      </span>
    `;
    el.querySelector(".conv-item-text")!.addEventListener("click", () => openConversation(conv.id, conv.title));
    el.querySelector(".edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      startSidebarRename(el, conv);
    });
    el.querySelector(".delete-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    convList.appendChild(el);
  }
}

function startSidebarRename(el: HTMLElement, conv: Conversation) {
  const textWrap = el.querySelector(".conv-item-text") as HTMLElement;
  inlineRename(el, textWrap, conv.title, (newTitle) => {
    renameConversation(conv.id, newTitle);
  });
}

export async function openConversation(id: string, title: string) {
  cancelActiveWork();
  setCurrentConvId(id);
  convTitle.textContent = title || "New Chat";
  _closeSidebar();

  const data = await api(`/conversations/${id}`);
  if (data && currentConvId === id) _renderMessages(data.messages);
  updateSessionBadge(id);
}

let isCreatingConv = false;

export async function createConversation(): Promise<string | null> {
  if (isCreatingConv) return null;
  isCreatingConv = true;
  cancelActiveWork();
  const prevConvId = currentConvId;
  try {
    const data = await api("/conversations", {
      method: "POST",
      body: JSON.stringify({ project_name: activeProject, agent_name: activeAgent }),
    });
    if (!data) return null;
    // Guard: another navigation changed context during await
    if (currentConvId !== prevConvId) {
      loadConversations();
      return null;
    }
    setCurrentConvId(data.id);
    convTitle.textContent = "New Chat";
    _renderMessages([]);
    loadConversations();
    _closeSidebar();
    updateSessionBadge(data.id);
    return data.id;
  } finally {
    isCreatingConv = false;
  }
}

export async function deleteConversation(id: string) {
  try {
    // Stop any warm/active process before deleting
    if (convProcessStatus[id]) {
      await api(`/conversations/${id}/process/stop`, { method: "POST" }).catch(() => {});
      delete convProcessStatus[id];
    }
    await api(`/conversations/${id}`, { method: "DELETE" });
    if (currentConvId === id) {
      cancelActiveWork();
      setCurrentConvId(null);
      convTitle.textContent = "New Chat";
      _renderMessages([]);
      updateSessionBadge(null);
    }
    loadConversations();
  } catch (err) {
    console.error("Failed to delete conversation:", err);
    showToast("Failed to delete conversation");
  }
}

export async function renameConversation(id: string, newTitle: string) {
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

export function initConversationListeners() {
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
}
