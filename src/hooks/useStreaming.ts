import { useState, useCallback, useRef, useEffect } from 'react';
import { streamService } from '../services/streamService';
import type { UnlistenFn } from '@tauri-apps/api/event';

export function useStreaming() {
    const [isGenerating, setIsGenerating] = useState(false);
    const [currentStream, setCurrentStream] = useState('');
    const [error, setError] = useState<string | null>(null);
    const unlistenFns = useRef<UnlistenFn[]>([]);

    // Cleanup listeners on unmount
    useEffect(() => {
        return () => {
            unlistenFns.current.forEach((fn) => fn());
            unlistenFns.current = [];
        };
    }, []);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    const generate = useCallback(async (prompt: string, onComplete?: (fullText: string) => void) => {
        setIsGenerating(true);
        setCurrentStream('');
        setError(null);

        let accumulatedText = '';

        try {
            // Set up listeners
            const unlistenToken = await streamService.onTokenStream((token) => {
                accumulatedText += token;
                setCurrentStream((prev) => prev + token);
            });

            const unlistenComplete = await streamService.onGenerationComplete(() => {
                setIsGenerating(false);
                if (onComplete) onComplete(accumulatedText);
                // Clean up immediately for this generation
                unlistenToken();
                unlistenComplete();
                unlistenError();
            });

            const unlistenError = await streamService.onGenerationError((err) => {
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
            setError(String(err));
            setIsGenerating(false);
            // Save partial response on unexpected errors too
            if (accumulatedText.trim() && onComplete) {
                onComplete(accumulatedText);
            }
        }
    }, []);

    const cancel = useCallback(async () => {
        try {
            await streamService.cancelGeneration();
            setIsGenerating(false);
        } catch (err) {
            console.error('Failed to cancel generation:', err);
        }
    }, []);

    return {
        isGenerating,
        currentStream,
        error,
        generate,
        cancel,
        clearError,
    };
}
