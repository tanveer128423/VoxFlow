import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import {
  apiUrl,
  createAudioObjectUrl,
  fetchFallbackTtsInfo,
  fetchRealtimeVoiceOptions,
  fetchVoicePreview,
  processVoiceTurn,
  type RealtimeTurnDetection,
} from "./api/voiceApi";
import {
  AMBIENCE_VOLUME_BOUNDS,
  INTERRUPT_MIN_WORDS_BOUNDS,
  MIN_RESPONSE_DELAY_BOUNDS,
  VOLUME_BOUNDS,
  applyVolume,
  buildAudioConstraints,
  clampAmbienceVolume,
  clampInterruptMinWords,
  clampMinResponseDelayMs,
  clampVolume,
  computePlaybackDelayMs,
  type MicProcessing,
} from "./audioConfig";
import {
  clampFallbackSpeed,
  parseFallbackTtsInfo,
  type FallbackTtsInfo,
} from "./fallbackConfig";
import {
  VAD_BOUNDS,
  buildRealtimeConfig,
  clampTurnDetection,
  parseVoiceOptions,
  type RealtimeVoiceOptions,
} from "./realtimeConfig";
import { RealtimeConversation, type RealtimeState } from "./realtime";
import {
  clearSavedConversations,
  createConversationId,
  loadConversations,
  saveConversations,
  type ConversationTurn,
} from "./conversation";
import {
  FrontendTelemetry,
  summarizeTurns,
  type TelemetrySnapshot,
} from "./telemetry";
import {
  createVariableId,
  findVariableNameIssues,
  renderPrompt,
  validatePromptConfig,
  type PromptValidation,
} from "./prompt";
import {
  addAgent,
  createAgent,
  deleteAgent,
  duplicateAgent,
  ensureAgents,
  getAgentById,
  loadAgents,
  loadSelectedAgentId,
  normalizeAgentName,
  renameAgent,
  resolveSelectedAgentId,
  saveAgents,
  saveSelectedAgentId,
  updateAgentConfig,
  updateAgentDescription,
  type Agent,
  type AgentConfig,
} from "./agents";

const MIC_PROCESSING_LABELS: Record<keyof MicProcessing, string> = {
  echoCancellation: "Echo cancellation",
  noiseSuppression: "Noise suppression",
  autoGainControl: "Auto gain control",
};
const MIC_PROCESSING_FIELDS: (keyof MicProcessing)[] = [
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
];

// Turn-based (fallback) mode is hidden from the default UI; Live is the only
// visible conversation mode. The backend pipeline, provider adapters, and all
// assessment features remain intact and are re-exposed by setting
// VITE_ENABLE_TURN_BASED="true". Defaults to disabled when unset.
const TURN_BASED_ENABLED =
  import.meta.env.VITE_ENABLE_TURN_BASED === "true";

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
  // Mobile-only collapse for the Performance panel (expanded by default). Has no
  // effect on desktop: the collapse styling lives only in the mobile media query.
  const [telemetryOpen, setTelemetryOpen] = useState(true);
  const [playingTurnId, setPlayingTurnId] = useState("");
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("ended");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [promptConfigOpen, setPromptConfigOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>(() => ensureAgents(loadAgents()));
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const instructionsRef = useRef("");
  const promptValidationRef = useRef<PromptValidation>({
    canStart: true,
    errors: [],
  });
  const [voiceOptions, setVoiceOptions] = useState<RealtimeVoiceOptions | null>(
    null,
  );
  const [voiceOptionsError, setVoiceOptionsError] = useState("");
  const [fallbackTtsInfo, setFallbackTtsInfo] = useState<FallbackTtsInfo | null>(
    null,
  );
  const fallbackSpeedRef = useRef<number | null>(null);
  const volumeRef = useRef<number>(1);
  const minDelayRef = useRef<number>(0);
  const interruptWordsRef = useRef<number>(0);
  const micProcessingRef = useRef<MicProcessing>({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  const ambienceEnabledRef = useRef<boolean>(false);
  const ambienceVolumeRef = useRef<number>(0.3);
  const fallbackAudioElsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const [voicePreviewState, setVoicePreviewState] = useState<
    { status: "idle" | "loading" | "error"; message?: string }
  >({ status: "idle" });
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
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

  // Keep a valid agent selected (on mount and after deletions).
  useEffect(() => {
    setSelectedAgentId((current) =>
      resolveSelectedAgentId(agents, current || loadSelectedAgentId()),
    );
  }, [agents]);

  // Debounced persistence of the full agent list (no per-agent race).
  useEffect(() => {
    const handle = window.setTimeout(() => saveAgents(agents), 300);
    return () => window.clearTimeout(handle);
  }, [agents]);

  useEffect(() => {
    let cancelled = false;
    fetchRealtimeVoiceOptions()
      .then((payload) => {
        if (cancelled) return;
        const options = parseVoiceOptions(payload);
        setVoiceOptions(options);
        setVoiceOptionsError("");
      })
      .catch((optionsError) => {
        if (cancelled) return;
        setVoiceOptions(null);
        setVoiceOptionsError(
          optionsError instanceof Error
            ? optionsError.message
            : "Could not load the available voices.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchFallbackTtsInfo()
      .then((payload) => {
        if (cancelled) return;
        setFallbackTtsInfo(parseFallbackTtsInfo(payload));
      })
      .catch(() => {
        // Endpoint failure must not break voice sessions; simply hide the
        // control (speed customization is treated as unavailable).
        if (!cancelled) setFallbackTtsInfo(null);
      });
    return () => {
      cancelled = true;
    };
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
    if (!promptValidationRef.current.canStart) {
      setError(promptValidationRef.current.errors[0]);
      return;
    }
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
        audio: buildAudioConstraints(micProcessingRef.current),
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
        const eouAt = performance.now();
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
            instructionsRef.current || undefined,
            fallbackSpeedRef.current ?? undefined,
          );
          if (requestGenerationRef.current !== requestGeneration) return;
          // Minimum response delay (EOU -> first assistant audio). Only waits
          // the remaining time; network latency usually already exceeds it.
          const delay = computePlaybackDelayMs(
            eouAt,
            performance.now(),
            minDelayRef.current,
          );
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
            if (requestGenerationRef.current !== requestGeneration) return;
          }
          const turn: ConversationTurn = {
            id: createConversationId(),
            question: result.transcript,
            answer: result.response,
            createdAt: new Date().toISOString(),
            ttsError: result.tts_error || undefined,
            timings: result.timings || undefined,
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

  const startRealtimeConversation = async () => {
    if (realtimeRef.current || isStarting || isRecording || isTranscribing) return;
    if (!promptValidationRef.current.canStart) {
      setError(promptValidationRef.current.errors[0]);
      return;
    }
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
    const sessionConfig = buildRealtimeConfig({
      instructions: instructionsRef.current,
      voice: selectedVoice || undefined,
      turnDetection: turnDetection ?? undefined,
      options: voiceOptions ?? undefined,
    });
    try {
      await conversation.connect(sessionConfig, {
        volume: volumeRef.current,
        micProcessing: micProcessingRef.current,
        interruptMinWords: interruptWordsRef.current,
        ambienceEnabled: ambienceEnabledRef.current,
        ambienceVolume: ambienceVolumeRef.current,
      });
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
    fallbackAudioElsRef.current.clear();
    setConversations([]);
    setError("");
    setPlayingTurnId("");
    setShouldAutoScroll(true);
    clearSavedConversations();
  };

  // The selected agent is the single source of truth for prompt/voice/VAD.
  const effectiveAgentId = selectedAgentId || agents[0]?.id || "";
  const selectedAgent = getAgentById(agents, effectiveAgentId) ?? agents[0];
  const promptTemplate = selectedAgent.config.promptTemplate;
  const promptVariables = selectedAgent.config.promptVariables;
  const selectedVoice =
    selectedAgent.config.voice ?? voiceOptions?.defaultVoice ?? "";
  const turnDetection =
    selectedAgent.config.turnDetection ??
    voiceOptions?.defaultTurnDetection ??
    null;

  const renderedPrompt = renderPrompt(promptTemplate, promptVariables);
  instructionsRef.current = renderedPrompt.text.trim();
  // Capture the selected agent's fallback speed for the next turn (same point
  // and semantics as instructions). Only sent when the provider supports it.
  const fallbackSpeed = selectedAgent.config.fallbackSpeed;
  fallbackSpeedRef.current =
    fallbackTtsInfo?.speedSupported && typeof fallbackSpeed === "number"
      ? fallbackSpeed
      : null;
  const volume = selectedAgent.config.volume;
  volumeRef.current = volume;
  const minResponseDelayMs = selectedAgent.config.minResponseDelayMs;
  minDelayRef.current = minResponseDelayMs;
  const interruptMinWords = selectedAgent.config.interruptMinWords;
  interruptWordsRef.current = interruptMinWords;
  const micProcessing = selectedAgent.config.micProcessing;
  micProcessingRef.current = micProcessing;
  const ambienceEnabled = selectedAgent.config.ambienceEnabled;
  ambienceEnabledRef.current = ambienceEnabled;
  const ambienceVolume = selectedAgent.config.ambienceVolume;
  ambienceVolumeRef.current = ambienceVolume;
  const promptValidation = validatePromptConfig(promptTemplate, promptVariables);
  promptValidationRef.current = promptValidation;
  const variableIssues = findVariableNameIssues(promptVariables);
  const promptEditingDisabled =
    realtimeState !== "ended" || isRecording || isStarting || isTranscribing;

  // Mutate the selected agent's config in place (immutably). Reading the config
  // inside the updater avoids stale closures and per-agent write races.
  const applyConfig = (mutate: (config: AgentConfig) => AgentConfig) =>
    setAgents((current) => {
      const agent = current.find((item) => item.id === effectiveAgentId);
      if (!agent) return current;
      return updateAgentConfig(current, effectiveAgentId, mutate(agent.config));
    });

  const setPromptTemplate = (value: string) =>
    applyConfig((config) => ({ ...config, promptTemplate: value }));
  const setSelectedVoice = (value: string) =>
    applyConfig((config) => ({ ...config, voice: value }));
  const addPromptVariable = () =>
    applyConfig((config) => ({
      ...config,
      promptVariables: [
        ...config.promptVariables,
        { id: createVariableId(), name: "", value: "" },
      ],
    }));
  const updatePromptVariable = (
    id: string,
    field: "name" | "value",
    value: string,
  ) =>
    applyConfig((config) => ({
      ...config,
      promptVariables: config.promptVariables.map((variable) =>
        variable.id === id ? { ...variable, [field]: value } : variable,
      ),
    }));
  const removePromptVariable = (id: string) =>
    applyConfig((config) => ({
      ...config,
      promptVariables: config.promptVariables.filter(
        (variable) => variable.id !== id,
      ),
    }));
  const setFallbackSpeed = (value: number | null) =>
    applyConfig((config) => ({ ...config, fallbackSpeed: value }));
  const setVolume = (value: number) => {
    const clamped = clampVolume(value);
    applyConfig((config) => ({ ...config, volume: clamped }));
    // Apply immediately to live playback and any mounted fallback players so
    // the change affects real playback configuration, not just UI state.
    realtimeRef.current?.setVolume(clamped);
    fallbackAudioElsRef.current.forEach((element) => {
      if (element.isConnected) applyVolume(element, clamped);
    });
  };
  const setMinResponseDelayMs = (value: number) =>
    applyConfig((config) => ({
      ...config,
      minResponseDelayMs: clampMinResponseDelayMs(value),
    }));
  const setInterruptMinWords = (value: number) =>
    applyConfig((config) => ({
      ...config,
      interruptMinWords: clampInterruptMinWords(value),
    }));
  const setMicProcessingFlag = (field: keyof MicProcessing, value: boolean) =>
    applyConfig((config) => ({
      ...config,
      micProcessing: { ...config.micProcessing, [field]: value },
    }));
  const setAmbienceEnabled = (value: boolean) =>
    applyConfig((config) => ({ ...config, ambienceEnabled: value }));
  const setAmbienceVolume = (value: number) => {
    const clamped = clampAmbienceVolume(value);
    applyConfig((config) => ({ ...config, ambienceVolume: clamped }));
    // Ambience gain is live-adjustable during an active session.
    realtimeRef.current?.setAmbienceVolume(clamped);
  };
  const previewSelectedVoice = async () => {
    if (!selectedVoice) return;
    setVoicePreviewState({ status: "loading" });
    try {
      const result = await fetchVoicePreview(selectedVoice);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = createAudioObjectUrl(
        result.audio_base64,
        result.audio_content_type,
      );
      previewUrlRef.current = url;
      if (!previewAudioRef.current) previewAudioRef.current = new Audio();
      previewAudioRef.current.src = url;
      applyVolume(previewAudioRef.current, volumeRef.current);
      await previewAudioRef.current.play();
      setVoicePreviewState({ status: "idle" });
    } catch (previewError) {
      setVoicePreviewState({
        status: "error",
        message:
          previewError instanceof Error
            ? previewError.message
            : "Voice preview is unavailable.",
      });
    }
  };
  const updateTurnDetection = (
    field: keyof RealtimeTurnDetection,
    value: number,
  ) =>
    applyConfig((config) => {
      const base =
        config.turnDetection ??
        voiceOptions?.defaultTurnDetection ?? {
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        };
      return {
        ...config,
        turnDetection: clampTurnDetection({ ...base, [field]: value }),
      };
    });

  // --- Agent management -----------------------------------------------------
  const createNewAgent = () => {
    const agent = createAgent("New agent");
    setAgents((current) => addAgent(current, agent));
    setSelectedAgentId(agent.id);
  };
  const duplicateSelectedAgent = () => {
    const next = duplicateAgent(agents, effectiveAgentId);
    const index = agents.findIndex((item) => item.id === effectiveAgentId);
    const copy = next[index + 1];
    setAgents(next);
    if (copy) setSelectedAgentId(copy.id);
  };
  const deleteSelectedAgent = () => {
    if (
      !window.confirm(
        `Delete agent "${selectedAgent.name}"? Conversation history is kept.`,
      )
    )
      return;
    const next = deleteAgent(agents, effectiveAgentId);
    setAgents(next);
    setSelectedAgentId(resolveSelectedAgentId(next, null));
  };
  const renameSelectedAgent = (name: string) =>
    setAgents((current) => renameAgent(current, effectiveAgentId, name));
  const normalizeSelectedAgentName = () =>
    setAgents((current) => normalizeAgentName(current, effectiveAgentId));
  const describeSelectedAgent = (description: string) =>
    setAgents((current) =>
      updateAgentDescription(current, effectiveAgentId, description),
    );

  useEffect(() => {
    if (effectiveAgentId) saveSelectedAgentId(effectiveAgentId);
  }, [effectiveAgentId]);

  const telemetrySummary = summarizeTurns(telemetry.turns);
  const formatMs = (value: number | undefined | null) =>
    value === undefined || value === null ? "—" : `${Math.round(value)} ms`;

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
          <aside
            className={`telemetry-panel${telemetryOpen ? "" : " collapsed"}`}
            aria-label="Frontend performance"
          >
            <div className="telemetry-heading">
              <strong>Performance</strong>
              <span>browser-observed · this session</span>
              <button
                type="button"
                className="telemetry-toggle"
                aria-expanded={telemetryOpen}
                onClick={() => setTelemetryOpen((open) => !open)}
              >
                {telemetryOpen ? "Hide" : "Show"}
              </button>
            </div>
            <div className="telemetry-summary">
              <span><b>p50 end of speech → response started</b>{formatMs(telemetrySummary.p50EouToResponseStartedMs)}<small>measured · Realtime response.created</small></span>
              <span><b>p50 end of speech → first audio</b>{formatMs(telemetrySummary.p50EouToAudioMs)}<small>measured · first assistant audio playback</small></span>
              <span><b>p50 response started → first text</b>{formatMs(telemetrySummary.p50ResponseStartedToTranscriptMs)}<small>measured · first transcript delta</small></span>
              <span><b>p50 total response</b>{formatMs(telemetrySummary.p50SpeechStartToDoneMs)}<small>measured · includes your speaking time</small></span>
              <span><b>session setup</b>{formatMs(telemetry.sessionSetupMs)}<small>connect start to data channel ready</small></span>
              <span><b>errors</b>{telemetry.errorCount}<small>UI/runtime errors</small></span>
            </div>
            <p className="telemetry-note">
              Live metrics are measured from genuine Realtime event timestamps
              (end-of-utterance, response.created, first transcript delta) and
              real assistant-audio playback, captured in the browser this
              session. They are not isolated STT, LLM, or TTS stage latency, which
              the live Realtime API does not expose.
            </p>
            {telemetry.turns.length > 0 && (
              <div className="telemetry-turns">
                {telemetry.turns.slice().reverse().map((turn) => (
                  <div key={turn.id}>
                    <span>{turn.status === "complete" ? "Complete" : "Interrupted"}</span>
                    <span>EOU → transcript {formatMs(turn.firstAssistantTranscriptMs)}</span>
                    <span>EOU → audio {formatMs(turn.firstAssistantAudioMs)}</span>
                    <span>total (incl. speech) {formatMs(turn.totalResponseMs)}</span>
                  </div>
                ))}
              </div>
            )}
          </aside>

          <div className="conversation-column">
            <div className={`prompt-config${promptConfigOpen ? " open" : ""}`}>
              <button
                type="button"
                className="prompt-config-summary"
                aria-expanded={promptConfigOpen}
                onClick={() => setPromptConfigOpen((open) => !open)}
              >
                Agent configuration
                <span className="prompt-config-note">
                  {promptEditingDisabled
                    ? "Applies to the next session"
                    : `Agent: ${selectedAgent.name}`}
                </span>
              </button>
              <div className="prompt-config-body" hidden={!promptConfigOpen}>
                <div className="agent-bar">
                  <label className="agent-select">
                    <span>Agent</span>
                    <select
                      value={effectiveAgentId}
                      onChange={(event) => setSelectedAgentId(event.target.value)}
                      disabled={promptEditingDisabled}
                    >
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="agent-actions">
                    <button
                      type="button"
                      onClick={createNewAgent}
                      disabled={promptEditingDisabled}
                    >
                      New
                    </button>
                    <button
                      type="button"
                      onClick={duplicateSelectedAgent}
                      disabled={promptEditingDisabled}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={deleteSelectedAgent}
                      disabled={promptEditingDisabled}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <label className="prompt-field">
                  <span>Agent name</span>
                  <input
                    type="text"
                    value={selectedAgent.name}
                    onChange={(event) => renameSelectedAgent(event.target.value)}
                    onBlur={() => normalizeSelectedAgentName()}
                    placeholder="Agent name"
                    disabled={promptEditingDisabled}
                  />
                </label>
                <label className="prompt-field">
                  <span>Description</span>
                  <input
                    type="text"
                    value={selectedAgent.description}
                    onChange={(event) =>
                      describeSelectedAgent(event.target.value)
                    }
                    placeholder="Optional description"
                    disabled={promptEditingDisabled}
                  />
                </label>
                <label className="prompt-field">
                  <span>System prompt</span>
                  <textarea
                    value={promptTemplate}
                    onChange={(event) => setPromptTemplate(event.target.value)}
                    placeholder="e.g. You are {{persona}}, a helpful assistant for {{company}}."
                    rows={4}
                    disabled={promptEditingDisabled}
                  />
                </label>

                <div className="prompt-variables">
                  <div className="prompt-variables-head">
                    <span>Variables</span>
                    <button
                      type="button"
                      onClick={addPromptVariable}
                      disabled={promptEditingDisabled}
                    >
                      Add variable
                    </button>
                  </div>
                  {promptVariables.length === 0 && (
                    <p className="prompt-hint">
                      Use <code>{"{{name}}"}</code> placeholders in the prompt, then
                      define their values here.
                    </p>
                  )}
                  {promptVariables.map((variable) => (
                    <div className="prompt-variable-row" key={variable.id}>
                      <input
                        type="text"
                        value={variable.name}
                        onChange={(event) =>
                          updatePromptVariable(variable.id, "name", event.target.value)
                        }
                        placeholder="name"
                        aria-label="Variable name"
                        disabled={promptEditingDisabled}
                      />
                      <input
                        type="text"
                        value={variable.value}
                        onChange={(event) =>
                          updatePromptVariable(variable.id, "value", event.target.value)
                        }
                        placeholder="value"
                        aria-label="Variable value"
                        disabled={promptEditingDisabled}
                      />
                      <button
                        type="button"
                        onClick={() => removePromptVariable(variable.id)}
                        disabled={promptEditingDisabled}
                        aria-label="Remove variable"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                {(variableIssues.invalidNames.length > 0 ||
                  variableIssues.duplicateNames.length > 0 ||
                  renderedPrompt.invalid.length > 0 ||
                  renderedPrompt.missing.length > 0) && (
                  <ul className="prompt-warnings" role="alert">
                    {variableIssues.invalidNames.map((name) => (
                      <li key={`inv-${name}`}>Invalid variable name: {name}</li>
                    ))}
                    {variableIssues.duplicateNames.map((name) => (
                      <li key={`dup-${name}`}>Duplicate variable name: {name}</li>
                    ))}
                    {renderedPrompt.invalid.map((name) => (
                      <li key={`pinv-${name}`}>Invalid placeholder: {`{{${name}}}`}</li>
                    ))}
                    {renderedPrompt.missing.map((name) => (
                      <li key={`miss-${name}`}>Missing value for: {name}</li>
                    ))}
                  </ul>
                )}

                <div className="prompt-preview">
                  <span className="prompt-preview-label">Rendered prompt preview</span>
                  <pre>
                    {renderedPrompt.text.trim() ||
                      "No custom prompt. The default assistant prompt will be used."}
                  </pre>
                </div>

                <div className="voice-config">
                  <div className="voice-config-head">
                    <span>Live conversation voice</span>
                    <small>
                      Applies to live Realtime sessions only &mdash; it does not
                      change the fallback text-to-speech voice.
                    </small>
                  </div>
                  {voiceOptionsError ? (
                    <p className="error-message" role="alert">
                      {voiceOptionsError}
                    </p>
                  ) : !voiceOptions || !turnDetection ? (
                    <p className="prompt-hint">Loading voice options...</p>
                  ) : (
                    <>
                      <label className="voice-field">
                        <span>Voice</span>
                        <select
                          value={selectedVoice}
                          onChange={(event) =>
                            setSelectedVoice(event.target.value)
                          }
                          disabled={promptEditingDisabled}
                        >
                          {voiceOptions.voices.map((voice) => (
                            <option key={voice} value={voice}>
                              {voice}
                              {voice === voiceOptions.defaultVoice
                                ? " (default)"
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="voice-preview">
                        <button
                          type="button"
                          onClick={() => void previewSelectedVoice()}
                          disabled={voicePreviewState.status === "loading"}
                        >
                          {voicePreviewState.status === "loading"
                            ? "Previewing..."
                            : "Preview voice"}
                        </button>
                        {voicePreviewState.status === "error" && (
                          <span className="prompt-hint" role="alert">
                            {voicePreviewState.message}
                          </span>
                        )}
                      </div>

                      <div className="vad-controls">
                        <label className="vad-field">
                          <span>
                            Interruption threshold:{" "}
                            {turnDetection.threshold.toFixed(2)}
                          </span>
                          <input
                            type="range"
                            min={VAD_BOUNDS.threshold.min}
                            max={VAD_BOUNDS.threshold.max}
                            step={0.05}
                            value={turnDetection.threshold}
                            onChange={(event) =>
                              updateTurnDetection(
                                "threshold",
                                Number(event.target.value),
                              )
                            }
                            disabled={promptEditingDisabled}
                          />
                        </label>
                        <label className="vad-field">
                          <span>
                            Prefix padding: {turnDetection.prefix_padding_ms} ms
                          </span>
                          <input
                            type="range"
                            min={VAD_BOUNDS.prefix_padding_ms.min}
                            max={VAD_BOUNDS.prefix_padding_ms.max}
                            step={50}
                            value={turnDetection.prefix_padding_ms}
                            onChange={(event) =>
                              updateTurnDetection(
                                "prefix_padding_ms",
                                Number(event.target.value),
                              )
                            }
                            disabled={promptEditingDisabled}
                          />
                        </label>
                        <label className="vad-field">
                          <span>
                            Silence duration:{" "}
                            {turnDetection.silence_duration_ms} ms
                          </span>
                          <input
                            type="range"
                            min={VAD_BOUNDS.silence_duration_ms.min}
                            max={VAD_BOUNDS.silence_duration_ms.max}
                            step={50}
                            value={turnDetection.silence_duration_ms}
                            onChange={(event) =>
                              updateTurnDetection(
                                "silence_duration_ms",
                                Number(event.target.value),
                              )
                            }
                            disabled={promptEditingDisabled}
                          />
                        </label>
                      </div>
                    </>
                  )}
                </div>

                {TURN_BASED_ENABLED && fallbackTtsInfo?.speedSupported && (
                  <div className="fallback-config">
                    <div className="voice-config-head">
                      <span>Fallback TTS speed</span>
                      <small>
                        Fallback TTS only &mdash; does not affect live Realtime.
                        Provider: {fallbackTtsInfo.provider}.
                      </small>
                    </div>
                    <label className="fallback-speed-toggle">
                      <input
                        type="checkbox"
                        checked={fallbackSpeed !== null}
                        onChange={(event) =>
                          setFallbackSpeed(
                            event.target.checked
                              ? fallbackTtsInfo.speedDefault ??
                                  fallbackTtsInfo.speedMin ??
                                  1
                              : null,
                          )
                        }
                        disabled={promptEditingDisabled}
                      />
                      <span>Override speed</span>
                    </label>
                    {fallbackSpeed !== null &&
                      fallbackTtsInfo.speedMin !== null &&
                      fallbackTtsInfo.speedMax !== null && (
                        <label className="vad-field">
                          <span>
                            Speed: {fallbackSpeed.toFixed(2)} (range{" "}
                            {fallbackTtsInfo.speedMin}&ndash;
                            {fallbackTtsInfo.speedMax})
                          </span>
                          <input
                            type="range"
                            min={fallbackTtsInfo.speedMin}
                            max={fallbackTtsInfo.speedMax}
                            step={0.05}
                            value={fallbackSpeed}
                            onChange={(event) =>
                              setFallbackSpeed(
                                clampFallbackSpeed(
                                  Number(event.target.value),
                                  fallbackTtsInfo,
                                ),
                              )
                            }
                            disabled={promptEditingDisabled}
                          />
                        </label>
                      )}
                  </div>
                )}
                <div className="playback-config">
                  <div className="voice-config-head">
                    <span>Playback and capture</span>
                    <small>
                      {TURN_BASED_ENABLED
                        ? "Volume applies to live and turn-based modes. Minimum response delay applies to turn-based (fallback) mode only. "
                        : "Volume applies to live playback. "}
                      Word-gated interruption applies to live sessions.
                      Microphone settings take effect on the next
                      {TURN_BASED_ENABLED ? " session/recording." : " session."}
                    </small>
                  </div>
                  <label className="vad-field">
                    <span>Output volume: {Math.round(volume * 100)}%</span>
                    <input
                      type="range"
                      min={VOLUME_BOUNDS.min}
                      max={VOLUME_BOUNDS.max}
                      step={0.05}
                      value={volume}
                      onChange={(event) => setVolume(Number(event.target.value))}
                    />
                  </label>
                  {TURN_BASED_ENABLED && (
                    <label className="vad-field">
                      <span>
                        Minimum response delay (turn-based only):{" "}
                        {minResponseDelayMs} ms
                      </span>
                      <input
                        type="range"
                        min={MIN_RESPONSE_DELAY_BOUNDS.min}
                        max={MIN_RESPONSE_DELAY_BOUNDS.max}
                        step={50}
                        value={minResponseDelayMs}
                        onChange={(event) =>
                          setMinResponseDelayMs(Number(event.target.value))
                        }
                        disabled={promptEditingDisabled}
                      />
                      <small>
                        Live mode cannot delay its unbuffered audio stream without
                        dropping speech, so this applies to turn-based mode only.
                      </small>
                    </label>
                  )}
                  <label className="vad-field">
                    <span>Words before interruption: {interruptMinWords}</span>
                    <input
                      type="range"
                      min={INTERRUPT_MIN_WORDS_BOUNDS.min}
                      max={INTERRUPT_MIN_WORDS_BOUNDS.max}
                      step={1}
                      value={interruptMinWords}
                      onChange={(event) =>
                        setInterruptMinWords(Number(event.target.value))
                      }
                      disabled={promptEditingDisabled}
                    />
                    <small>0 = interrupt immediately (live only)</small>
                  </label>
                  <fieldset className="mic-processing">
                    <legend>Microphone processing (next session)</legend>
                    {MIC_PROCESSING_FIELDS.map((field) => (
                      <label key={field} className="mic-processing-toggle">
                        <input
                          type="checkbox"
                          checked={micProcessing[field]}
                          onChange={(event) =>
                            setMicProcessingFlag(field, event.target.checked)
                          }
                          disabled={promptEditingDisabled}
                        />
                        <span>{MIC_PROCESSING_LABELS[field]}</span>
                      </label>
                    ))}
                  </fieldset>
                  <div className="ambience-controls">
                    <label className="mic-processing-toggle">
                      <input
                        type="checkbox"
                        checked={ambienceEnabled}
                        onChange={(event) =>
                          setAmbienceEnabled(event.target.checked)
                        }
                        disabled={promptEditingDisabled}
                      />
                      <span>
                        Background ambience: office typing (live; next session)
                      </span>
                    </label>
                    {ambienceEnabled && (
                      <label className="vad-field">
                        <span>
                          Ambience volume: {Math.round(ambienceVolume * 100)}%
                        </span>
                        <input
                          type="range"
                          min={AMBIENCE_VOLUME_BOUNDS.min}
                          max={AMBIENCE_VOLUME_BOUNDS.max}
                          step={0.05}
                          value={ambienceVolume}
                          onChange={(event) =>
                            setAmbienceVolume(Number(event.target.value))
                          }
                        />
                      </label>
                    )}
                  </div>
                </div>
              </div>
            </div>
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
                        ref={(element) => {
                          if (element) {
                            applyVolume(element, volumeRef.current);
                            fallbackAudioElsRef.current.add(element);
                          }
                        }}
                        onPlay={() => setPlayingTurnId(turn.id)}
                        onPause={() => setPlayingTurnId((current) => current === turn.id ? "" : current)}
                        onEnded={() => setPlayingTurnId((current) => current === turn.id ? "" : current)}
                      />
                    ) : turn.ttsError ? (
                      <p className="error-message" role="alert">{turn.ttsError}</p>
                    ) : null}
                    {TURN_BASED_ENABLED && turn.timings && (
                      <div className="turn-timings" aria-label="Turn-based stage latency">
                        <span>STT {formatMs(turn.timings.stt_ms)}</span>
                        <span>LLM {formatMs(turn.timings.llm_ms)}</span>
                        <span>
                          TTS{" "}
                          {turn.timings.tts_ms === null
                            ? "failed"
                            : formatMs(turn.timings.tts_ms)}
                        </span>
                        <span>total {formatMs(turn.timings.total_ms)}</span>
                        <small>wall-clock per provider call, not pure compute</small>
                      </div>
                    )}
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
              disabled={isProcessing || isRecording || (!isLiveConversation && !promptValidation.canStart)}
              aria-label={isLiveConversation ? "End live conversation" : error ? "Retry live conversation" : "Start live conversation"}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>
            </button>
            {isLiveConversation && (
              <button className="end-session-button" type="button" onClick={endRealtimeConversation}>
                End conversation
              </button>
            )}
            {TURN_BASED_ENABLED && !isLiveConversation && !isRecording && (
              <button
                className="fallback-button"
                type="button"
                onClick={() => void startRecording()}
                disabled={isProcessing || !promptValidation.canStart}
                title="Record one turn through the STT, LLM, and TTS fallback pipeline"
              >
                Turn-based mode
              </button>
            )}
            {TURN_BASED_ENABLED && isRecording && (
              <button className="fallback-button" type="button" onClick={stopRecording} disabled={isProcessing}>
                Stop recording
              </button>
            )}
          </div>
          {!isLiveConversation && !promptValidation.canStart && (
            <div className="prompt-gate-message" role="alert">
              <strong>Resolve the prompt configuration before starting:</strong>
              <ul>
                {promptValidation.errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}
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
