import { startTransition, useState, useCallback, useRef, useEffect } from 'react';
import {
    type AgentToolDecision,
    type AgentToolConfirmationEvent,
    type ProgressActivityKind,
    type ProgressStatus,
    streamService,
    type PipelineRunRequest,
    type StreamCompleteEvent,
    type StreamErrorEvent,
    type StreamProgressEvent,
    type StreamTokenEvent,
} from '../services/streamService';
import { settingsService, type ReasoningTokenConfig } from '../services/settingsService';
import { useSettingsStore } from '../store/settingsStore';
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Batching interval (ms) for stream token updates.
 * Tokens accumulate in a ref and flush to React state at this cadence,
 * preventing a full re-render for every single token arrival.
 */
const STREAM_FLUSH_INTERVAL_MS = 32; // ~2 frames at 60fps
const MAX_PROGRESS_STEPS = 24;
const MAX_THINKING_STREAM_CHARS = 12_000;
const MAX_PERSISTED_REASONING_CHARS = 20_000;
const CONFIRMATION_EXPIRY_SWEEP_MS = 1_000;

interface PipelineHandlers {
    onComplete?: (
        fullText: string,
        event: StreamCompleteEvent,
        meta: StreamCompletionMeta,
    ) => void | Promise<void>;
    onRuntimeError?: (event: StreamErrorEvent) => void | Promise<void>;
}

interface PendingAgentConfirmation extends AgentToolConfirmationEvent {
    receivedAt: number;
}

export interface StreamCompletionMeta {
    reasoningText: string;
}

export interface LayerProgressStep {
    message: string;
    status?: ProgressStatus;
    layer?: string;
    activityKind?: ProgressActivityKind;
    tool?: string;
    step?: number;
    callId?: string;
    displayTarget?: string;
    requestId?: string;
    key: number;
}

function toProgressStep(event: StreamProgressEvent, key: number): LayerProgressStep {
    return {
        message: event.message,
        status: event.status,
        layer: event.layer,
        activityKind: event.activityKind,
        tool: event.tool,
        step: event.step,
        callId: event.callId,
        displayTarget: event.displayTarget,
        requestId: event.requestId,
        key,
    };
}

function appendWithCharCap(prev: string, chunk: string, maxChars: number): string {
    if (!chunk) {
        return prev;
    }
    const next = prev + chunk;
    if (next.length <= maxChars) {
        return next;
    }
    return next.slice(next.length - maxChars);
}

function estimateTokenCount(text: string): number {
    if (!text) {
        return 0;
    }
    // Lightweight approximation for local UI telemetry.
    return Math.max(1, Math.round(text.length / 4));
}

function parseExpiresAtMs(expiresAt: string | undefined): number | null {
    if (!expiresAt) {
        return null;
    }
    const parsed = Date.parse(expiresAt);
    return Number.isFinite(parsed) ? parsed : null;
}

function isExpiredConfirmation(
    confirmation: Pick<AgentToolConfirmationEvent, 'expiresAt'>,
    nowMs = Date.now(),
): boolean {
    const expiryMs = parseExpiresAtMs(confirmation.expiresAt);
    return expiryMs !== null && nowMs >= expiryMs;
}

interface ReasoningParserState {
    inReasoning: boolean;
    carry: string;
}

interface MarkerMatch {
    index: number;
    marker: string;
}

const DEFAULT_REASONING_CONFIG: ReasoningTokenConfig = {
    openMarkers: ['<think>'],
    closeMarkers: ['</think>'],
};

function pushUniqueCaseInsensitive(target: string[], marker: string): void {
    const normalized = marker.trim();
    if (!normalized) {
        return;
    }
    const lower = normalized.toLowerCase();
    if (target.some((existing) => existing.toLowerCase() === lower)) {
        return;
    }
    target.push(normalized);
}

function expandMarkers(markers: string[], kind: 'open' | 'close'): string[] {
    const expanded: string[] = [];
    for (const marker of markers) {
        pushUniqueCaseInsensitive(expanded, marker);

        // Relax strict XML-ish markers so malformed model output like
        // "<think" or "</think?" still toggles reasoning mode correctly.
        if (marker.startsWith('<') && marker.endsWith('>') && marker.length > 2) {
            const relaxed = marker.slice(0, -1);
            pushUniqueCaseInsensitive(expanded, relaxed);

            if (kind === 'close') {
                pushUniqueCaseInsensitive(expanded, `${relaxed}?`);
                pushUniqueCaseInsensitive(expanded, `${relaxed}?>`);
            }
        }
    }
    return expanded;
}

function normalizeReasoningConfig(raw: Partial<ReasoningTokenConfig> | null | undefined): ReasoningTokenConfig {
    const dedupe = (markers: string[] | undefined): string[] => {
        const out: string[] = [];
        for (const marker of markers ?? []) {
            pushUniqueCaseInsensitive(out, marker);
        }
        return out;
    };

    const openMarkers = dedupe(raw?.openMarkers);
    const closeMarkers = dedupe(raw?.closeMarkers);

    return {
        openMarkers: expandMarkers(
            openMarkers.length > 0 ? openMarkers : DEFAULT_REASONING_CONFIG.openMarkers,
            'open',
        ),
        closeMarkers: expandMarkers(
            closeMarkers.length > 0 ? closeMarkers : DEFAULT_REASONING_CONFIG.closeMarkers,
            'close',
        ),
    };
}

function findEarliestMarker(text: string, markers: string[]): MarkerMatch | null {
    const lowerText = text.toLowerCase();
    let best: MarkerMatch | null = null;
    for (const marker of markers) {
        const idx = lowerText.indexOf(marker.toLowerCase());
        if (idx === -1) continue;
        if (!best || idx < best.index || (idx === best.index && marker.length > best.marker.length)) {
            best = { index: idx, marker };
        }
    }
    return best;
}

function trailingMarkerPrefixLength(text: string, markers: string[]): number {
    const lowerText = text.toLowerCase();
    let maxPrefix = 0;
    for (const marker of markers) {
        const lowerMarker = marker.toLowerCase();
        const maxLen = Math.min(text.length, marker.length - 1);
        for (let len = maxLen; len >= 1; len--) {
            if (lowerText.endsWith(lowerMarker.slice(0, len))) {
                if (len > maxPrefix) {
                    maxPrefix = len;
                }
                break;
            }
        }
    }
    return maxPrefix;
}

function consumeMalformedTagSuffix(text: string, markerEnd: number, marker: string): number {
    if (marker.endsWith('>')) {
        return markerEnd;
    }

    let cursor = markerEnd;
    let consumed = 0;
    while (cursor < text.length && consumed < 8) {
        const ch = text[cursor];
        if (/[A-Za-z0-9<]/.test(ch)) {
            break;
        }
        cursor += 1;
        consumed += 1;
        if (ch === '>') {
            break;
        }
    }
    return cursor;
}

function splitReasoningFromSegment(
    segment: string,
    parser: ReasoningParserState,
    config: ReasoningTokenConfig,
): { answerDelta: string; reasoningDelta: string } {
    if (!segment) {
        return { answerDelta: '', reasoningDelta: '' };
    }

    const allMarkers = [...config.openMarkers, ...config.closeMarkers];
    let text = `${parser.carry}${segment}`;
    parser.carry = '';

    const carryLen = trailingMarkerPrefixLength(text, allMarkers);
    if (carryLen > 0) {
        parser.carry = text.slice(-carryLen);
        text = text.slice(0, -carryLen);
    }

    let answerDelta = '';
    let reasoningDelta = '';
    let remaining = text;

    while (remaining.length > 0) {
        if (parser.inReasoning) {
            const closeMatch = findEarliestMarker(remaining, config.closeMarkers);
            if (!closeMatch) {
                reasoningDelta += remaining;
                break;
            }
            reasoningDelta += remaining.slice(0, closeMatch.index);
            const closeMarkerEnd = consumeMalformedTagSuffix(
                remaining,
                closeMatch.index + closeMatch.marker.length,
                closeMatch.marker,
            );
            remaining = remaining.slice(closeMarkerEnd);
            parser.inReasoning = false;
            continue;
        }

        const openMatch = findEarliestMarker(remaining, config.openMarkers);
        if (!openMatch) {
            answerDelta += remaining;
            break;
        }
        answerDelta += remaining.slice(0, openMatch.index);
        const openMarkerEnd = consumeMalformedTagSuffix(
            remaining,
            openMatch.index + openMatch.marker.length,
            openMatch.marker,
        );
        remaining = remaining.slice(openMarkerEnd);
        parser.inReasoning = true;
    }

    return { answerDelta, reasoningDelta };
}

function flushReasoningCarry(parser: ReasoningParserState): { answerTail: string; reasoningTail: string } {
    if (!parser.carry) {
        return { answerTail: '', reasoningTail: '' };
    }

    const carry = parser.carry;
    parser.carry = '';

    if (parser.inReasoning) {
        return { answerTail: '', reasoningTail: carry };
    }
    return { answerTail: carry, reasoningTail: '' };
}

export function useStreaming() {
    const thinkingModeEnabled = useSettingsStore((s) => s.generation.thinkingMode);
    const [isGenerating, setIsGenerating] = useState(false);
    const [currentStream, setCurrentStream] = useState('');
    const [thinkingStream, setThinkingStream] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<LayerProgressStep | null>(null);
    const [progressSteps, setProgressSteps] = useState<LayerProgressStep[]>([]);
    const [isProgressVisible, setIsProgressVisible] = useState(false);
    const [liveTokensPerSecond, setLiveTokensPerSecond] = useState<number | null>(null);
    const [pendingAgentConfirmations, setPendingAgentConfirmations] = useState<PendingAgentConfirmation[]>([]);
    const unlistenFns = useRef<UnlistenFn[]>([]);
    const activeRequestId = useRef<string | null>(null);
    const progressClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const progressKeyRef = useRef(0);
    const tokenCountRef = useRef(0);
    const streamStartTimeRef = useRef<number | null>(null);
    const reasoningConfigRef = useRef<ReasoningTokenConfig>(DEFAULT_REASONING_CONFIG);
    const reasoningParserRef = useRef<ReasoningParserState>({ inReasoning: false, carry: '' });
    const isThinkingRef = useRef(false);
    const thinkingUiStateRef = useRef(false);
    const lastLiveTokensPerSecondRef = useRef<number | null>(null);
    const lastLiveStatsEmitMsRef = useRef(0);

    // Buffer for accumulating tokens between flush cycles
    const tokenBuffer = useRef('');
    const reasoningTokenBuffer = useRef('');
    const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const cleanupListeners = useCallback(() => {
        unlistenFns.current.forEach((fn) => fn());
        unlistenFns.current = [];
    }, []);

    // Cleanup listeners on unmount
    useEffect(() => {
        return () => {
            cleanupListeners();
            if (progressClearTimerRef.current) {
                clearTimeout(progressClearTimerRef.current);
                progressClearTimerRef.current = null;
            }
            if (flushTimerRef.current) {
                clearInterval(flushTimerRef.current);
                flushTimerRef.current = null;
            }
        };
    }, [cleanupListeners]);

    useEffect(() => {
        const timerId = window.setInterval(() => {
            const nowMs = Date.now();
            setPendingAgentConfirmations((current) => {
                if (current.length === 0) {
                    return current;
                }
                const next = current.filter((item) => !isExpiredConfirmation(item, nowMs));
                return next.length === current.length ? current : next;
            });
        }, CONFIRMATION_EXPIRY_SWEEP_MS);

        return () => {
            window.clearInterval(timerId);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        void settingsService
            .getReasoningTokenConfig()
            .then((config) => {
                if (cancelled) return;
                reasoningConfigRef.current = normalizeReasoningConfig(config);
            })
            .catch((err) => {
                console.warn('Failed to load reasoning token config, using defaults:', err);
                if (cancelled) return;
                reasoningConfigRef.current = DEFAULT_REASONING_CONFIG;
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const showProgress = useCallback((event: StreamProgressEvent) => {
        if (progressClearTimerRef.current) {
            clearTimeout(progressClearTimerRef.current);
            progressClearTimerRef.current = null;
        }

        progressKeyRef.current += 1;
        const step = toProgressStep(event, progressKeyRef.current);

        // Always update the current indicator (keeps the breathing dot alive)
        setProgress(step);
        setIsProgressVisible(true);

        setProgressSteps((prev) => {
            const last = prev[prev.length - 1];

            // Skip exact duplicates in the step list
            if (
                last
                && last.layer === step.layer
                && last.tool === step.tool
                && last.callId === step.callId
                && last.activityKind === step.activityKind
                && last.message === step.message
                && last.status === step.status
                && last.step === step.step
                && last.displayTarget === step.displayTarget
            ) {
                return prev;
            }

            const next = [...prev, step];
            if (next.length <= MAX_PROGRESS_STEPS) {
                return next;
            }
            return next.slice(next.length - MAX_PROGRESS_STEPS);
        });
    }, []);

    const hideProgress = useCallback((delayMs = 300) => {
        if (progressClearTimerRef.current) {
            clearTimeout(progressClearTimerRef.current);
            progressClearTimerRef.current = null;
        }
        setIsProgressVisible(false);
        progressClearTimerRef.current = setTimeout(() => {
            setProgress(null);
        }, delayMs);
    }, []);

    const syncThinkingUiState = useCallback((next: boolean) => {
        if (thinkingUiStateRef.current === next) {
            return;
        }
        thinkingUiStateRef.current = next;
        setIsThinking(next);
    }, []);

    const maybeEmitLiveStats = useCallback((force = false) => {
        if (!streamStartTimeRef.current) {
            return;
        }
        const elapsedSeconds = (Date.now() - streamStartTimeRef.current) / 1000;
        if (elapsedSeconds <= 0.05) {
            return;
        }

        const tps = tokenCountRef.current / elapsedSeconds;
        const now = Date.now();

        if (!force && now - lastLiveStatsEmitMsRef.current < 160) {
            return;
        }

        const previous = lastLiveTokensPerSecondRef.current;
        if (force || previous === null || Math.abs(previous - tps) >= 0.15) {
            lastLiveTokensPerSecondRef.current = tps;
            startTransition(() => {
                setLiveTokensPerSecond(tps);
            });
        }
        lastLiveStatsEmitMsRef.current = now;
    }, []);

    /** Flush buffered tokens to React state in a single setState call. */
    const startFlushTimer = useCallback(() => {
        if (flushTimerRef.current) return;
        flushTimerRef.current = setInterval(() => {
            if (tokenBuffer.current.length > 0) {
                const batch = tokenBuffer.current;
                tokenBuffer.current = '';
                startTransition(() => {
                    setCurrentStream((prev) => prev + batch);
                });
            }
            if (reasoningTokenBuffer.current.length > 0) {
                const reasoningBatch = reasoningTokenBuffer.current;
                reasoningTokenBuffer.current = '';
                startTransition(() => {
                    setThinkingStream((prev) =>
                        appendWithCharCap(prev, reasoningBatch, MAX_THINKING_STREAM_CHARS),
                    );
                });
            }
            syncThinkingUiState(isThinkingRef.current);
            maybeEmitLiveStats(false);
        }, STREAM_FLUSH_INTERVAL_MS);
    }, [maybeEmitLiveStats, syncThinkingUiState]);

    const stopFlushTimer = useCallback(() => {
        if (flushTimerRef.current) {
            clearInterval(flushTimerRef.current);
            flushTimerRef.current = null;
        }
        // Final flush for any remaining tokens
        if (tokenBuffer.current.length > 0) {
            const remaining = tokenBuffer.current;
            tokenBuffer.current = '';
            startTransition(() => {
                setCurrentStream((prev) => prev + remaining);
            });
        }
        if (reasoningTokenBuffer.current.length > 0) {
            const reasoningRemaining = reasoningTokenBuffer.current;
            reasoningTokenBuffer.current = '';
            startTransition(() => {
                setThinkingStream((prev) =>
                    appendWithCharCap(prev, reasoningRemaining, MAX_THINKING_STREAM_CHARS),
                );
            });
        }
        syncThinkingUiState(isThinkingRef.current);
    }, [syncThinkingUiState]);

    const resetLiveStats = useCallback(() => {
        tokenCountRef.current = 0;
        streamStartTimeRef.current = Date.now();
        lastLiveTokensPerSecondRef.current = null;
        lastLiveStatsEmitMsRef.current = 0;
        setLiveTokensPerSecond(null);
    }, []);

    const finalizeLiveStats = useCallback(() => {
        maybeEmitLiveStats(true);
    }, [maybeEmitLiveStats]);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    const generatePipeline = useCallback(async (
        request: PipelineRunRequest,
        handlers?: PipelineHandlers,
    ) => {
        setIsGenerating(true);
        setCurrentStream('');
        setThinkingStream('');
        syncThinkingUiState(false);
        setError(null);
        setProgress(null);
        setProgressSteps([]);
        setPendingAgentConfirmations([]);
        tokenBuffer.current = '';
        reasoningTokenBuffer.current = '';
        activeRequestId.current = request.requestId;
        reasoningParserRef.current = { inReasoning: false, carry: '' };
        isThinkingRef.current = false;
        resetLiveStats();
        showProgress({ message: 'Starting pipeline...', status: 'started', requestId: request.requestId });

        let accumulatedAnswer = '';
        let accumulatedReasoning = '';
        startFlushTimer();
        cleanupListeners();

        const unlistenToken = await streamService.onTokenStream((event: StreamTokenEvent) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
            tokenCountRef.current += estimateTokenCount(event.token);
            if (!thinkingModeEnabled) {
                accumulatedAnswer += event.token;
                tokenBuffer.current += event.token;
                isThinkingRef.current = false;
                return;
            }
            const parsed = splitReasoningFromSegment(
                event.token,
                reasoningParserRef.current,
                reasoningConfigRef.current,
            );
            if (parsed.answerDelta) {
                accumulatedAnswer += parsed.answerDelta;
                tokenBuffer.current += parsed.answerDelta;
            }
            if (thinkingModeEnabled && parsed.reasoningDelta) {
                reasoningTokenBuffer.current += parsed.reasoningDelta;
                accumulatedReasoning = appendWithCharCap(
                    accumulatedReasoning,
                    parsed.reasoningDelta,
                    MAX_PERSISTED_REASONING_CHARS,
                );
            }
            isThinkingRef.current = thinkingModeEnabled
                ? reasoningParserRef.current.inReasoning
                : false;
        });

        const unlistenComplete = await streamService.onGenerationComplete(async (event) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
            if (thinkingModeEnabled) {
                const tail = flushReasoningCarry(reasoningParserRef.current);
                if (tail.answerTail) {
                    accumulatedAnswer += tail.answerTail;
                    tokenBuffer.current += tail.answerTail;
                }
                if (tail.reasoningTail) {
                    reasoningTokenBuffer.current += tail.reasoningTail;
                    accumulatedReasoning = appendWithCharCap(
                        accumulatedReasoning,
                        tail.reasoningTail,
                        MAX_PERSISTED_REASONING_CHARS,
                    );
                }
            }
            reasoningParserRef.current = { inReasoning: false, carry: '' };
            isThinkingRef.current = false;
            stopFlushTimer();
            setIsGenerating(false);
            setPendingAgentConfirmations([]);
            finalizeLiveStats();
            cleanupListeners();
            showProgress({
                message: 'Pipeline completed',
                status: 'success',
                requestId: request.requestId,
            });
            hideProgress(450);
            await handlers?.onComplete?.(accumulatedAnswer, event, {
                reasoningText: accumulatedReasoning,
            });
        });

        const unlistenError = await streamService.onGenerationError(async (event) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
            if (thinkingModeEnabled) {
                const tail = flushReasoningCarry(reasoningParserRef.current);
                if (tail.answerTail) {
                    accumulatedAnswer += tail.answerTail;
                    tokenBuffer.current += tail.answerTail;
                }
                if (tail.reasoningTail) {
                    reasoningTokenBuffer.current += tail.reasoningTail;
                    accumulatedReasoning = appendWithCharCap(
                        accumulatedReasoning,
                        tail.reasoningTail,
                        MAX_PERSISTED_REASONING_CHARS,
                    );
                }
            }
            reasoningParserRef.current = { inReasoning: false, carry: '' };
            isThinkingRef.current = false;
            stopFlushTimer();
            setError(event.message);
            setIsGenerating(false);
            setPendingAgentConfirmations([]);
            finalizeLiveStats();
            cleanupListeners();
            showProgress({ message: event.message, status: 'failed', requestId: request.requestId });
            hideProgress(700);
            await handlers?.onRuntimeError?.(event);
        });

        const unlistenProgress = await streamService.onPipelineProgress((event) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
            showProgress(event);
        });

        const unlistenAgentConfirmation = await streamService.onAgentToolConfirmationRequired((event) => {
            if (event.requestId !== request.requestId) {
                return;
            }
            if (isExpiredConfirmation(event)) {
                return;
            }
            setPendingAgentConfirmations((previous) => {
                const exists = previous.some(
                    (item) => item.requestId === event.requestId && item.actionId === event.actionId,
                );
                if (exists) {
                    return previous;
                }
                return [
                    ...previous,
                    {
                        ...event,
                        receivedAt: Date.now(),
                    },
                ];
            });
        });

        unlistenFns.current = [
            unlistenToken,
            unlistenComplete,
            unlistenError,
            unlistenProgress,
            unlistenAgentConfirmation,
        ];

        try {
            await streamService.runChatPipeline(request);
        } catch (err: unknown) {
            if (thinkingModeEnabled) {
                const tail = flushReasoningCarry(reasoningParserRef.current);
                if (tail.answerTail) {
                    accumulatedAnswer += tail.answerTail;
                    tokenBuffer.current += tail.answerTail;
                }
                if (tail.reasoningTail) {
                    reasoningTokenBuffer.current += tail.reasoningTail;
                    accumulatedReasoning = appendWithCharCap(
                        accumulatedReasoning,
                        tail.reasoningTail,
                        MAX_PERSISTED_REASONING_CHARS,
                    );
                }
            }
            reasoningParserRef.current = { inReasoning: false, carry: '' };
            isThinkingRef.current = false;
            stopFlushTimer();
            setIsGenerating(false);
            setPendingAgentConfirmations([]);
            cleanupListeners();
            finalizeLiveStats();
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            showProgress({ message: 'Pipeline failed', status: 'failed', requestId: request.requestId });
            hideProgress(700);
            throw err;
        }
    }, [cleanupListeners, finalizeLiveStats, hideProgress, resetLiveStats, showProgress, startFlushTimer, stopFlushTimer, syncThinkingUiState, thinkingModeEnabled]);

    const cancel = useCallback(async () => {
        try {
            await streamService.cancelGeneration();
            stopFlushTimer();
            setIsGenerating(false);
            isThinkingRef.current = false;
            syncThinkingUiState(false);
            setPendingAgentConfirmations([]);
            finalizeLiveStats();
            showProgress({ message: 'Generation cancelled', status: 'fallback' });
            hideProgress(500);
        } catch (err) {
            console.error('Failed to cancel generation:', err);
        }
    }, [finalizeLiveStats, hideProgress, showProgress, stopFlushTimer, syncThinkingUiState]);

    const respondToAgentToolConfirmation = useCallback(async (
        decision: AgentToolDecision,
        approved?: boolean,
    ) => {
        const pending = pendingAgentConfirmations[0];
        if (!pending) {
            return;
        }
        if (isExpiredConfirmation(pending)) {
            setPendingAgentConfirmations((current) => current.slice(1));
            return;
        }
        try {
            await streamService.submitAgentToolDecision(
                pending.requestId,
                pending.actionId,
                decision,
                approved,
            );
            setPendingAgentConfirmations((current) => {
                if (current.length === 0) {
                    return current;
                }
                const first = current[0];
                if (first.requestId !== pending.requestId || first.actionId !== pending.actionId) {
                    return current;
                }
                return current.slice(1);
            });
        } catch (err) {
            console.error('Failed to submit agent tool decision:', err);
        }
    }, [pendingAgentConfirmations]);

    const pendingAgentConfirmation = pendingAgentConfirmations[0] ?? null;

    return {
        isGenerating,
        currentStream,
        thinkingStream,
        isThinking,
        error,
        progress,
        progressSteps,
        isProgressVisible,
        liveTokensPerSecond,
        pendingAgentConfirmation,
        generatePipeline,
        approveAgentToolOnce: () => respondToAgentToolConfirmation('approve_once'),
        approveAgentToolAlways: () => respondToAgentToolConfirmation('approve_always'),
        denyAgentTool: () => respondToAgentToolConfirmation('deny'),
        cancel,
        clearError,
    };
}
