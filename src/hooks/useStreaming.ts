import { useState, useCallback, useRef, useEffect } from 'react';
import {
    streamService,
    type PipelineRunRequest,
    type StreamCompleteEvent,
    type StreamErrorEvent,
    type StreamProgressEvent,
    type StreamTokenEvent,
} from '../services/streamService';
import { settingsService, type ReasoningTokenConfig } from '../services/settingsService';
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

interface PipelineHandlers {
    onComplete?: (
        fullText: string,
        event: StreamCompleteEvent,
        meta: StreamCompletionMeta,
    ) => void | Promise<void>;
    onRuntimeError?: (event: StreamErrorEvent) => void | Promise<void>;
}

export interface StreamCompletionMeta {
    reasoningText: string;
}

interface LayerProgressState {
    message: string;
    status?: 'started' | 'success' | 'fallback' | 'failed';
    layer?: string;
    requestId?: string;
    key: number;
}

export interface LayerProgressStep {
    message: string;
    status?: 'started' | 'success' | 'fallback' | 'failed';
    layer?: string;
    requestId?: string;
    key: number;
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
    const trimmed = text.trim();
    if (!trimmed) {
        return 0;
    }
    // Lightweight approximation for local UI telemetry.
    return Math.max(1, Math.round(trimmed.length / 4));
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

function normalizeReasoningConfig(raw: Partial<ReasoningTokenConfig> | null | undefined): ReasoningTokenConfig {
    const dedupe = (markers: string[] | undefined): string[] => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const marker of markers ?? []) {
            const normalized = marker.trim();
            if (!normalized || seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            out.push(normalized);
        }
        return out;
    };

    const openMarkers = dedupe(raw?.openMarkers);
    const closeMarkers = dedupe(raw?.closeMarkers);

    return {
        openMarkers: openMarkers.length > 0 ? openMarkers : DEFAULT_REASONING_CONFIG.openMarkers,
        closeMarkers: closeMarkers.length > 0 ? closeMarkers : DEFAULT_REASONING_CONFIG.closeMarkers,
    };
}

function findEarliestMarker(text: string, markers: string[]): MarkerMatch | null {
    let best: MarkerMatch | null = null;
    for (const marker of markers) {
        const idx = text.indexOf(marker);
        if (idx === -1) continue;
        if (!best || idx < best.index || (idx === best.index && marker.length > best.marker.length)) {
            best = { index: idx, marker };
        }
    }
    return best;
}

function trailingMarkerPrefixLength(text: string, markers: string[]): number {
    let maxPrefix = 0;
    for (const marker of markers) {
        const maxLen = Math.min(text.length, marker.length - 1);
        for (let len = maxLen; len >= 1; len--) {
            if (text.endsWith(marker.slice(0, len))) {
                if (len > maxPrefix) {
                    maxPrefix = len;
                }
                break;
            }
        }
    }
    return maxPrefix;
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
            remaining = remaining.slice(closeMatch.index + closeMatch.marker.length);
            parser.inReasoning = false;
            continue;
        }

        const openMatch = findEarliestMarker(remaining, config.openMarkers);
        if (!openMatch) {
            answerDelta += remaining;
            break;
        }
        answerDelta += remaining.slice(0, openMatch.index);
        remaining = remaining.slice(openMatch.index + openMatch.marker.length);
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
    const [isGenerating, setIsGenerating] = useState(false);
    const [currentStream, setCurrentStream] = useState('');
    const [thinkingStream, setThinkingStream] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<LayerProgressState | null>(null);
    const [progressSteps, setProgressSteps] = useState<LayerProgressStep[]>([]);
    const [isProgressVisible, setIsProgressVisible] = useState(false);
    const [liveTokensPerSecond, setLiveTokensPerSecond] = useState<number | null>(null);
    const unlistenFns = useRef<UnlistenFn[]>([]);
    const activeRequestId = useRef<string | null>(null);
    const progressClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

        const step: LayerProgressStep = {
            message: event.message,
            status: event.status,
            layer: event.layer,
            requestId: event.requestId,
            key: Date.now(),
        };

        setProgressSteps((prev) => {
            const last = prev[prev.length - 1];
            if (
                last
                && last.message === step.message
                && last.layer === step.layer
                && last.status === step.status
            ) {
                return prev;
            }
            const next = [...prev, step];
            if (next.length <= MAX_PROGRESS_STEPS) {
                return next;
            }
            return next.slice(next.length - MAX_PROGRESS_STEPS);
        });

        setProgress({
            message: event.message,
            status: event.status,
            layer: event.layer,
            requestId: event.requestId,
            key: Date.now(),
        });
        setIsProgressVisible(true);
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
            setLiveTokensPerSecond(tps);
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
                setCurrentStream((prev) => prev + batch);
            }
            if (reasoningTokenBuffer.current.length > 0) {
                const reasoningBatch = reasoningTokenBuffer.current;
                reasoningTokenBuffer.current = '';
                setThinkingStream((prev) =>
                    appendWithCharCap(prev, reasoningBatch, MAX_THINKING_STREAM_CHARS),
                );
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
            setCurrentStream((prev) => prev + remaining);
        }
        if (reasoningTokenBuffer.current.length > 0) {
            const reasoningRemaining = reasoningTokenBuffer.current;
            reasoningTokenBuffer.current = '';
            setThinkingStream((prev) =>
                appendWithCharCap(prev, reasoningRemaining, MAX_THINKING_STREAM_CHARS),
            );
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

    const generate = useCallback(async (
        prompt: string,
        onComplete?: (fullText: string, meta: StreamCompletionMeta) => void,
    ) => {
        setIsGenerating(true);
        setCurrentStream('');
        setThinkingStream('');
        syncThinkingUiState(false);
        setError(null);
        setProgressSteps([]);
        tokenBuffer.current = '';
        reasoningTokenBuffer.current = '';
        activeRequestId.current = null;
        reasoningParserRef.current = { inReasoning: false, carry: '' };
        isThinkingRef.current = false;
        resetLiveStats();
        showProgress({ message: 'Generating response...', status: 'started' });

        let accumulatedAnswer = '';
        let accumulatedReasoning = '';
        startFlushTimer();
        cleanupListeners();

        const unlistenToken = await streamService.onTokenStream((event: StreamTokenEvent) => {
            if (event.requestId && event.requestId !== activeRequestId.current) {
                return;
            }
            tokenCountRef.current += estimateTokenCount(event.token);
            const parsed = splitReasoningFromSegment(
                event.token,
                reasoningParserRef.current,
                reasoningConfigRef.current,
            );
            if (parsed.answerDelta) {
                accumulatedAnswer += parsed.answerDelta;
                tokenBuffer.current += parsed.answerDelta;
            }
            if (parsed.reasoningDelta) {
                reasoningTokenBuffer.current += parsed.reasoningDelta;
                accumulatedReasoning = appendWithCharCap(
                    accumulatedReasoning,
                    parsed.reasoningDelta,
                    MAX_PERSISTED_REASONING_CHARS,
                );
            }
            isThinkingRef.current = reasoningParserRef.current.inReasoning;
        });

        const unlistenComplete = await streamService.onGenerationComplete(() => {
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
            isThinkingRef.current = false;
            stopFlushTimer();
            setIsGenerating(false);
            finalizeLiveStats();
            if (onComplete) onComplete(accumulatedAnswer, { reasoningText: accumulatedReasoning });
            cleanupListeners();
            showProgress({ message: 'Generation finished', status: 'success' });
            hideProgress(350);
        });

        const unlistenError = await streamService.onGenerationError((event) => {
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
            isThinkingRef.current = false;
            stopFlushTimer();
            setError(event.message);
            setIsGenerating(false);
            finalizeLiveStats();
            // Save partial response if we had any accumulated text
            if (accumulatedAnswer.trim() && onComplete) {
                onComplete(accumulatedAnswer, { reasoningText: accumulatedReasoning });
            }
            cleanupListeners();
            showProgress({ message: 'Generation failed', status: 'failed' });
            hideProgress(600);
        });

        unlistenFns.current = [unlistenToken, unlistenComplete, unlistenError];

        try {
            // Start generation
            await streamService.generateStream(prompt);
        } catch (err: unknown) {
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
            isThinkingRef.current = false;
            stopFlushTimer();
            setError(String(err));
            setIsGenerating(false);
            finalizeLiveStats();
            cleanupListeners();
            showProgress({ message: 'Generation failed', status: 'failed' });
            hideProgress(600);
            // Save partial response on unexpected errors too
            if (accumulatedAnswer.trim() && onComplete) {
                onComplete(accumulatedAnswer, { reasoningText: accumulatedReasoning });
            }
        }
    }, [cleanupListeners, finalizeLiveStats, hideProgress, resetLiveStats, showProgress, startFlushTimer, stopFlushTimer, syncThinkingUiState]);

    const generatePipeline = useCallback(async (
        request: PipelineRunRequest,
        handlers?: PipelineHandlers,
    ) => {
        setIsGenerating(true);
        setCurrentStream('');
        setThinkingStream('');
        syncThinkingUiState(false);
        setError(null);
        setProgressSteps([]);
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
            const parsed = splitReasoningFromSegment(
                event.token,
                reasoningParserRef.current,
                reasoningConfigRef.current,
            );
            if (parsed.answerDelta) {
                accumulatedAnswer += parsed.answerDelta;
                tokenBuffer.current += parsed.answerDelta;
            }
            if (parsed.reasoningDelta) {
                reasoningTokenBuffer.current += parsed.reasoningDelta;
                accumulatedReasoning = appendWithCharCap(
                    accumulatedReasoning,
                    parsed.reasoningDelta,
                    MAX_PERSISTED_REASONING_CHARS,
                );
            }
            isThinkingRef.current = reasoningParserRef.current.inReasoning;
        });

        const unlistenComplete = await streamService.onGenerationComplete(async (event) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
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
            isThinkingRef.current = false;
            stopFlushTimer();
            setIsGenerating(false);
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
            isThinkingRef.current = false;
            stopFlushTimer();
            setError(event.message);
            setIsGenerating(false);
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

        unlistenFns.current = [unlistenToken, unlistenComplete, unlistenError, unlistenProgress];

        try {
            await streamService.runChatPipeline(request);
        } catch (err: unknown) {
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
            isThinkingRef.current = false;
            stopFlushTimer();
            setIsGenerating(false);
            cleanupListeners();
            finalizeLiveStats();
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            showProgress({ message: 'Pipeline failed', status: 'failed', requestId: request.requestId });
            hideProgress(700);
            throw err;
        }
    }, [cleanupListeners, finalizeLiveStats, hideProgress, resetLiveStats, showProgress, startFlushTimer, stopFlushTimer, syncThinkingUiState]);

    const cancel = useCallback(async () => {
        try {
            await streamService.cancelGeneration();
            stopFlushTimer();
            setIsGenerating(false);
            isThinkingRef.current = false;
            syncThinkingUiState(false);
            finalizeLiveStats();
            showProgress({ message: 'Generation cancelled', status: 'fallback' });
            hideProgress(500);
        } catch (err) {
            console.error('Failed to cancel generation:', err);
        }
    }, [finalizeLiveStats, hideProgress, showProgress, stopFlushTimer, syncThinkingUiState]);

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
        generate,
        generatePipeline,
        cancel,
        clearError,
    };
}
