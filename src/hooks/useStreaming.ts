import { useState, useCallback, useRef, useEffect } from 'react';
import { streamService, type PipelineRunRequest, type StreamCompleteEvent, type StreamErrorEvent, type StreamTokenEvent } from '../services/streamService';
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Batching interval (ms) for stream token updates.
 * Tokens accumulate in a ref and flush to React state at this cadence,
 * preventing a full re-render for every single token arrival.
 */
const STREAM_FLUSH_INTERVAL_MS = 32; // ~2 frames at 60fps

interface PipelineHandlers {
    onComplete?: (fullText: string, event: StreamCompleteEvent) => void | Promise<void>;
    onRuntimeError?: (event: StreamErrorEvent) => void | Promise<void>;
}

export function useStreaming() {
    const [isGenerating, setIsGenerating] = useState(false);
    const [currentStream, setCurrentStream] = useState('');
    const [error, setError] = useState<string | null>(null);
    const unlistenFns = useRef<UnlistenFn[]>([]);
    const activeRequestId = useRef<string | null>(null);

    // Buffer for accumulating tokens between flush cycles
    const tokenBuffer = useRef('');
    const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const cleanupListeners = useCallback(() => {
        unlistenFns.current.forEach((fn) => fn());
        unlistenFns.current = [];
    }, []);

    // Cleanup listeners on unmount
    useEffect(() => {
        return () => {
            cleanupListeners();
            if (flushTimerRef.current) {
                clearInterval(flushTimerRef.current);
                flushTimerRef.current = null;
            }
        };
    }, [cleanupListeners]);

    /** Flush buffered tokens to React state in a single setState call. */
    const startFlushTimer = useCallback(() => {
        if (flushTimerRef.current) return;
        flushTimerRef.current = setInterval(() => {
            if (tokenBuffer.current.length > 0) {
                const batch = tokenBuffer.current;
                tokenBuffer.current = '';
                setCurrentStream((prev) => prev + batch);
            }
        }, STREAM_FLUSH_INTERVAL_MS);
    }, []);

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
    }, []);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    const generate = useCallback(async (prompt: string, onComplete?: (fullText: string) => void) => {
        setIsGenerating(true);
        setCurrentStream('');
        setError(null);
        tokenBuffer.current = '';
        activeRequestId.current = null;

        let accumulatedText = '';
        startFlushTimer();
        cleanupListeners();

        const unlistenToken = await streamService.onTokenStream((event: StreamTokenEvent) => {
            if (event.requestId && event.requestId !== activeRequestId.current) {
                return;
            }
            accumulatedText += event.token;
            // Buffer tokens instead of immediately calling setState
            tokenBuffer.current += event.token;
        });

        const unlistenComplete = await streamService.onGenerationComplete(() => {
            stopFlushTimer();
            setIsGenerating(false);
            if (onComplete) onComplete(accumulatedText);
            cleanupListeners();
        });

        const unlistenError = await streamService.onGenerationError((event) => {
            stopFlushTimer();
            setError(event.message);
            setIsGenerating(false);
            // Save partial response if we had any accumulated text
            if (accumulatedText.trim() && onComplete) {
                onComplete(accumulatedText);
            }
            cleanupListeners();
        });

        unlistenFns.current = [unlistenToken, unlistenComplete, unlistenError];

        try {
            // Start generation
            await streamService.generateStream(prompt);
        } catch (err: unknown) {
            stopFlushTimer();
            setError(String(err));
            setIsGenerating(false);
            cleanupListeners();
            // Save partial response on unexpected errors too
            if (accumulatedText.trim() && onComplete) {
                onComplete(accumulatedText);
            }
        }
    }, [cleanupListeners, startFlushTimer, stopFlushTimer]);

    const generatePipeline = useCallback(async (
        request: PipelineRunRequest,
        handlers?: PipelineHandlers,
    ) => {
        setIsGenerating(true);
        setCurrentStream('');
        setError(null);
        tokenBuffer.current = '';
        activeRequestId.current = request.requestId;

        let accumulatedText = '';
        startFlushTimer();
        cleanupListeners();

        const unlistenToken = await streamService.onTokenStream((event: StreamTokenEvent) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
            accumulatedText += event.token;
            tokenBuffer.current += event.token;
        });

        const unlistenComplete = await streamService.onGenerationComplete(async (event) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
            stopFlushTimer();
            setIsGenerating(false);
            cleanupListeners();
            await handlers?.onComplete?.(accumulatedText, event);
        });

        const unlistenError = await streamService.onGenerationError(async (event) => {
            if (event.requestId && event.requestId !== request.requestId) {
                return;
            }
            stopFlushTimer();
            setError(event.message);
            setIsGenerating(false);
            cleanupListeners();
            await handlers?.onRuntimeError?.(event);
        });

        unlistenFns.current = [unlistenToken, unlistenComplete, unlistenError];

        try {
            await streamService.runChatPipeline(request);
        } catch (err: unknown) {
            stopFlushTimer();
            setIsGenerating(false);
            cleanupListeners();
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
    }, [cleanupListeners, startFlushTimer, stopFlushTimer]);

    const cancel = useCallback(async () => {
        try {
            await streamService.cancelGeneration();
            stopFlushTimer();
            setIsGenerating(false);
        } catch (err) {
            console.error('Failed to cancel generation:', err);
        }
    }, [stopFlushTimer]);

    return {
        isGenerating,
        currentStream,
        error,
        generate,
        generatePipeline,
        cancel,
        clearError,
    };
}

