import type { ProjectEntry, UsageRow } from "../shared/api-types";

// ---- Config ----
export const WORKER_URL = "https://octybot-worker.YOUR-SUBDOMAIN.workers.dev";
export const TTS_BATCH_SIZE = 5;
export const TITLE_MAX_LENGTH = 30;
export const MAX_RECORDING_MS = 60_000;
export const TTS_CACHE_MAX = 20;

// ---- Auth ----
export let TOKEN: string = localStorage.getItem("token") || "";
export function setToken(t: string) {
  TOKEN = t;
  if (t) localStorage.setItem("token", t);
  else localStorage.removeItem("token");
}

// ---- Conversation state ----
export let currentConvId: string | null = null;
export function setCurrentConvId(id: string | null) {
  currentConvId = id;
}

export let isStreaming = false;
export function setIsStreaming(v: boolean) {
  isStreaming = v;
}

export let isSending = false;
export function setIsSending(v: boolean) {
  isSending = v;
}

export let isCreatingConv = false;
export function setIsCreatingConv(v: boolean) {
  isCreatingConv = v;
}

// ---- Voice/audio state ----
export let ttsEnabled = false;
export function setTtsEnabled(v: boolean) {
  ttsEnabled = v;
}

export let mediaRecorder: MediaRecorder | null = null;
export function setMediaRecorder(mr: MediaRecorder | null) {
  mediaRecorder = mr;
}

export let audioChunks: Blob[] = [];
export function setAudioChunks(c: Blob[]) {
  audioChunks = c;
}

export let recordingTimeout: ReturnType<typeof setTimeout> | null = null;
export function setRecordingTimeout(t: ReturnType<typeof setTimeout> | null) {
  recordingTimeout = t;
}

export let pendingMicAccess = false;
export function setPendingMicAccess(v: boolean) {
  pendingMicAccess = v;
}

export let currentAudio: HTMLAudioElement | null = null;
export function setCurrentAudio(a: HTMLAudioElement | null) {
  currentAudio = a;
}

export let currentPlayBtn: HTMLButtonElement | null = null;
export function setCurrentPlayBtn(b: HTMLButtonElement | null) {
  currentPlayBtn = b;
}

export let openaiKeyOk: boolean | null = null; // null = unchecked, true/false = cached result
export function setOpenaiKeyOk(v: boolean | null) {
  openaiKeyOk = v;
}

export let activeEventSource: EventSource | null = null;
export function setActiveEventSource(es: EventSource | null) {
  activeEventSource = es;
}

export let ttsAbort: AbortController | null = null;
export function setTtsAbort(a: AbortController | null) {
  ttsAbort = a;
}

export let ttsQueue: Blob[] = [];
export function setTtsQueue(q: Blob[]) {
  ttsQueue = q;
}

export const ttsCache = new Map<string, Blob[]>();

export let convProcessStatus: Record<string, string> = {};
export function setConvProcessStatus(s: Record<string, string>) {
  convProcessStatus = s;
}

export let globalMicStream: MediaStream | null = null;
export function setGlobalMicStream(s: MediaStream | null) {
  globalMicStream = s;
}

// ---- Handsfree state ----
export let voiceChatMode = false;
export function setVoiceChatMode(v: boolean) {
  voiceChatMode = v;
}

export let handsfreeActive = false;
export function setHandsfreeActive(v: boolean) {
  handsfreeActive = v;
}

export let handsfreeState = "green";
export function setHandsfreeStateVal(s: string) {
  handsfreeState = s;
}

export let handsfreeAudioCtx: AudioContext | null = null;
export function setHandsfreeAudioCtx(ctx: AudioContext | null) {
  handsfreeAudioCtx = ctx;
}

export let handsfreeStream: MediaStream | null = null;
export function setHandsfreeStream(s: MediaStream | null) {
  handsfreeStream = s;
}

export let handsfreeSourceNode: AudioBufferSourceNode | null = null;
export function setHandsfreeSourceNode(n: AudioBufferSourceNode | null) {
  handsfreeSourceNode = n;
}

export let handsfreeSilentNode: OscillatorNode | null = null;
export function setHandsfreeSilentNode(n: OscillatorNode | null) {
  handsfreeSilentNode = n;
}

// ---- Project/agent state ----
export let activeProject = "default";
export function setActiveProject(p: string) {
  activeProject = p;
}

export let activeAgent = "default";
export function setActiveAgent(a: string) {
  activeAgent = a;
}

export let projectsData: ProjectEntry[] = [];
export function setProjectsData(p: ProjectEntry[]) {
  projectsData = p;
}

// ---- Settings cache ----
export let cachedSettings: Record<string, string> | null = null;
export function setCachedSettings(s: Record<string, string> | null) {
  cachedSettings = s;
}

// ---- Usage cache ----
export let usageCache: { daily: UsageRow[] | null; monthly: UsageRow[] | null } = { daily: null, monthly: null };
export function setUsageCache(c: { daily: UsageRow[] | null; monthly: UsageRow[] | null }) {
  usageCache = c;
}

// ---- Mic pre-request flag ----
export let micPreRequesting = false;
export function setMicPreRequesting(v: boolean) {
  micPreRequesting = v;
}
