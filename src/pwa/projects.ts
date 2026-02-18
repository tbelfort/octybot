import {
  activeProject, setActiveProject,
  activeAgent, setActiveAgent,
  projectsData, setProjectsData,
  cachedSettings,
} from "./state";
import {
  $,
  sidebarProjectSelect, newChatTarget,
  projectList, projectListView, projectDetailView,
  projectBackBtn, projectDetailName, agentList,
  newProjectBtn, newAgentBtn, deleteProjectBtn,
  newProjectOverlay, newProjectNameInput, newProjectDirInput,
  newProjectCancelBtn, newProjectCreateBtn,
} from "./dom";
import { api } from "./api";
import { esc, showToast } from "./ui-helpers";
import { loadConversations } from "./conversations";
import type { ProjectEntry, AgentEntry } from "../shared/api-types";

function formatProjAgent(proj: string, agent: string): string {
  const p = proj && proj !== "default" ? proj : "";
  const b = agent && agent !== "default" ? agent : "";
  if (p && b) return `${p} / ${b}`;
  return p || b || "";
}

export function updateNewChatTarget() {
  const label = formatProjAgent(activeProject, activeAgent);
  newChatTarget.textContent = label ? `New chats \u2192 ${label}` : "";
  newChatTarget.style.display = label ? "" : "none";
}

export async function loadSidebarProjects() {
  try {
    const data = await api("/projects");
    if (!data || !data.projects) return;
    const named = data.projects.filter((p: ProjectEntry) => p.name !== "default");
    sidebarProjectSelect.innerHTML = '<option value="__all">All Projects</option>';
    for (const p of named) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      if (p.name === activeProject) opt.selected = true;
      sidebarProjectSelect.appendChild(opt);
    }
    // If active project is non-default and wasn't in the list, add it
    if (activeProject && activeProject !== "default" && activeProject !== "__all" && !sidebarProjectSelect.querySelector(`option[value="${activeProject}"]`)) {
      const opt = document.createElement("option");
      opt.value = activeProject;
      opt.textContent = activeProject;
      opt.selected = true;
      sidebarProjectSelect.appendChild(opt);
    }
    // Hide selector entirely if no named projects
    sidebarProjectSelect.style.display = named.length > 0 ? "" : "none";
  } catch {}
}

export async function loadProjects() {
  try {
    const data = await api("/projects");
    if (!data || !data.projects) return;
    setProjectsData(data.projects.filter((p: ProjectEntry) => p.name !== "default"));
    renderProjectList();
  } catch {}
}

function renderProjectList() {
  projectList.innerHTML = "";
  const projects = projectsData.length > 0 ? projectsData : [{ name: "default" }];
  for (const p of projects) {
    const el = document.createElement("div");
    el.className = `project-list-item${p.name === activeProject ? " active" : ""}`;
    el.innerHTML = `<span>${esc(p.name)}</span><span class="chevron">\u203A</span>`;
    el.addEventListener("click", () => openProjectDetail(p.name));
    projectList.appendChild(el);
  }
}

async function openProjectDetail(name: string) {
  // Set active project
  if (name !== activeProject) {
    setActiveProject(name);
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ key: "active_project", value: activeProject }),
      });
    } catch {}
    renderProjectList();
    loadSidebarProjects();
    loadConversations();
    updateNewChatTarget();
  }
  projectDetailName.textContent = name;
  projectListView.style.display = "none";
  projectDetailView.style.display = "";
  await loadAgents(name);
}

async function loadAgents(projectName: string) {
  try {
    const data = await api(`/projects/${projectName}/agents`);
    if (!data || !data.agents) return;
    renderAgentCards(data.agents);
  } catch {}
}

function renderAgentCards(agents: AgentEntry[]) {
  agentList.innerHTML = "";
  const agentData = agents.length > 0 ? agents : [{ agent_name: "default" }];
  for (const b of agentData) {
    const isActive = b.agent_name === activeAgent;
    const card = document.createElement("div");
    card.className = `agent-card${isActive ? " active" : ""}`;
    card.dataset.agent = b.agent_name;

    const memEnabled = cachedSettings ? cachedSettings.memory_enabled !== "0" : true;

    card.innerHTML = `
      <div class="agent-card-header">
        <div style="display:flex;align-items:center">
          <span class="agent-card-name">${esc(b.agent_name === "default" ? "Memory" : b.agent_name)}</span>
          ${isActive ? '<span class="agent-card-active-dot"></span>' : ""}
        </div>
        <label class="toggle">
          <input type="checkbox" class="agent-memory-toggle" ${memEnabled ? "checked" : ""}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="memory-status agent-memory-status">${isActive ? "Loading..." : "Tap to activate"}</div>
      <div class="agent-actions">
        <button class="memory-btn agent-snapshot-btn">Snapshot</button>
        <button class="memory-btn agent-restore-btn">Restore</button>
        <button class="memory-btn agent-snapshots-btn">Snapshots</button>
      </div>
      <div class="memory-result agent-memory-result" style="display:none"></div>
      <button class="memory-clear-btn agent-clear-btn">Clear Memories</button>
      <div class="agent-tools-placeholder">Tools: coming soon</div>
    `;

    // Click card to activate agent
    card.addEventListener("click", (e) => {
      // Don't activate when clicking buttons/toggles
      if ((e.target as HTMLElement).closest("button") || (e.target as HTMLElement).closest(".toggle")) return;
      activateAgent(b.agent_name);
    });

    // Memory toggle
    card.querySelector(".agent-memory-toggle")!.addEventListener("change", async (e) => {
      e.stopPropagation();
      const val = (e.target as HTMLInputElement).checked ? "1" : "0";
      try {
        await api("/settings", {
          method: "PATCH",
          body: JSON.stringify({ key: "memory_enabled", value: val }),
        });
        showToast((e.target as HTMLInputElement).checked ? "Memory enabled" : "Memory disabled");
      } catch {
        showToast("Failed to update memory setting");
        (e.target as HTMLInputElement).checked = !(e.target as HTMLInputElement).checked;
      }
    });

    // Memory action buttons
    setupAgentCardActions(card, b.agent_name);

    agentList.appendChild(card);

    // Fetch status for active agent
    if (isActive) {
      sendAgentMemoryCommand(card, "status", b.agent_name);
    }
  }
}

async function activateAgent(agentName: string) {
  if (agentName === activeAgent) return;
  setActiveAgent(agentName);
  try {
    await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({ key: "active_agent", value: activeAgent }),
    });
    showToast(`Switched to agent: ${activeAgent}`);
  } catch {}
  updateNewChatTarget();
  // Re-render agent cards
  await loadAgents(activeProject);
}

function setupAgentCardActions(card: HTMLElement, agentName: string) {
  const btns = {
    snapshot: card.querySelector(".agent-snapshot-btn") as HTMLButtonElement,
    restore: card.querySelector(".agent-restore-btn") as HTMLButtonElement,
    snapshots: card.querySelector(".agent-snapshots-btn") as HTMLButtonElement,
    clear: card.querySelector(".agent-clear-btn") as HTMLButtonElement,
  };

  function setDisabled(disabled: boolean) {
    Object.values(btns).forEach((b) => (b.disabled = disabled));
  }

  btns.snapshot.addEventListener("click", async (e) => {
    e.stopPropagation();
    const input = prompt("Snapshot name (leave blank for timestamp):");
    if (input === null) return; // cancelled
    const name = input.trim() || "backup-" + new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
    setDisabled(true);
    await sendAgentMemoryCommand(card, "backup", agentName, { name });
    setDisabled(false);
  });

  btns.restore.addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = prompt("Snapshot name to restore:");
    if (!name) return;
    setDisabled(true);
    await sendAgentMemoryCommand(card, "restore", agentName, { name: name.trim() });
    setDisabled(false);
  });

  btns.snapshots.addEventListener("click", async (e) => {
    e.stopPropagation();
    setDisabled(true);
    await sendAgentMemoryCommand(card, "list", agentName);
    setDisabled(false);
  });

  btns.clear.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to clear ALL memories?")) return;
    if (!confirm("This cannot be undone. Really clear all memories?")) return;
    setDisabled(true);
    await sendAgentMemoryCommand(card, "clear", agentName, { confirm: "yes" });
    setDisabled(false);
  });
}

async function sendAgentMemoryCommand(card: HTMLElement, command: string, agentName: string, args?: Record<string, unknown>) {
  const statusEl = card.querySelector(".agent-memory-status") as HTMLElement;
  const resultEl = card.querySelector(".agent-memory-result") as HTMLElement;
  resultEl.classList.remove("error");

  if (command === "status") {
    statusEl.textContent = "Loading...";
  } else {
    resultEl.textContent = "Running...";
    resultEl.style.display = "block";
  }

  try {
    const resp = await api("/memory/command", {
      method: "POST",
      body: JSON.stringify({ command, args, project: activeProject, agent: agentName }),
    });
    if (!resp) return;

    const { id } = resp;
    const maxAttempts = 15;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const result = await api(`/memory/commands/${id}`);
      if (!result) return;

      if (result.status === "done") {
        if (command === "status") {
          statusEl.textContent = result.result || "OK";
        } else {
          resultEl.textContent = result.result || "Done";
          resultEl.style.display = "block";
        }
        return;
      }
      if (result.status === "error") {
        if (command === "status") {
          statusEl.textContent = result.result || "Error";
        } else {
          resultEl.textContent = result.result || "Error";
          resultEl.classList.add("error");
          resultEl.style.display = "block";
        }
        return;
      }
    }

    const msg = "Timed out \u2014 agent may be offline";
    if (command === "status") {
      statusEl.textContent = msg;
    } else {
      resultEl.textContent = msg;
      resultEl.classList.add("error");
      resultEl.style.display = "block";
    }
  } catch (e: any) {
    const msg = e.message || "Command failed";
    if (command === "status") {
      statusEl.textContent = msg;
    } else {
      resultEl.textContent = msg;
      resultEl.classList.add("error");
      resultEl.style.display = "block";
    }
  }
}

// ---- New Project Dialog ----
function openNewProjectDialog() {
  newProjectNameInput.value = "";
  newProjectDirInput.value = "";
  newProjectCreateBtn.disabled = false;
  newProjectOverlay.classList.add("show");
  setTimeout(() => newProjectNameInput.focus(), 100);
}

function closeNewProjectDialog() {
  newProjectOverlay.classList.remove("show");
}

export function initProjectListeners() {
  projectBackBtn.addEventListener("click", () => {
    projectDetailView.style.display = "none";
    projectListView.style.display = "";
  });

  newProjectBtn.addEventListener("click", openNewProjectDialog);

  newProjectOverlay.addEventListener("click", (e) => {
    if (e.target === newProjectOverlay) closeNewProjectDialog();
  });
  newProjectCancelBtn.addEventListener("click", closeNewProjectDialog);

  newProjectCreateBtn.addEventListener("click", async () => {
    const name = newProjectNameInput.value.trim();
    if (!name) return;
    const clean = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!clean) return;
    const workingDir = newProjectDirInput.value.trim();

    newProjectCreateBtn.disabled = true;
    newProjectCreateBtn.textContent = "Creating...";
    try {
      const body: Record<string, string> = { name: clean };
      if (workingDir) body.working_dir = workingDir;
      const resp = await api("/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (resp) {
        setActiveProject(clean);
        closeNewProjectDialog();
        await loadProjects();
        loadSidebarProjects();
        loadConversations();
        updateNewChatTarget();
        showToast(`Project "${clean}" created`);
      }
    } catch (e: any) {
      showToast(e.message || "Failed to create project");
    } finally {
      newProjectCreateBtn.disabled = false;
      newProjectCreateBtn.textContent = "Create";
    }
  });

  newProjectNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); newProjectCreateBtn.click(); }
    if (e.key === "Escape") closeNewProjectDialog();
  });
  newProjectDirInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); newProjectCreateBtn.click(); }
    if (e.key === "Escape") closeNewProjectDialog();
  });

  newAgentBtn.addEventListener("click", async () => {
    const name = prompt("New agent name:");
    if (!name) return;
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!clean) return;
    try {
      const resp = await api(`/projects/${activeProject}/agents`, {
        method: "POST",
        body: JSON.stringify({ agent_name: clean }),
      });
      if (resp) {
        setActiveAgent(clean);
        await loadAgents(activeProject);
        showToast(`Agent "${clean}" created`);
      }
    } catch (e: any) {
      showToast(e.message || "Failed to create agent");
    }
  });

  deleteProjectBtn.addEventListener("click", async () => {
    const name = activeProject;
    const typed = prompt(`Type "${name}" to confirm deletion:`);
    if (typed === null || typed.trim() !== name) {
      if (typed !== null) showToast("Name didn't match \u2014 cancelled");
      return;
    }
    try {
      await api(`/projects/${name}`, { method: "DELETE" });
      showToast(`Project "${name}" deleted`);
      setActiveProject("default");
      setActiveAgent("default");
      // Go back to project list
      projectDetailView.style.display = "none";
      projectListView.style.display = "";
      await loadProjects();
      loadSidebarProjects();
      loadConversations();
      updateNewChatTarget();
    } catch (e: any) {
      showToast(e.message || "Failed to delete project");
    }
  });

  // Sidebar project selector change
  sidebarProjectSelect.addEventListener("change", () => {
    loadConversations();
  });
}
