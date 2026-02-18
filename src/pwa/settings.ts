import {
  activeProject, setActiveProject,
  activeAgent, setActiveAgent,
  setCachedSettings,
} from "./state";
import {
  $,
  settingsOverlay, settingsDevice, settingsClose, logoutBtn,
  settingsTimeout, settingsPoolMax, settingsSaveBtn, settingsSnapshotDir,
  browseSnapshotDir, setupCode, setupError,
  projectListView, projectDetailView,
} from "./dom";
import { api } from "./api";
import { showToast } from "./ui-helpers";
import { kickToSetup } from "./auth-setup";
import { loadUsageSummary } from "./usage";

// Forward declarations
let _loadSidebarProjects: () => void = () => {};
let _loadConversations: () => void = () => {};
let _updateNewChatTarget: () => void = () => {};
let _loadProjects: () => void = () => {};

export function registerSettingsDeps(deps: {
  loadSidebarProjects: () => void;
  loadConversations: () => void;
  updateNewChatTarget: () => void;
  loadProjects: () => void;
}) {
  _loadSidebarProjects = deps.loadSidebarProjects;
  _loadConversations = deps.loadConversations;
  _updateNewChatTarget = deps.updateNewChatTarget;
  _loadProjects = deps.loadProjects;
}

function closeSettings() {
  settingsOverlay.classList.remove("show");
  // Reset to General tab
  document.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.settings-tab[data-tab="general"]')!.classList.add("active");
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
  $("#tab-general").classList.add("active");
  // Reset projects view
  projectListView.style.display = "";
  projectDetailView.style.display = "none";
}

export function initSettingsListeners() {
  const settingsBtn = $("#settings-btn") as HTMLButtonElement;

  settingsBtn.addEventListener("click", async () => {
    const deviceId = localStorage.getItem("device_id");
    settingsDevice.textContent = deviceId ? deviceId.slice(0, 8) + "..." : "\u2014";
    settingsOverlay.classList.add("show");
    // Load settings
    try {
      const data = await api("/settings");
      if (data && data.settings) {
        setCachedSettings(data.settings);
        if (data.settings.process_idle_timeout_hours) {
          settingsTimeout.value = data.settings.process_idle_timeout_hours;
        }
        if (data.settings.process_pool_max) {
          settingsPoolMax.value = data.settings.process_pool_max;
        }
        settingsSnapshotDir.value = data.settings.snapshot_dir || "";
        const projectChanged = data.settings.active_project && data.settings.active_project !== activeProject;
        if (data.settings.active_project) setActiveProject(data.settings.active_project);
        if (data.settings.active_agent) setActiveAgent(data.settings.active_agent);
        _updateNewChatTarget();
        if (projectChanged) {
          _loadSidebarProjects();
          _loadConversations();
        }
      }
    } catch {}
    // Load usage summary
    loadUsageSummary();
  });

  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  settingsClose.addEventListener("click", closeSettings);

  logoutBtn.addEventListener("click", () => {
    closeSettings();
    setupCode.value = "";
    setupError.style.display = "none";
    kickToSetup();
    localStorage.removeItem("device_id");
  });

  // Settings Tab Switching
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      // Only handle top-level settings tabs (not usage tabs)
      if ((tab as HTMLElement).closest(".usage-detail-tabs")) return;
      document.querySelectorAll(".settings-tabs .settings-tab").forEach((t) => t.classList.remove("active"));
      (tab as HTMLElement).classList.add("active");
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      const pane = $(`#tab-${(tab as HTMLElement).dataset.tab}`);
      if (pane) pane.classList.add("active");
      // Load data when switching to Projects tab
      if ((tab as HTMLElement).dataset.tab === "projects") {
        _loadProjects();
      }
    });
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
      const snapshotDirVal = settingsSnapshotDir.value.trim();
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({ key: "snapshot_dir", value: snapshotDirVal }),
      });
      showToast("Settings saved");
    } catch {
      showToast("Failed to save settings");
    } finally {
      settingsSaveBtn.disabled = false;
      settingsSaveBtn.textContent = "Save Settings";
    }
  });

  browseSnapshotDir.addEventListener("click", async () => {
    browseSnapshotDir.disabled = true;
    browseSnapshotDir.textContent = "...";
    try {
      const resp = await api("/memory/command", {
        method: "POST",
        body: JSON.stringify({ command: "browse_dir", args: {}, project: activeProject, agent: activeAgent }),
      });
      if (!resp) return;
      const { id } = resp;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const result = await api(`/memory/commands/${id}`);
        if (!result) return;
        if (result.status === "done") {
          const dir = result.result?.trim();
          if (dir) {
            settingsSnapshotDir.value = dir;
            showToast("Directory selected \u2014 tap Save Settings");
          } else {
            showToast("No folder selected");
          }
          return;
        }
        if (result.status === "error") {
          showToast(result.result || "Browse failed");
          return;
        }
      }
      showToast("Timed out \u2014 agent may be offline");
    } catch {
      showToast("Browse failed");
    } finally {
      browseSnapshotDir.disabled = false;
      browseSnapshotDir.textContent = "Browse";
    }
  });
}
