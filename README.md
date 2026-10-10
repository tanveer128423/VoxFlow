# LitLabs Voice Assistant

A browser voice assistant with a live WebRTC conversation and a turn-based fallback:

```text
Browser microphone -> OpenAI Realtime WebRTC -> Browser playback
Turn-based fallback: Browser microphone -> STT -> LLM -> TTS -> Browser playback
```

The application is implemented as a focused baseline with provider adapters behind the backend. Credentials are configured locally through environment variables and are never part of the frontend or source control.

## Project structure

- `frontend/` - React, Vite, and TypeScript client
- `backend/` - FastAPI service and provider integrations

## Prerequisites

- Node.js 20+
- Python 3.11+

## Run the backend

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --port 8000
```

Verify the service:

```powershell
Invoke-RestMethod http://localhost:8000/api/health
```

## Run the frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open the URL printed by Vite. The frontend uses `/api` and proxies it to the local FastAPI service.
For a separately deployed frontend and backend, set the Vercel build environment variable
`VITE_API_BASE_URL` to the backend origin, such as `https://your-service.onrender.com`.
Leave it empty for local development so the Vite proxy remains active. Do not put provider
API keys in frontend environment variables.

For Render, configure the service root directory as `backend`, build command as
`pip install -r requirements.txt`, and start command as
`uvicorn app.main:app --host 0.0.0.0 --port $PORT`. Set `FRONTEND_ORIGIN` to the exact
deployed Vercel origin and configure the provider variables in Render's environment settings.
The backend must be served over HTTPS in production.

## Current status

Milestones 1 through 9.1 are implemented. All provider adapters default to mock
implementations, so the app and both automated test suites run without any
credentials. The real provider paths (OpenAI Realtime, OpenAI STT/LLM,
ElevenLabs/Google TTS, Deepgram STT) are implemented but are **not claimed as
verified**: no live provider call is exercised by the tests, and audible or
account-specific behavior (voices, speech speed, VAD/interruption tuning, model
availability, pricing) must be confirmed with live credentials.

Implemented capabilities include: the live OpenAI Realtime WebRTC conversation
with barge-in/interruption and server-VAD tuning; a turn-based STT -> LLM -> TTS
fallback pipeline with per-stage latency; per-session customizable prompt
templates with frontend-editable `{{variable}}` substitution; persistent,
customizable agents (browser localStorage); a live-conversation voice dropdown;
an optional per-agent fallback TTS speed override; per-agent output volume,
minimum response delay, word-count interruption gating, and microphone-
processing controls; voice preview for the Live voices; and browser-observed
per-turn telemetry with a p50 summary. Verified by automation: the backend suite
(`pytest tests/`), the frontend unit tests, and the frontend production build.
See "Latency metrics and telemetry" below for how Live and fallback metrics
differ.

With the backend running and `OPENAI_API_KEY` configured, use **Start live conversation** in a
secure browser context. Allow microphone access and speak naturally; server-side voice activity
detection starts and ends turns, and the assistant audio is streamed back over WebRTC. The browser
only receives a short-lived Realtime client secret from the backend. The standard OpenAI key is
never sent to the browser. The turn-based fallback pipeline remains available internally.
Set `REALTIME_MODEL` and `REALTIME_VOICE` in the backend environment to configure the live session.
The default Realtime model is `gpt-realtime-2.1-mini`; confirm that the selected model is enabled
for the configured OpenAI account before live testing.

The `/api/realtime/session` endpoint is intentionally unauthenticated in this project because
there is no existing application authentication system to extend. It has a small in-process
per-client rate limit controlled by `REALTIME_SESSION_RATE_LIMIT_PER_MINUTE` (default `10` per
minute) to reduce accidental and basic abuse. This limiter is not shared across Render
instances and does not authenticate callers; before exposing the backend publicly, add
application authentication and enforce shared rate limiting at the Render edge or an API
gateway. CORS alone does not protect this endpoint, since non-browser callers can invoke it
directly.

Without an OpenAI key, the fallback remains available. Use the turn-based recording controls,
then stop recording to see the mock transcript, mock assistant response, and audio controls.
Set `STT_PROVIDER=openai` (or `deepgram`), `LLM_PROVIDER=openai`, and
`TTS_PROVIDER=elevenlabs` when testing the real fallback integrations. Google TTS
remains available with `TTS_PROVIDER=google`. The supported provider values are
listed in the Provider selection table below; `groq`/`gemini` are not supported
provider values in this build.

For ElevenLabs, configure these values in `backend/.env`:

```env
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Put the supplied key only in the local `ELEVENLABS_API_KEY` value. Do not put it in frontend files, source control, logs, or screenshots. The voice ID must be a voice available to the ElevenLabs account.

Assistant responses are rendered as Markdown in the browser, while the original
response text is sent unchanged to TTS. Gemini responses that reach the configured
output-token limit are rejected as truncated instead of being shown as complete.

## Local TTS failure recovery test

To test the TTS failure path without changing provider credentials or making an ElevenLabs request, set these values in the backend-only `backend/.env` file:

```env
APP_ENV=development
SIMULATE_TTS_FAILURE=true
SIMULATE_TTS_RETRY_WITH_MOCK=true
```

The simulation runs only after the mock or configured STT and LLM stages have completed. It
returns the transcript and assistant response with a TTS error and no audio, allowing the
fallback error display to be verified. The second flag is required to use deterministic mock
audio if the synthesis endpoint is exercised separately. Leave it `false` to have that
endpoint use the configured TTS provider.

Disable it again with:

```env
SIMULATE_TTS_FAILURE=false
SIMULATE_TTS_RETRY_WITH_MOCK=false
```

The default is `false`. The simulation is also ignored whenever `APP_ENV=production`, even if the flag is accidentally enabled. Restart the backend after changing the environment file.

## Verification

Backend checks:

```powershell
cd backend
C:/Users/ASUS/AppData/Local/Programs/Python/Python313/python.exe -m pytest
```

Frontend production check:

```powershell
cd frontend
npm run build
```

The current automated tests cover health, mock transcription, upload validation, provider selection, and a complete mock voice turn. External provider calls are intentionally not made by the test suite.

## Fallback provider configuration

The turn-based fallback pipeline (STT -> LLM -> TTS) selects each provider from
server-only environment variables. All providers default to mock adapters, so
the app and the automated tests run without any credentials. Provider API keys
must never be placed in frontend code or committed to source control.

### Provider selection

| Stage | Variable | Values | Default | Model variable |
| ----- | -------- | ------ | ------- | -------------- |
| STT | `STT_PROVIDER` | `mock`, `openai`, `deepgram` | `mock` | `STT_MODEL` (OpenAI, default `whisper-1`), `DEEPGRAM_MODEL` (default `nova-2`) |
| LLM | `LLM_PROVIDER` | `mock`, `openai` | `mock` | `LLM_MODEL` (default `gpt-4o-mini`) |
| TTS | `TTS_PROVIDER` | `mock`, `elevenlabs`, `google` | `mock` | `ELEVENLABS_MODEL_ID` (default `eleven_multilingual_v2`) |

Credentials: `OPENAI_API_KEY` (OpenAI STT/LLM), `DEEPGRAM_API_KEY` (Deepgram STT),
`ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` (ElevenLabs TTS),
`GOOGLE_APPLICATION_CREDENTIALS` (Google TTS).

### Voice selection scope

The in-app voice dropdown applies to the **live OpenAI Realtime** conversation
only. It does not change the fallback text-to-speech voice. The fallback
ElevenLabs voice is configured server-side through the `ELEVENLABS_VOICE_ID`
environment variable (there is no frontend selector for the fallback voice).

The voice ID currently configured for local development/testing is
`JBFqnCBsd6RMkjVDRZzb`, which is ElevenLabs' public default voice **"George"**
from the shared Voice Library. A voice ID is not a secret or credential (unlike
`ELEVENLABS_API_KEY`); it only names a voice that must be available to the
configured account. Replace it with any voice ID from your account's Voice
Library as needed.

### ElevenLabs model selection (research + current decision)

The current default fallback TTS model is `eleven_multilingual_v2`
(`ELEVENLABS_MODEL_ID`). Newer and potentially lower-cost models were requested
for investigation. **No model change has been made** in this milestone; the
default is unchanged pending live verification. Findings from ElevenLabs'
official model documentation (links below):

| Model ID | Notes relevant to VoxFlow |
| -------- | ------------------------- |
| `eleven_multilingual_v2` (current) | Lifelike, rich emotion; 29 languages; supports the `speed` voice setting VoxFlow uses. |
| `eleven_flash_v2_5` | Ultra-low latency (~75 ms per docs); 32 languages; documented as **"50% lower price per character"** for API generations; v2-family voice settings, so VoxFlow's `speed` override is expected to keep working. Strongest cost-reduction candidate. |
| `eleven_v3` | More expressive; 70+ languages; 5,000-character limit; `speed` support is not guaranteed and must be verified. |
| `eleven_v4` / `eleven_v4_turbo` | Newest/most expressive. Per official docs, **Style and Speed sliders are not available in Eleven v4, and SSML is not supported** - switching would disable VoxFlow's speech-speed feature. |

Recommendation (not yet applied; requires approval + live verification):
`eleven_flash_v2_5` is the best cost/latency option that **preserves** the speed
feature; `eleven_v4`/`eleven_v3` are deferred because v4 removes speed/style and
v3's speed support is unconfirmed. The specific "~$0.04" target could not be
confirmed from public docs: ElevenLabs pricing is credit/plan-based and legacy
usage-based pricing has been replaced by plan-specific Pay As You Go, so verify
the exact per-character cost on the account before switching.

- ElevenLabs models: https://elevenlabs.io/docs/overview/models
- ElevenLabs pricing: https://elevenlabs.io/pricing

### Where to obtain model identifiers and voice IDs

- OpenAI models (LLM/STT): https://platform.openai.com/docs/models
- Deepgram models: https://developers.deepgram.com/docs/models-languages-overview
- ElevenLabs models: https://elevenlabs.io/docs/ ; voice IDs come from your
  ElevenLabs account Voice Library (the voice must be available to that account).
- Google TTS voices: https://cloud.google.com/text-to-speech/docs/voices

### Optional ElevenLabs voice settings

The default ElevenLabs model and request payload are unchanged. If you set any of
`ELEVENLABS_STABILITY`, `ELEVENLABS_SIMILARITY_BOOST`, `ELEVENLABS_STYLE`
(each `0.0`-`1.0`), `ELEVENLABS_USE_SPEAKER_BOOST` (`true`/`false`), or
`ELEVENLABS_SPEED` (documented range `0.7`-`1.2`, default `1.0`), a
`voice_settings` object containing only the configured fields is sent. When none
are set, no `voice_settings` object is sent. Parameter support (including `speed`)
depends on the selected model and account and **must be verified with live
credentials**.

### Optional speech speed (fallback TTS)

Speech speed is configurable for the fallback pipeline only (not live Realtime):

- **ElevenLabs:** `ELEVENLABS_SPEED` (documented range `0.7`-`1.2`). Sent as
  `voice_settings.speed`; model-specific support requires live verification.
- **Google:** `GOOGLE_SPEAKING_RATE` (documented range `0.25`-`4.0`). Sent as
  `AudioConfig.speaking_rate`.

Validation bounds follow each provider's published documentation. Leaving a value
blank sends no override, preserving the current default audio. The resulting
audio behavior has not been verified here and requires a live test with valid
credentials.

#### Per-agent fallback speed override

Each saved agent may carry an optional fallback speech-speed override that
applies to **fallback TTS only** (never live Realtime). The frontend reads the
active provider and its supported range from `GET /api/fallback/tts` and shows
the control only when the provider supports speed. The selected agent's speed is
sent with a fallback voice turn via the `/api/voice-turn` `speed` field and is
validated server-side against the active provider's documented range (HTTP 422
for out-of-range values, or when the active provider does not support speed).
When an agent has no override, the request omits `speed` and the environment
variable / provider default applies unchanged. The override affects only that
single request; it never mutates global configuration or other agents. Audible
effect still requires live credentials to verify.

### Estimated pricing

| Provider | What is priced | Where to verify (authoritative) |
| -------- | -------------- | ------------------------------- |
| OpenAI (LLM) | per input/output token | https://openai.com/api/pricing/ |
| OpenAI (STT, Whisper) | per minute of audio | https://openai.com/api/pricing/ |
| Deepgram (STT) | per minute of audio | https://deepgram.com/pricing |
| ElevenLabs (TTS) | per character / credits | https://elevenlabs.io/pricing |
| Google (TTS) | per character | https://cloud.google.com/text-to-speech/pricing |

Prices are not reproduced here because they change and are account-specific.
**Verify current pricing on each provider's official page before committing to a
model.** Deepgram STT and the optional ElevenLabs voice settings are implemented
but require live verification with valid credentials before they are considered
confirmed working.

These values must never be placed in frontend code or committed to source control.

## Session controls (per agent)

Each saved agent persists these controls (browser localStorage). Defaults
preserve the original behavior exactly, so an untouched agent behaves as before.

- **Output volume** (0-100%, default 100%): applies to **both** Live Realtime
  playback and the turn-based audio players. Changing it updates live playback
  and any mounted fallback players immediately.
- **Minimum response delay** (0-5000 ms, default 0, **turn-based/fallback
  only**): measured from end-of-utterance (EOU) to the assistant turn's audio.
  It only waits the *remaining* time; a response that is already later than the
  minimum appears immediately (no extra latency added), and a superseding turn
  cancels a pending wait. It is intentionally **not** applied to Live Realtime:
  the live WebRTC audio stream is unbuffered, so pausing it to add a delay would
  drop the start of the reply rather than delay it. The UI labels and disables
  the control accordingly.
- **Words before interruption** (0-100, default 0, **Live only**): how many
  assistant words must be spoken before the user may barge in. At 0 the
  assistant is always interruptible (original behavior) and the server performs
  the interruption; above 0 the client withholds barge-in until the threshold
  is met and manages interruption itself. A safety timeout forces the
  interruption only if the gate stays closed while the user **keeps** speaking,
  so a user can never be trapped; a brief sub-threshold utterance that stops is
  cleared and does not trigger a delayed interruption. The count comes from
  streamed transcript deltas, which can run **ahead** of the audio actually
  heard, so it is an approximation (whole words only). When the gate is enabled
  the server's auto-interrupt is disabled while `create_response` stays on; the
  client defensively finalizes a prior response if the server starts a new one
  while the old is still active. Whether overlapping server audio can occur in
  practice requires live verification.
- **Microphone processing** (`echoCancellation`, `noiseSuppression`,
  `autoGainControl`, all default on): passed into `getUserMedia`. Changes take
  effect on the **next** session/recording (no mid-session `applyConstraints`,
  whose support is inconsistent); the UI states this.
- **Background ambience** (office typing, **off by default, Live only**): mixes
  an optional looping ambience track into the **outgoing** microphone stream via
  the Web Audio API, so the assistant hears a realistic noisy environment. This
  is the opposite of noise suppression and unrelated to it. Enabling applies to
  the next session; the ambience gain (0-100%, default 30%) is live-adjustable.
  If the ambience asset cannot be loaded (fetch/decode failure or no Web Audio),
  the conversation falls back to the raw microphone automatically. All audio
  nodes and the audio context are disposed on disconnect. It is not applied to
  the turn-based fallback (injecting noise there would degrade transcription).
  See "Audio assets" for the asset and license.

### Audio assets

- **Background ambience:** "Keyboard Typing" by **imsogabriel_Stock** -
  https://pixabay.com/sound-effects/technology-keyboard-typing-120457/ ,
  bundled at `frontend/public/ambience/keyboard-typing.mp3` (MP3, ~1:23).
  **License: Pixabay Content License** (royalty-free; **no attribution
  required**; may not be resold/redistributed as a standalone file). Bundling it
  inside this application is permitted under that license.

- **Voice preview**: auditions the selected Live Realtime voice via a
  backend-only `POST /api/realtime/voice-preview` call to OpenAI's speech
  endpoint (`gpt-4o-mini-tts`), returning a short cached sample. The OpenAI key
  stays server-side. **It is user-initiated only and makes a small paid TTS
  call when invoked with live credentials.** Limitation: the newer Realtime
  voices `marin` and `cedar` may not be available on the speech endpoint; the
  backend validates the voice and fails cleanly (no wrong-voice audio) when a
  voice is unavailable. The other voices (alloy, ash, ballad, coral, echo,
  sage, shimmer, verse) are standard speech voices and preview faithfully.
  Previews are cached in-process per voice so each is synthesized at most once.

## Latency metrics and telemetry

Latency is reported differently for the two pipelines, because the Live Realtime
API does not expose per-stage timings:

- **Turn-based fallback (measured):** the backend records wall-clock durations
  around each provider call and returns them with every `/api/voice-turn`
  response as `timings` (`stt_ms`, `llm_ms`, `tts_ms`, `total_ms`). These are
  per-call wall-clock times (including network/transport), not pure provider
  compute time. The UI shows them beneath each turn.
- **Live Realtime (browser-observed proxies):** OpenAI Realtime streams audio
  over WebRTC and does not provide separable STT, LLM, or TTS timings. The
  frontend therefore measures proxies anchored to end-of-utterance (EOU):
  session setup time, EOU-to-first-transcript, EOU-to-first-audio, and total
  (speech-inclusive) response time, plus a p50 summary and a UI error count.
  These are client-side estimates, not server-reported stage latencies.

## Known limitations

- The voice pipeline is locally testable with mock adapters; real provider verification requires credentials.
- Provider quotas, model availability, and pricing are account-specific and can change.
- Real microphone recordings require a secure browser context such as `localhost` or HTTPS.
- The live conversation requires a browser with WebRTC, microphone support, and localhost or HTTPS.
- Live API behavior, model availability, quotas, and pricing require a configured OpenAI account and
  are not exercised by automated tests.
- The session controls are unit-tested locally for their pure logic (volume
  clamping/application, minimum-delay math, word-count gating, mic-constraint
  generation, preview request/caching). Their *audible/physical* effects
  (actual loudness, perceived delay, interruption feel, microphone DSP, and
  preview voice quality) require live verification with credentials and a real
  microphone/browser.
- Voice preview makes a small paid OpenAI TTS call only when a user clicks
  Preview with a configured key; it is never triggered automatically and makes
  no call in development or tests.
- The default Live Realtime voice is `marin` (`REALTIME_VOICE`); the dropdown
  options are the OpenAI Realtime GA voices. Background ambience (office typing)
  is implemented for Live mode only and is **off by default**; its audible mix
  and loop quality require live verification in a real browser.
- Deepgram STT (accent performance) and Google TTS (naturalness) remain
  implemented-but-unverified; no comparative quality or pricing claims are made
  here without live evidence.
- ElevenLabs authentication, quotas, voice access, and model availability must be verified with the assessment account.
