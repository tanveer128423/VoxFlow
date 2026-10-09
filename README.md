# LitLabs Voice Assistant

A browser voice assistant built as a deliberately separate pipeline:

```text
Browser microphone -> STT -> LLM -> TTS -> Browser playback
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

## Current status

Milestones 1-5 are implemented with mock-by-default adapters: the backend health check, browser recording, transcription, language-model response, text-to-speech output, and browser audio controls. The real provider paths are implemented but are not claimed as verified until credentials are configured and tested.

With the backend running, use the **Start recording** button in a browser. Allow microphone access, speak, select **Stop recording**, and the mock transcript, mock assistant response, and audio controls should appear. Set `STT_PROVIDER=groq`, `LLM_PROVIDER=gemini`, and `TTS_PROVIDER=elevenlabs` when testing the real integrations. Google TTS remains available with `TTS_PROVIDER=google`.

For ElevenLabs, configure these values in `backend/.env`:

```env
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Put the supplied key only in the local `ELEVENLABS_API_KEY` value. Do not put it in frontend files, source control, logs, or screenshots. The voice ID must be a voice available to the ElevenLabs account.

If a voice turn returns text but no audio, the **Retry audio** action calls `/api/synthesize` with the existing assistant response. It does not repeat transcription or language-model generation.

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

The simulation runs only after the mock or configured STT and LLM stages have completed. It returns the transcript and assistant response with a TTS error and no audio, allowing the frontend recovery UI to be verified. Clicking **Retry audio** calls only `POST /api/synthesize`; it does not rerun STT or the LLM.
The second flag is required to use deterministic mock audio for the retry. Leave it
`false` to have the retry use the configured TTS provider.

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
- The initial implementation uses one sequential request for a complete voice turn; streaming is intentionally out of scope.
- ElevenLabs authentication, quotas, voice access, and model availability must be verified with the assessment account.
