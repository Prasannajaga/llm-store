
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { EVENTS } from '../constants';
import { useModelStore } from '../store/modelStore';
import { useSettingsStore } from '../store/settingsStore';

// AbortController to handle cancellation for fetch streams
let currentAbortController: AbortController | null = null;

export const streamService = {
    async generateStream(prompt: string): Promise<void> {
        const modelState = useModelStore.getState();
        const settingsState = useSettingsStore.getState();
        const port = settingsState.llamaServer.port;
        const targetUrl = modelState.useCustomUrl
            ? modelState.customUrl
            : `http://127.0.0.1:${port}/completion`;

        currentAbortController = new AbortController();
        
        // First, quick validation / health check of the URL endpoint
        try {
            // Test reachability first with a short timeout
            const healthCheckCtrl = new AbortController();
            const timeoutId = setTimeout(() => healthCheckCtrl.abort(), 3000);
            
            try {
                await fetch(targetUrl.replace(/\/completion$/, '/health'), {
                    method: 'GET',
                    signal: healthCheckCtrl.signal,
                }).catch(() => {
                    // ignore health check failures, might just not be implemented, but tests dns/connection
                });
            } finally {
                clearTimeout(timeoutId);
            }

            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, stream: true }),
                signal: currentAbortController.signal,
            });

            if (!response.ok) {
                throw new Error(`Connection to URL failed: HTTP ${response.status} ${response.statusText}. Please verify the URL and ensure the model server is running.`);
            }

            if (!response.body) {
                throw new Error('No response body received from server.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let done = false;

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) {
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n').filter(line => line.trim() !== '');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.replace('data: ', '');
                            if (dataStr === '[DONE]') {
                                break;
                            }
                            try {
                                const parsed = JSON.parse(dataStr);
                                if (parsed.content) {
                                    emit(EVENTS.TOKEN_STREAM, parsed.content);
                                }
                                // Check if generation was stopped by the server
                                if (parsed.stop === true && parsed.stopped_word) {
                                    break;
                                }
                            } catch {
                                console.warn('Failed to parse chunk data', dataStr);
                            }
                        }
                    }
                }
            }
            emit(EVENTS.GENERATION_COMPLETE, "DONE");
        } catch (error: unknown) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.info('Generation cancelled by user');
                emit(EVENTS.GENERATION_COMPLETE, "CANCELLED");
            } else if (error instanceof TypeError && error.message.includes('fetch')) {
                const isLocal = targetUrl.includes('127.0.0.1') || targetUrl.includes('localhost');
                const msg = isLocal 
                    ? `Failed to communicate with the model server. It appears the model is not running. Please ensure a model is selected and loaded successfully.`
                    : `Failed to connect to ${targetUrl}. The server might be offline, unreachable, or CORS is not enabled.`;
                emit(EVENTS.GENERATION_ERROR, msg);
            } else if (error instanceof Error) {
                emit(EVENTS.GENERATION_ERROR, `Generation stopped: ${error.message}`);
            } else {
                emit(EVENTS.GENERATION_ERROR, `Generation stopped unexpectedly: ${String(error)}`);
            }
        } finally {
            currentAbortController = null;
        }
    },

    async cancelGeneration(): Promise<void> {
        if (currentAbortController) {
            currentAbortController.abort();
        }
    },

    async onTokenStream(callback: (token: string) => void): Promise<UnlistenFn> {
        return listen<string>(EVENTS.TOKEN_STREAM, (event) => {
            callback(event.payload);
        });
    },

    async onGenerationComplete(callback: () => void): Promise<UnlistenFn> {
        return listen(EVENTS.GENERATION_COMPLETE, () => {
            callback();
        });
    },

    async onGenerationError(callback: (error: string) => void): Promise<UnlistenFn> {
        return listen<string>(EVENTS.GENERATION_ERROR, (event) => {
            callback(event.payload);
        });
    },
};
