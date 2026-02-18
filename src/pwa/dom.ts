export const $ = (sel: string) => document.querySelector(sel)!;

// Setup
export const setupEl = $("#setup") as HTMLDivElement;
export const appEl = $("#app") as HTMLDivElement;
export const setupCode = $("#setup-code") as HTMLInputElement;
export const setupSave = $("#setup-save") as HTMLButtonElement;
export const setupError = $("#setup-error") as HTMLParagraphElement;

// Header
export const convTitle = $("#conv-title") as HTMLHeadingElement;
export const menuBtn = $("#menu-btn") as HTMLButtonElement;
export const settingsBtn = $("#settings-btn") as HTMLButtonElement;
export const sessionBadge = $("#session-badge") as HTMLSpanElement;
export const sessionStopBtn = $("#session-stop-btn") as HTMLButtonElement;

// Sidebar
export const sidebar = $("#sidebar") as HTMLElement;
export const sidebarOverlay = $("#sidebar-overlay") as HTMLDivElement;
export const convList = $("#conv-list") as HTMLDivElement;
export const newChatBtn = $("#new-chat-btn") as HTMLButtonElement;
export const sidebarProjectSelect = $("#sidebar-project-select") as HTMLSelectElement;
export const newChatTarget = $("#new-chat-target") as HTMLDivElement;

// Messages & Input
export const msgContainer = $("#messages") as HTMLDivElement;
export const msgInput = $("#msg-input") as HTMLTextAreaElement;
export const sendBtn = $("#send-btn") as HTMLButtonElement;
export const stopBtn = $("#stop-btn") as HTMLButtonElement;
export const voiceBtn = $("#voice-btn") as HTMLButtonElement;
export const ttsBtn = $("#tts-btn") as HTMLButtonElement;

// Settings overlay
export const settingsOverlay = $("#settings-overlay") as HTMLDivElement;
export const settingsDevice = $("#settings-device") as HTMLSpanElement;
export const settingsClose = $("#settings-close") as HTMLButtonElement;
export const logoutBtn = $("#logout-btn") as HTMLButtonElement;
export const settingsTimeout = $("#settings-timeout") as HTMLInputElement;
export const settingsPoolMax = $("#settings-pool-max") as HTMLInputElement;
export const settingsSaveBtn = $("#settings-save-btn") as HTMLButtonElement;
export const settingsSnapshotDir = $("#settings-snapshot-dir") as HTMLInputElement;
export const browseSnapshotDir = $("#browse-snapshot-dir") as HTMLButtonElement;

// Projects & Agents
export const projectList = $("#project-list") as HTMLDivElement;
export const projectListView = $("#project-list-view") as HTMLDivElement;
export const projectDetailView = $("#project-detail-view") as HTMLDivElement;
export const projectBackBtn = $("#project-back-btn") as HTMLButtonElement;
export const projectDetailName = $("#project-detail-name") as HTMLHeadingElement;
export const agentList = $("#agent-list") as HTMLDivElement;
export const newProjectBtn = $("#new-project-btn") as HTMLButtonElement;
export const newAgentBtn = $("#new-agent-btn") as HTMLButtonElement;
export const deleteProjectBtn = $("#delete-project-btn") as HTMLButtonElement;

// New project dialog
export const newProjectOverlay = $("#new-project-overlay") as HTMLDivElement;
export const newProjectNameInput = $("#new-project-name") as HTMLInputElement;
export const newProjectDirInput = $("#new-project-dir") as HTMLInputElement;
export const newProjectCancelBtn = $("#new-project-cancel") as HTMLButtonElement;
export const newProjectCreateBtn = $("#new-project-create") as HTMLButtonElement;

// Handsfree
export const handsfreeOverlay = $("#handsfree-overlay") as HTMLDivElement;
export const handsfreeOrb = $("#handsfree-orb") as HTMLDivElement;
export const handsfreeLabel = $("#handsfree-label") as HTMLDivElement;
export const handsfreeExit = $("#handsfree-exit") as HTMLButtonElement;

// Usage
export const usageSummary = $("#usage-summary") as HTMLDivElement;
export const usageDetailBtn = $("#usage-detail-btn") as HTMLButtonElement;
export const usageDetail = $("#usage-detail") as HTMLDivElement;
export const usageContent = $("#usage-content") as HTMLDivElement;
