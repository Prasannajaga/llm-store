import { useState, useCallback, useRef, useEffect } from 'react';
import { streamService } from '../services/streamService';
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Batching interval (ms) for stream token updates.
 * Tokens accumulate in a ref and flush to React state at this cadence,
 * preventing a full re-render for every single token arrival.
 */
const STREAM_FLUSH_INTERVAL_MS = 32; // ~2 frames at 60fps

export function useStreaming() {
    const [isGenerating, setIsGenerating] = useState(false);
    const [currentStream, setCurrentStream] = useState('');
    const [error, setError] = useState<string | null>(null);
    const unlistenFns = useRef<UnlistenFn[]>([]);

    // Buffer for accumulating tokens between flush cycles
    const tokenBuffer = useRef('');
    const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Cleanup listeners on unmount
    useEffect(() => {
        return () => {
            unlistenFns.current.forEach((fn) => fn());
            unlistenFns.current = [];
            if (flushTimerRef.current) {
                clearInterval(flushTimerRef.current);
                flushTimerRef.current = null;
            }
        };
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

        let accumulatedText = '';

        try {
            startFlushTimer();

            // Set up listeners
            const unlistenToken = await streamService.onTokenStream((token) => {
                accumulatedText += token;
                // Buffer tokens instead of immediately calling setState
                tokenBuffer.current += token;
            });

            const unlistenComplete = await streamService.onGenerationComplete(() => {
                stopFlushTimer();
                setIsGenerating(false);
                if (onComplete) onComplete(accumulatedText);
                // Clean up immediately for this generation
                unlistenToken();
                unlistenComplete();
                unlistenError();
            });

            const unlistenError = await streamService.onGenerationError((err) => {
                stopFlushTimer();
                setError(err);
                setIsGenerating(false);
                // Save partial response if we had any accumulated text
                if (accumulatedText.trim() && onComplete) {
                    onComplete(accumulatedText);
                }
                unlistenToken();
                unlistenComplete();
                unlistenError();
            });

            unlistenFns.current = [unlistenToken, unlistenComplete, unlistenError];

            // Start generation
            await streamService.generateStream(prompt);
        } catch (err: unknown) {
            stopFlushTimer();
            setError(String(err));
            setIsGenerating(false);
            // Save partial response on unexpected errors too
            if (accumulatedText.trim() && onComplete) {
                onComplete(accumulatedText);
            }
        }
    }, [startFlushTimer, stopFlushTimer]);

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
        cancel,
        clearError,
    };
}
