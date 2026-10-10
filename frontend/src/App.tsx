import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import {
  apiUrl,
  createAudioObjectUrl,
  processVoiceTurn,
} from "./api/voiceApi";
import { RealtimeConversation, type RealtimeState } from "./realtime";
import {
  clearSavedConversations,
  createConversationId,
  loadConversations,
  saveConversations,
  type ConversationTurn,
} from "./conversation";
import { FrontendTelemetry, p50, type TelemetrySnapshot } from "./telemetry";

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
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("ended");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const telemetryRef = useRef(new FrontendTelemetry());
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(
    telemetryRef.current.getSnapshot(),
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const realtimeRef = useRef<RealtimeConversation | null>(null);
  const liveQuestionRef = useRef("");
  const liveAnswerRef = useRef("");
  const chunksRef = useRef<Blob[]>([]);
  const requestInFlightRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const audioUrlsRef = useRef<string[]>([]);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const scrollBehaviorRef = useRef<ScrollBehavior>("smooth");
  const programmaticScrollRef = useRef(false);
  const scrollUnlockTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    checkBackend().then(() => setBackendOnline(true)).catch(() => setBackendOnline(false));
  }, []);

  useEffect(() => telemetryRef.current.subscribe(() => {
    setTelemetry(telemetryRef.current.getSnapshot());
  }), []);

  useEffect(() => {
    if (error) telemetryRef.current.recordError();
  }, [error]);

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    if (!shouldAutoScroll) return;
    const scrollToLatest = () => {
      const container = conversationRef.current;
      if (!container) return;
      programmaticScrollRef.current = true;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: scrollBehaviorRef.current,
      });
      conversationEndRef.current?.scrollIntoView({
        block: "end",
        behavior: scrollBehaviorRef.current,
      });
      scrollBehaviorRef.current = "auto";
      if (scrollUnlockTimeoutRef.current !== null) {
        window.clearTimeout(scrollUnlockTimeoutRef.current);
      }
      scrollUnlockTimeoutRef.current = window.setTimeout(() => {
        programmaticScrollRef.current = false;
        scrollUnlockTimeoutRef.current = null;
      }, 450);
    };
    const frameId = requestAnimationFrame(scrollToLatest);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        if (shouldAutoScroll) requestAnimationFrame(scrollToLatest);
      });
    if (resizeObserver && conversationRef.current) {
      resizeObserver.observe(conversationRef.current);
    }
    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      if (scrollUnlockTimeoutRef.current !== null) {
        window.clearTimeout(scrollUnlockTimeoutRef.current);
        scrollUnlockTimeoutRef.current = null;
      }
      programmaticScrollRef.current = false;
    };
  }, [conversations, liveTranscript, realtimeState, shouldAutoScroll]);

  useEffect(() => () => {
    realtimeRef.current?.close();
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const startRecording = async () => {
    if (isStarting || isTranscribing || requestInFlightRef.current || recorderRef.current) return;
    setError("");
    setAudioPlaybackBlocked(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser does not support microphone recording.");
      return;
    }

    let stream: MediaStream | undefined;
    try {
      setIsStarting(true);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
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
  void startRecording;

  const startRealtimeConversation = async () => {
    if (realtimeRef.current || isStarting || isRecording || isTranscribing) return;
    setError("");
    setAudioPlaybackBlocked(false);
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setError("Realtime microphone access requires HTTPS or localhost.");
      return;
    }
    const commitLiveTurn = (status: "complete" | "interrupted") => {
      const question = liveQuestionRef.current.trim();
      const answer = liveAnswerRef.current.trim();
      if (question || answer) {
        setConversations((current) => [
          ...current,
          {
            id: createConversationId(),
            question,
            answer,
            createdAt: new Date().toISOString(),
            status,
          },
        ]);
      }
      liveQuestionRef.current = "";
      liveAnswerRef.current = "";
      setLiveTranscript("");
    };

    const conversation = new RealtimeConversation({
      onState: (state) => {
        setRealtimeState(state);
        if (state === "ended") realtimeRef.current = null;
      },
      onUserTranscript: (transcript) => {
        const isNewQuestion = !liveQuestionRef.current.trim();
        scrollBehaviorRef.current = isNewQuestion ? "smooth" : "auto";
        setShouldAutoScroll(true);
        liveQuestionRef.current = transcript;
        setLiveTranscript(transcript);
      },
      onUserSpeechStarted: (interruptingResponse, responseId) => {
        if (interruptingResponse && responseId) {
          telemetryRef.current.finishTurn(responseId, "interrupted");
        }
        telemetryRef.current.startTurn(interruptingResponse);
      },
      onUserSpeechStopped: () => {
        telemetryRef.current.markUserSpeechStopped();
      },
      onAssistantResponseStarted: (responseId) => {
      telemetryRef.current.beginResponse(responseId);
      },
      onAssistantTranscript: (responseId, transcript) => {
        telemetryRef.current.markAssistantTranscript(responseId);
        scrollBehaviorRef.current = liveAnswerRef.current ? "auto" : "smooth";
        liveAnswerRef.current += transcript;
        setLiveTranscript(liveAnswerRef.current);
      },
      onTurnComplete: (responseId) => {
        scrollBehaviorRef.current = "smooth";
        telemetryRef.current.finishTurn(responseId, "complete");
        commitLiveTurn("complete");
      },
      onTurnInterrupted: (responseId) => {
        scrollBehaviorRef.current = "smooth";
        telemetryRef.current.finishTurn(responseId, "interrupted");
        commitLiveTurn("interrupted");
      },
      onAssistantAudioStarted: (responseId) => {
        telemetryRef.current.markAssistantAudio(responseId);
      },
      onSessionReady: () => telemetryRef.current.completeSessionSetup(),
      onError: (realtimeError) => setError(realtimeError.message),
      onAudioPlaybackError: () => setAudioPlaybackBlocked(true),
    });
    realtimeRef.current = conversation;
    liveQuestionRef.current = "";
    liveAnswerRef.current = "";
    setLiveTranscript("");
    telemetryRef.current.startSessionSetup();
    try {
      await conversation.connect();
    } catch (realtimeError) {
      realtimeRef.current = null;
      setError(
        realtimeError instanceof Error
          ? realtimeError.message
          : "Could not start the realtime conversation.",
      );
    }
  };

  const enableAudio = async () => {
    try {
      await realtimeRef.current?.enableAudio();
      setAudioPlaybackBlocked(false);
    } catch {
      setError("Audio is still blocked. Check the browser's site sound permission and try again.");
    }
  };

  const endRealtimeConversation = () => {
    realtimeRef.current?.close();
    realtimeRef.current = null;
    liveQuestionRef.current = "";
    liveAnswerRef.current = "";
    setLiveTranscript("");
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    setIsRecording(false);
  };

  const clearHistory = () => {
    if (!window.confirm("Clear all conversation history?")) return;
    requestGenerationRef.current += 1;
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlsRef.current = [];
    setConversations([]);
    setError("");
    setPlayingTurnId("");
    setShouldAutoScroll(true);
    clearSavedConversations();
  };

  const completedTurns = telemetry.turns.filter((turn) => turn.status === "complete");
  const p50TotalResponse = p50(
    completedTurns.flatMap((turn) => turn.totalResponseMs === undefined ? [] : [turn.totalResponseMs]),
  );
  const formatMs = (value: number | undefined) => value === undefined ? "—" : `${Math.round(value)} ms`;

  const handleConversationScroll = () => {
    if (programmaticScrollRef.current) return;
    const container = conversationRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const isAtLatest = distanceFromBottom < 72;
    setShouldAutoScroll((current) => current === isAtLatest ? current : isAtLatest);
  };

  const jumpToLatest = () => {
    setShouldAutoScroll(true);
    conversationRef.current?.scrollTo({
      top: conversationRef.current.scrollHeight,
      behavior: "smooth",
    });
  };

  const isLiveConversation = realtimeState !== "ended";
  const isProcessing = isStarting || isTranscribing;
  const pipelineStatus = backendOnline === null ? "Connecting"
    : !backendOnline ? "Unavailable"
    : error ? "Failed"
    : isLiveConversation ? realtimeState === "responding" ? "Responding" : "Listening"
    : isRecording ? "Listening"
    : isProcessing ? "Processing"
    : conversations.length ? "Completed" : "Ready";
  const statusHeading = error ? "Something went wrong"
    : isLiveConversation
      ? realtimeState === "responding" ? "Responding..." : "Listening..."
    : isRecording ? "Listening..."
    : isProcessing ? "Processing your question..."
    : playingTurnId ? "Speaking..."
    : conversations.length ? "Response ready" : "Ready to listen";
  const statusDescription = error ? "Check the message below and try again"
    : isLiveConversation
      ? realtimeState === "responding"
        ? "You can interrupt the assistant at any time"
        : "Speak naturally; silence detects the end of your turn"
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
            <span className="connection-status">{pipelineStatus}</span>
            {conversations.length > 0 && (
              <button className="clear-button" type="button" onClick={clearHistory}>Clear history</button>
            )}
          </div>
        </header>

        <div className="main-layout">
          <aside className="telemetry-panel" aria-label="Frontend performance">
            <div className="telemetry-heading">
              <strong>Performance</strong>
              <span>browser-observed · this session</span>
            </div>
            <div className="telemetry-summary">
              <span><b>p50 total response</b>{formatMs(p50TotalResponse)}<small>last 5 complete turns · speech start to response done</small></span>
              <span><b>session setup</b>{formatMs(telemetry.sessionSetupMs)}<small>connect start to configured data channel ready</small></span>
              <span><b>errors</b>{telemetry.errorCount}<small>UI/runtime errors</small></span>
            </div>
            {telemetry.turns.length > 0 && (
              <div className="telemetry-turns">
                {telemetry.turns.slice().reverse().map((turn) => (
                  <div key={turn.id}>
                    <span>{turn.status === "complete" ? "Complete" : "Interrupted"}</span>
                    <span>transcript latency {formatMs(turn.firstAssistantTranscriptMs)}</span>
                    <span>audio latency {formatMs(turn.firstAssistantAudioMs)}</span>
                    <span>total response {formatMs(turn.totalResponseMs)}</span>
                  </div>
                ))}
              </div>
            )}
          </aside>

          <div className="conversation-column">
            <section className="conversation-stage" aria-label="Conversation">
          <div
            className="conversation-list"
            ref={conversationRef}
            onScroll={handleConversationScroll}
            aria-live="polite"
          >
            {conversations.length === 0 && !liveTranscript && (
              <div className="empty-conversation">
                <div className="empty-orb" aria-hidden="true"><span /><span /><span /></div>
                <p>Ask anything and start a natural voice conversation.</p>
              </div>
            )}
            {conversations.map((turn) => (
              <div className="timeline-turn" key={turn.id}>
                {turn.question && (
                  <article className="chat-message user-message">
                    <div className="message-meta">YOU</div>
                    <p>{turn.question}</p>
                  </article>
                )}
                {turn.answer && (
                  <article className={`chat-message assistant-message ${turn.status === "interrupted" ? "interrupted-message" : ""}`}>
                    <div className="assistant-heading">
                      <div className="assistant-mark" aria-hidden="true"><span /><span /><span /></div>
                      <div className="message-meta">VOXFLOW</div>
                      {turn.status === "interrupted" && <span className="message-state">Interrupted</span>}
                    </div>
                    <div className="answer-text"><ReactMarkdown>{turn.answer}</ReactMarkdown></div>
                    {turn.audioUrl ? (
                      <audio
                        className="audio-player" controls src={turn.audioUrl}
                        onPlay={() => setPlayingTurnId(turn.id)}
                        onPause={() => setPlayingTurnId((current) => current === turn.id ? "" : current)}
                        onEnded={() => setPlayingTurnId((current) => current === turn.id ? "" : current)}
                      />
                    ) : turn.ttsError ? (
                      <p className="error-message" role="alert">{turn.ttsError}</p>
                    ) : null}
                  </article>
                )}
              </div>
            ))}
            {isLiveConversation && liveQuestionRef.current && (
              <article className="chat-message user-message live-message">
                <div className="message-meta">YOU</div>
                <p>{liveQuestionRef.current}</p>
              </article>
            )}
            {isLiveConversation && liveAnswerRef.current && (
              <article className="chat-message assistant-message live-message">
                <div className="assistant-heading">
                  <div className="assistant-mark" aria-hidden="true"><span /><span /><span /></div>
                  <div className="message-meta">VOXFLOW</div>
                  <span className="message-state">{realtimeState === "responding" ? "Speaking" : "Thinking"}</span>
                </div>
                <div className="answer-text"><ReactMarkdown>{liveAnswerRef.current}</ReactMarkdown></div>
              </article>
            )}
            <div ref={conversationEndRef} aria-hidden="true" />
          </div>
          {!shouldAutoScroll && (
            <button className="latest-button" type="button" onClick={jumpToLatest}>
              ↓ Newest message
            </button>
          )}
            </section>

            <section className="interaction" aria-labelledby="status-heading">
          <div className={`state-wave ${isLiveConversation ? "active" : ""} ${realtimeState === "responding" ? "speaking" : ""}`} aria-hidden="true">
            <span /><span /><span /><span /><span />
          </div>
          <h2 id="status-heading" className="status-heading" role="status">{statusHeading}</h2>
          <p className="status-description">{statusDescription}</p>
          <div className="voice-controls">
            <button className={`record-button ${isLiveConversation ? "recording" : ""}`} type="button"
              onClick={isLiveConversation ? endRealtimeConversation : startRealtimeConversation}
              disabled={isProcessing || isRecording}
              aria-label={isLiveConversation ? "End live conversation" : error ? "Retry live conversation" : "Start live conversation"}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>
            </button>
            {isLiveConversation && (
              <button className="end-session-button" type="button" onClick={endRealtimeConversation}>
                End conversation
              </button>
            )}
            {isRecording && (
              <button className="fallback-button" type="button" onClick={stopRecording} disabled={isProcessing}>
                Stop recording
              </button>
            )}
          </div>
          {!backendOnline && backendOnline !== null && <p className="error-message backend-error" role="alert">Backend unavailable. Start the API and try again.</p>}
          {error && <p className="error-message" role="alert">{error}</p>}
          {audioPlaybackBlocked && isLiveConversation && (
            <button className="enable-audio-button" type="button" onClick={() => void enableAudio()}>
              Enable audio
            </button>
          )}
            </section>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
