# PWA Architecture

The PWA is a mobile-first chat interface for Octybot. It's vanilla TypeScript with no framework — all DOM manipulation is direct. Bun bundles the `.ts` modules into a single `app.js`, which is deployed as a static site on Cloudflare Pages alongside `index.html`, `style.css`, and `sw.js`.

**Source**: `src/pwa/`
**Deploy**: `cd ~/.octybot/pwa && npx wrangler pages deploy . --project-name octybot-pwa`
**Build**: Bun bundle (part of `install-global.ts`)

## Modules

| Module | Purpose |
|--------|---------|
| `main.ts` | Entry point — wires up dependency injection, event listeners, service worker |
| `state.ts` | All mutable state — module-level variables with setter functions |
| `api.ts` | API client — fetch wrapper with auth headers and token refresh |
| `dom.ts` | DOM element references — cached `querySelector` results |
| `messaging.ts` | Message sending and response streaming (SSE) |
| `conversations.ts` | Conversation list, create, delete, rename |
| `voice.ts` | Voice recording pipeline (MediaRecorder → transcription) |
| `tts.ts` | Text-to-speech pipeline (sentence splitting → batch fetch → audio queue) |
| `handsfree.ts` | Hands-free voice mode state machine |
| `auth-setup.ts` | Pairing code entry, auth check, logout |
| `settings.ts` | Settings modal — pool config, memory toggle, usage display |
| `projects.ts` | Project and agent management UI |
| `usage.ts` | Usage cost tracking display |
| `ui-helpers.ts` | Shared utilities — HTML escape, scroll, toast, inline rename |
| `viewport.ts` | iOS viewport locking to prevent keyboard jitter |
| `index.html` | HTML structure — setup screen, chat UI, handsfree overlay, settings modal |
| `style.css` | Dark theme styles, responsive layout, animations |
| `sw.js` | Service worker — cache static assets, network-only for API routes |

## Dependency Injection Pattern

With 15+ TypeScript modules that need to call each other's functions, circular imports are inevitable in vanilla TS. The solution is a dependency injection pattern:

Each module that needs functions from other modules exports a `register*Deps()` function. The entry point (`main.ts`) calls all registration functions after all modules are imported, wiring up the cross-module dependencies:

```typescript
// main.ts (simplified)
registerStopAudio(stopAudio);
registerResetStreamingState(resetStreamingState);
registerAuthDeps({ stopAudio, resetStreamingState, loadConversations, loadSidebarProjects, updateNewChatTarget });
registerVoiceDeps({ autoResize, sendMessage, setHandsfreeState });
registerTtsDeps({ setHandsfreeState });
registerMessagingDeps({ setHandsfreeState });
registerConversationDeps({ renderMessages, closeSidebar });
registerSettingsDeps({ loadSidebarProjects, loadConversations, updateNewChatTarget, loadProjects });
```

Inside each module, the injected functions are stored as module-level variables (prefixed with `_`) and called through those references:

```typescript
// voice.ts
let _sendMessage: () => void;
export function registerVoiceDeps(deps: { sendMessage: () => void; ... }) {
  _sendMessage = deps.sendMessage;
}
```

This avoids circular imports entirely — no module imports another module at the top level for function references. They only import `state.ts` (read-only state) and `dom.ts` (element references), which have no outgoing dependencies.

## State Management

All mutable state lives in `state.ts` as module-level `let` variables with exported getter/setter functions. There's no state management library, no store pattern, no events — just direct variable access.

State is organized by concern:

**Configuration**: `WORKER_URL`, `TTS_BATCH_SIZE`, `TITLE_MAX_LENGTH`, `MAX_RECORDING_MS`

**Auth**: `TOKEN` (stored in localStorage), `openaiKeyOk` (cached OpenAI key check)

**Conversation**: `currentConvId`, `isStreaming`, `isSending`, `isCreatingConv`

**Voice**: `mediaRecorder`, `audioChunks`, `recordingTimeout`, `pendingMicAccess`, `globalMicStream`

**Audio**: `currentAudio`, `currentPlayBtn`, `ttsAbort`, `ttsQueue`, `ttsCache` (Map with LRU eviction, max 20 entries)

**Handsfree**: `voiceChatMode`, `handsfreeActive`, `handsfreeState` (state machine value), `handsfreeAudioCtx`, `handsfreeStream`, `handsfreeSourceNode`, `handsfreeSilentNode`

**Project/Agent**: `activeProject`, `activeAgent`, `projectsData`, `cachedSettings`, `usageCache`

## Message Flow

### Sending

1. User types text (or transcribed voice) in the textarea
2. `sendMessage()` validates input, creates a conversation if needed
3. `POST /conversations/:id/messages` sends the text
4. Immediately calls `streamResponse(assistantMessageId)`

### Streaming (SSE)

1. Open `EventSource` to `GET /messages/:id/stream?token=...`
2. Parse each `chunk` event:
   - `text` → append to the assistant message's `.msg-text` span
   - `tool_use` → create a `.tool-block` div with the tool name
   - `tool_input` → append formatted JSON to the tool block
   - `tool_result` / `tool_error` → create a separate result block
3. On `done` event → close stream, reload conversation list, optionally speak response (if TTS enabled)
4. On error → clean up, show "(stopped)" if interrupted

The PWA renders text progressively — each chunk appends to the DOM as it arrives, with a blinking cursor animation during streaming.

## Voice Pipeline

Voice input converts speech to text via OpenAI's Whisper API:

1. User taps the mic button (or enters handsfree mode)
2. `startRecording()` requests microphone access (reuses `globalMicStream` if available)
3. `MediaRecorder` captures audio chunks (webm/opus or mp4 format)
4. Auto-stop after 60 seconds (`MAX_RECORDING_MS`)
5. User taps again (or silence timeout in handsfree) → `stopRecording()`
6. `transcribeAndSend()` posts the audio blob to `POST /transcribe`
7. Transcribed text is placed in the input field and `sendMessage()` is called automatically

The global mic stream is pre-requested on the first user gesture (click) to avoid permission popups during handsfree mode.

## TTS Pipeline

Text-to-speech converts assistant responses to audio:

1. `speak(text, playBtn)` splits text into sentences using `splitSentences()`
2. Check the TTS cache (`ttsCache`: Map of full text → Blob array). If cached, play immediately.
3. Fetch first batch of 5 sentences in parallel via `POST /tts`
4. Start `playNext()` — plays the first audio blob while prefetching the rest
5. Each blob plays via `<audio>` element (normal mode) or `AudioBufferSourceNode` (handsfree mode)
6. When all blobs are played, cache them (LRU eviction at 20 entries)

Sentence splitting handles abbreviations (Mr., Dr., etc.) and preserves natural sentence boundaries.

## Hands-Free Mode

Hands-free mode is a voice conversation loop with a visual state machine:

```
┌─────────┐  tap  ┌─────────┐  tap  ┌─────────┐         ┌──────────┐
│  green  │──────▶│  blue   │──────▶│  amber  │────────▶│  purple  │
│  Ready  │       │ Listen  │       │ Think   │         │  Speak   │
└─────────┘       └─────────┘       └─────────┘         └────┬─────┘
     ▲                                                        │ tap
     └────────────────────────────────────────────────────────┘
```

- **Green** (ready) — tap to start recording
- **Blue** (listening) — recording audio, tap to stop and send
- **Amber** (thinking) — waiting for Claude's response
- **Purple** (speaking) — playing TTS audio, tap to interrupt and start new recording

The overlay shows a pulsing colored orb with a label. A silent oscillator keeps the WebAudio context alive to prevent iOS from suspending audio playback between sentences.

### Entering handsfree

1. Request microphone access (reuse `globalMicStream`)
2. Create `AudioContext` (unlocked on user gesture)
3. Create silent oscillator to hold the audio session open
4. Show the overlay, set state to green (or purple if already speaking)

### Exiting handsfree

1. Hide the overlay
2. Stop WebAudio source and silent oscillator
3. Close AudioContext
4. Keep the global mic stream alive for quick re-entry

## Build and Deploy

The PWA is bundled during global install:

```bash
bun src/memory/install-global.ts   # Bundles src/pwa/*.ts → ~/.octybot/pwa/app.js
```

Bun's bundler compiles all TypeScript modules into a single `app.js` file, which is copied alongside `index.html`, `style.css`, and `sw.js` to `~/.octybot/pwa/`.

Deployment:

```bash
cd ~/.octybot/pwa && npx wrangler pages deploy . --project-name octybot-pwa
```

The `WORKER_URL` constant in `state.ts` is patched during install with the real Worker URL.

## Service Worker

The service worker (`sw.js`) uses a network-first strategy with cache fallback:

- **Static assets** (`/`, `/index.html`, `/style.css`, `/app.js`): cached on install, updated on network success, served from cache if offline
- **API routes** (anything matching `/conversations`, `/messages`, `/settings`, `/usage`, `/projects`, `/devices`, `/memory`, `/transcribe`, `/tts`): network-only, never cached
- **Cache versioning**: `octybot-v20` — old caches are deleted on activation

## Styling

Dark theme with CSS custom properties:

```css
--bg: #0a0a0a          /* Page background */
--surface: #141414     /* Cards, assistant messages */
--surface-2: #1e1e1e   /* Secondary surfaces */
--border: #2a2a2a      /* Borders */
--text: #e8e8e8        /* Primary text */
--text-dim: #888       /* Secondary text */
--accent: #c4a0ff      /* Purple accent */
--user-bg: #1a1a2e     /* User message background */
```

Layout is mobile-first with safe-area insets for iOS notch devices. The viewport module locks CSS variables (`--app-width`, `--app-height`, etc.) to `window.visualViewport` dimensions, preventing layout jitter when the iOS keyboard appears.
