import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import {
  apiUrl,
  createAudioObjectUrl,
  processVoiceTurn,
  synthesizeResponse,
} from "./api/voiceApi";
import {
  clearSavedConversations,
  createConversationId,
  loadConversations,
  saveConversations,
  type ConversationTurn,
} from "./conversation";

async function checkBackend(): Promise<boolean> {
  const response = await fetch(apiUrl("/api/health"));
  if (!response.ok) throw new Error("Backend health check failed");
  return true;
}

function App() {
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [conversations, setConversations] = useState<ConversationTurn[]>(
    loadConversations,
  );
  const [error, setError] = useState("");
  const [playingTurnId, setPlayingTurnId] = useState("");
  const [retryingTurnId, setRetryingTurnId] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestInFlightRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const audioUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    checkBackend().then(() => setBackendOnline(true)).catch(() => setBackendOnline(false));
  }, []);

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => () => {
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const addAudio = (turnId: string, base64: string, contentType: string) => {
    const url = createAudioObjectUrl(base64, contentType);
    audioUrlsRef.current.push(url);
    setConversations((current) =>
      current.map((turn) =>
        turn.id === turnId
          ? { ...turn, audioUrl: url, ttsError: undefined }
          : turn,
      ),
    );
  };

  const startRecording = async () => {
    if (isStarting || isTranscribing || requestInFlightRef.current || recorderRef.current) return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser does not support microphone recording.");
      return;
    }

    let stream: MediaStream | undefined;
    try {
      setIsStarting(true);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const supportedMimeTypes = [
        "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus",
        "audio/ogg", "audio/mp4",
      ];
      const mimeType = supportedMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        stream?.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        setIsRecording(false);
        setError("Recording failed. Please try again.");
      };
      recorder.onstop = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        if (requestInFlightRef.current) return;
        requestInFlightRef.current = true;
        const requestGeneration = requestGenerationRef.current;
        setIsTranscribing(true);
        try {
          const actualMimeType =
            chunksRef.current.find((chunk) => chunk.type)?.type ||
            recorder.mimeType || mimeType || "audio/webm";
          const result = await processVoiceTurn(
            new Blob(chunksRef.current, { type: actualMimeType }),
          );
          if (requestGenerationRef.current !== requestGeneration) return;
          const turn: ConversationTurn = {
            id: createConversationId(),
            question: result.transcript,
            answer: result.response,
            createdAt: new Date().toISOString(),
            ttsError: result.tts_error || undefined,
          };
          if (result.audio_base64 && result.audio_content_type) {
            turn.audioUrl = createAudioObjectUrl(
              result.audio_base64,
              result.audio_content_type,
            );
            audioUrlsRef.current.push(turn.audioUrl);
          }
          setConversations((current) => [...current, turn]);
        } catch (voiceError) {
          if (requestGenerationRef.current === requestGeneration) {
            setError(voiceError instanceof Error ? voiceError.message : "Voice turn failed.");
          }
        } finally {
          requestInFlightRef.current = false;
          setIsTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (recordingError) {
      stream?.getTracks().forEach((track) => track.stop());
      setError(
        recordingError instanceof DOMException && recordingError.name === "NotAllowedError"
          ? "Microphone access was denied. Allow microphone access and try again."
          : "Could not start recording. Check your microphone and try again.",
      );
    } finally {
      setIsStarting(false);
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    setIsRecording(false);
  };

  const retryAudio = async (turn: ConversationTurn) => {
    if (retryingTurnId) return;
    setRetryingTurnId(turn.id);
    setConversations((current) =>
      current.map((item) => item.id === turn.id ? { ...item, ttsError: undefined } : item),
    );
    try {
      const result = await synthesizeResponse(turn.answer);
      addAudio(turn.id, result.audio_base64, result.audio_content_type);
    } catch (synthesisError) {
      setConversations((current) =>
        current.map((item) =>
          item.id === turn.id
            ? { ...item, ttsError: synthesisError instanceof Error ? synthesisError.message : "Speech synthesis failed." }
            : item,
        ),
      );
    } finally {
      setRetryingTurnId("");
    }
  };

  const clearHistory = () => {
    if (!window.confirm("Clear all conversation history?")) return;
    requestGenerationRef.current += 1;
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlsRef.current = [];
    setConversations([]);
    setError("");
    setPlayingTurnId("");
    clearSavedConversations();
  };

  const isProcessing = isStarting || isTranscribing;
  const pipelineStatus = backendOnline === null ? "Connecting"
    : !backendOnline ? "Unavailable"
    : error ? "Failed"
    : isRecording ? "Listening"
    : isProcessing ? "Processing"
    : conversations.length ? "Completed" : "Ready";
  const statusHeading = error ? "Something went wrong"
    : isRecording ? "Listening..."
    : isProcessing ? "Processing your question..."
    : playingTurnId ? "Speaking..."
    : conversations.length ? "Response ready" : "Ready to listen";
  const statusDescription = error ? "Check the message below and try again"
    : isRecording ? "Speak your question, then stop recording"
    : isProcessing ? "Transcribing, thinking, and preparing audio"
    : playingTurnId ? "Your answer is playing"
    : conversations.length ? "Review your conversation or ask another question"
    : "Click the microphone to start a conversation";

  return (
    <main className="app-shell">
      <section className="voice-app" aria-labelledby="app-title">
        <header className="brand">
          <div className="waveform" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
          <h1 id="app-title">VoxFlow</h1>
          <p>A Voice AI pipeline</p>
          <div className="history-summary">
            <span>{conversations.length} {conversations.length === 1 ? "conversation" : "conversations"}</span>
            {conversations.length > 0 && (
              <button className="clear-button" type="button" onClick={clearHistory}>Clear history</button>
            )}
          </div>
        </header>

        <section className="interaction" aria-labelledby="status-heading">
          <button className={`record-button ${isRecording ? "recording" : ""}`} type="button"
            onClick={isRecording ? stopRecording : startRecording} disabled={isProcessing}
            aria-label={isRecording ? "Stop recording" : "Start recording"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>
          </button>
          <h2 id="status-heading" className="status-heading" role="status">{statusHeading}</h2>
          <p className="status-description">{statusDescription}</p>
          {!backendOnline && backendOnline !== null && <p className="error-message backend-error" role="alert">Backend unavailable. Start the API and try again.</p>}
          {isProcessing && conversations.length > 0 && <p className="processing-note" role="status">Your previous answers remain available while this turn is processing.</p>}

          <div className="conversation-list" aria-live="polite">
            {conversations.map((turn, index) => (
              <article className="conversation-card" key={turn.id}>
                <div className="turn-label">YOU ASKED · {index + 1}</div>
                <p className="question-text">{turn.question}</p>
                <div className="turn-label assistant-label">ASSISTANT</div>
                <div className="answer-text">
                  <ReactMarkdown>{turn.answer}</ReactMarkdown>
                </div>
                {turn.audioUrl ? (
                  <audio
                    className="audio-player" controls src={turn.audioUrl}
                    onPlay={() => setPlayingTurnId(turn.id)}
                    onPause={() => setPlayingTurnId((current) => current === turn.id ? "" : current)}
                    onEnded={() => setPlayingTurnId((current) => current === turn.id ? "" : current)}
                  />
                ) : turn.ttsError ? (
                  <div className="tts-retry">
                    <p className="error-message" role="alert">{turn.ttsError}</p>
                    <button className="retry-button" type="button" disabled={retryingTurnId === turn.id}
                      onClick={() => retryAudio(turn)}>
                      {retryingTurnId === turn.id ? "Retrying audio..." : "Retry audio"}
                    </button>
                  </div>
                ) : (
                  <div className="restored-audio">
                    <span>Audio is unavailable after reload.</span>
                    <button className="retry-button" type="button" disabled={retryingTurnId === turn.id}
                      onClick={() => retryAudio(turn)}>
                      {retryingTurnId === turn.id ? "Generating..." : "Generate audio"}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>

        <section className="feature-grid" aria-label="Voice pipeline stages">
          <article className="feature-card">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>
            <h3>Speech-to-Text</h3><p>Capture and transcribe speech</p>
          </article>
          <article className="feature-card">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 9.8 8.2 5 10l4.8 1.8L12 17l2.2-5.2L19 10l-4.8-1.8L12 3Z" /><path d="m19 15-.8 2.2L16 18l2.2.8L19 21l.8-2.2L22 18l-2.2-.8L19 15Z" /></svg>
            <h3>LLM</h3><p>Generate the response</p>
          </article>
          <article className="feature-card">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4h3l4 3V7l-4 3H5Z" /><path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10" /></svg>
            <h3>Text-to-Speech</h3><p>Produce spoken audio</p>
          </article>
          <article className="feature-card">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>
            <h3>Pipeline status</h3><p>Show progress and errors</p><span className="card-status">{pipelineStatus}</span>
          </article>
        </section>
      </section>
    </main>
  );
}

export default App;
