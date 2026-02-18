import {
  ttsAbort, setTtsAbort,
  ttsQueue, setTtsQueue,
  ttsCache, TTS_CACHE_MAX, TTS_BATCH_SIZE,
  currentAudio, setCurrentAudio,
  currentPlayBtn, setCurrentPlayBtn,
  handsfreeActive, handsfreeAudioCtx,
  handsfreeSourceNode, setHandsfreeSourceNode,
  TOKEN, WORKER_URL, openaiKeyOk, setOpenaiKeyOk, setToken,
} from "./state";
import { rawFetch } from "./api";
import { setPlayBtnState, showToast } from "./ui-helpers";
import { kickToSetup } from "./auth-setup";

// Forward declaration — set at init
let _setHandsfreeState: (state: string) => void = () => {};
export function registerTtsDeps(deps: { setHandsfreeState: (state: string) => void }) {
  _setHandsfreeState = deps.setHandsfreeState;
}

function handleAuthHeaders(resp: Response) {
  const refreshToken = resp.headers.get("X-Refresh-Token");
  if (refreshToken) {
    setToken(refreshToken);
  }
}

export function stopAudio() {
  // Cancel pending TTS fetches
  if (ttsAbort) {
    ttsAbort.abort();
    setTtsAbort(null);
  }
  setTtsQueue([]);

  // Stop AudioContext source (handsfree mode)
  if (handsfreeSourceNode) {
    try { handsfreeSourceNode.stop(); } catch {}
    setHandsfreeSourceNode(null);
  }

  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio.src && currentAudio.src.startsWith("blob:")) {
      URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio.onended = null;
    currentAudio.onerror = null;
    setCurrentAudio(null);
  }
  setPlayBtnState(currentPlayBtn, "play");
  setCurrentPlayBtn(null);
}

export function pauseAudio() {
  if (currentAudio) {
    currentAudio.pause();
  }
  setPlayBtnState(currentPlayBtn, "paused");
}

export function resumeAudio() {
  if (currentAudio) {
    currentAudio.play().catch(() => {
      setPlayBtnState(currentPlayBtn, "paused");
    });
  }
  setPlayBtnState(currentPlayBtn, "stop");
}

export function createPlayBtn(text: string): HTMLButtonElement {
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

export function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space/newline
  // Respect common abbreviations (Mr., Dr., etc.)
  const abbrevs = /(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|i\.e|e\.g)\.\s/gi;
  const parts: string[] = [];
  let working = text;

  // Temporarily replace abbreviations
  const placeholders: string[] = [];
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

async function fetchTtsBlob(text: string, signal: AbortSignal): Promise<Blob> {
  const resp = await rawFetch("/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!resp) throw new Error("auth"); // kicked to setup

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || "TTS failed");
  }

  return resp.blob();
}

export async function checkOpenAIKey(): Promise<boolean> {
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
      setOpenaiKeyOk(false);
      showToast(data.error || "OpenAI not available", 60000);
      return false;
    }
    setOpenaiKeyOk(true);
    return true;
  } catch {
    showToast("Connection failed", 5000);
    return false;
  }
}

export async function speak(text: string, playBtn: HTMLButtonElement | null) {
  stopAudio();

  const sentences = splitSentences(text);
  if (sentences.length === 0) return;

  if (playBtn) {
    setPlayBtnState(playBtn, "loading");
    setCurrentPlayBtn(playBtn);
  }

  // Audio element created lazily when needed (non-handsfree or handsfree exit).
  let audioEl: HTMLAudioElement | null = null;

  function getAudioEl(): HTMLAudioElement {
    if (!audioEl) {
      audioEl = new Audio();
      setCurrentAudio(audioEl);
    }
    return audioEl;
  }

  const abort = new AbortController();
  setTtsAbort(abort);
  setTtsQueue([]);

  let playing = false;
  let allFetched = false;

  // We need a mutable reference to ttsQueue within this closure.
  // Since setTtsQueue replaces the array in state, we maintain a local reference.
  let localQueue: Blob[] = [];

  function playNext() {
    if (abort.signal.aborted) return;

    if (localQueue.length > 0) {
      const blob = localQueue.shift()!;
      playing = true;

      setPlayBtnState(playBtn, "stop");
      if (handsfreeActive) _setHandsfreeState("purple");

      // Check dynamically each sentence: WebAudio if handsfree, else <audio>
      if (handsfreeActive && handsfreeAudioCtx) {
        // Decode blob -> AudioBuffer -> play through AudioContext (speaker)
        blob.arrayBuffer().then((ab) => {
          if (abort.signal.aborted) return null;
          return handsfreeAudioCtx!.decodeAudioData(ab);
        }).then((audioBuffer) => {
          if (abort.signal.aborted || !audioBuffer) {
            playing = false;
            setHandsfreeSourceNode(null);
            if (!abort.signal.aborted) {
              if (localQueue.length > 0 || !allFetched) playNext();
              else finishPlayback();
            }
            return;
          }
          const source = handsfreeAudioCtx!.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(handsfreeAudioCtx!.destination);
          setHandsfreeSourceNode(source);
          source.onended = () => {
            setHandsfreeSourceNode(null);
            if (abort.signal.aborted) return;
            playing = false;
            playNext();
          };
          source.start();
        }).catch(() => {
          playing = false;
          setHandsfreeSourceNode(null);
          if (abort.signal.aborted) return;
          if (localQueue.length > 0 || !allFetched) playNext();
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
          if (localQueue.length > 0 || !allFetched) playNext();
          else finishPlayback();
        };
        audio.src = url;
        audio.load();
        audio.play().catch(() => {
          URL.revokeObjectURL(url);
          playing = false;
          if (localQueue.length > 0 || !allFetched) playNext();
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
      setPlayBtnState(playBtn, "play");
      setCurrentPlayBtn(null);
      setCurrentAudio(null);
    }
    if (handsfreeActive) {
      _setHandsfreeState("green");
    }
  }

  try {
    // Use cached blobs if available (avoids re-fetching TTS)
    if (ttsCache.has(text)) {
      localQueue = [...ttsCache.get(text)!];
      allFetched = true;
      playNext();
      return;
    }

    // Fetch first batch (up to 5) in parallel BEFORE starting playback.
    const cacheBlobs: Blob[] = [];
    const firstBatch = sentences.slice(0, Math.min(TTS_BATCH_SIZE, sentences.length));
    const firstBlobs = await Promise.all(
      firstBatch.map((s) => fetchTtsBlob(s, abort.signal).catch((e: any) => {
        if (e.message === "auth") throw e;
        return null;
      }))
    );
    let sentenceIdx = firstBatch.length;

    if (abort.signal.aborted) return;

    for (const blob of firstBlobs) {
      if (blob) {
        localQueue.push(blob);
        cacheBlobs.push(blob);
      }
    }

    if (localQueue.length === 0) {
      finishPlayback();
      return;
    }

    allFetched = sentenceIdx >= sentences.length;
    playNext();

    // Prefetch remaining sentences in batches of 5
    while (sentenceIdx < sentences.length && !abort.signal.aborted) {
      const batch = sentences.slice(sentenceIdx, sentenceIdx + TTS_BATCH_SIZE);
      const promises = batch.map((s) => fetchTtsBlob(s, abort.signal).catch(() => null));
      const blobs = await Promise.all(promises);
      sentenceIdx += batch.length;

      for (const blob of blobs) {
        if (abort.signal.aborted) return;
        if (blob) {
          localQueue.push(blob);
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
        if (oldest !== undefined) ttsCache.delete(oldest);
      }
      ttsCache.set(text, cacheBlobs);
    }
  } catch (e: any) {
    if (abort.signal.aborted) return;
    stopAudio();
    if (e.message === "auth") return;
    showToast(e.message || "TTS failed", 6000);
  }
}
