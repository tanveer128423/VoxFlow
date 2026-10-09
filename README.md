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

Milestones 1-5 are implemented with mock-by-default adapters: the backend health check, browser recording, transcription, language-model response, text-to-speech output, and browser audio controls. The real provider paths are implemented but are not claimed as verified until credentials are configured and tested.

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
Set `STT_PROVIDER=groq`, `LLM_PROVIDER=gemini`, and `TTS_PROVIDER=elevenlabs` when testing the
real fallback integrations. Google TTS remains available with `TTS_PROVIDER=google`.

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

## Planned provider configuration

The backend will use server-only environment variables for provider credentials:

- `GROQ_API_KEY` for speech-to-text
- `GEMINI_API_KEY` for the language model
- Google Cloud credentials for text-to-speech
- `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, and `ELEVENLABS_MODEL_ID` for ElevenLabs text-to-speech

These values must never be placed in frontend code or committed to source control.

## Known limitations

- The voice pipeline is locally testable with mock adapters; real provider verification requires credentials.
- Provider quotas, model availability, and pricing are account-specific and can change.
- Real microphone recordings require a secure browser context such as `localhost` or HTTPS.
- The live conversation requires a browser with WebRTC, microphone support, and localhost or HTTPS.
- Live API behavior, model availability, quotas, and pricing require a configured OpenAI account and
  are not exercised by automated tests.
- ElevenLabs authentication, quotas, voice access, and model availability must be verified with the assessment account.
