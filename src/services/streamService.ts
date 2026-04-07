import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { EVENTS } from '../constants';
import { useModelStore } from '../store/modelStore';
import { useSettingsStore } from '../store/settingsStore';
import { extractSsePayloads } from './sseParser';

// AbortController to handle cancellation for fetch streams
let currentAbortController: AbortController | null = null;
// Reusable TextDecoder — avoids re-allocation per stream
const STREAM_DECODER = new TextDecoder('utf-8');

export interface PipelineRunRequest {
    chatId: string;
    prompt: string;
    selectedDocIds: string[] | null;
    requestId: string;
}

export interface PipelineRunAck {
    request_id: string;
    mode: string;
}

export interface StreamTokenEvent {
    token: string;
    requestId?: string;
}

export interface StreamCompleteEvent {
    requestId?: string;
    finishReason?: string;
    retrievedCount?: number;
    dedupedCount?: number;
}

export interface StreamErrorEvent {
    message: string;
    requestId?: string;
    code?: string;
    layer?: string;
}

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
                body: JSON.stringify({
                    prompt,
                    stream: true,
                    // Generation parameters from user settings — llama.cpp /completion API
                    n_predict: settingsState.generation.maxTokens,
                    temperature: settingsState.generation.temperature,
                    top_p: settingsState.generation.topP,
                    top_k: settingsState.generation.topK,
                    repeat_penalty: settingsState.generation.repeatPenalty,
                }),
                signal: currentAbortController.signal,
            });

            if (!response.ok) {
                throw new Error(`Connection to URL failed: HTTP ${response.status} ${response.statusText}. Please verify the URL and ensure the model server is running.`);
            }

            if (!response.body) {
                throw new Error('No response body received from server.');
            }

            const reader = response.body.getReader();
            let done = false;
            let sseBuffer = '';

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) {
                    sseBuffer += STREAM_DECODER.decode(value, { stream: true });
                    const { payloads, remainder } = extractSsePayloads(sseBuffer);
                    sseBuffer = remainder;

                    for (const dataStr of payloads) {
                        if (dataStr === '[DONE]') {
                            done = true;
                            break;
                        }
                        try {
                            const parsed = JSON.parse(dataStr);
                            if (parsed.content) {
                                await emit(EVENTS.TOKEN_STREAM, parsed.content);
                            }
                            // Check if generation was stopped by the server for any reason:
                            // - stopped_word: stop token was generated
                            // - stopped_limit: n_predict (max tokens) limit reached
                            // - stopped_eos: end-of-sequence token generated
                            if (parsed.stop === true) {
                                done = true;
                                break;
                            }
                        } catch {
                            console.warn('Failed to parse chunk data', dataStr);
                        }
                    }
                }
            }

            // Flush decoder state and process any final complete SSE event.
            sseBuffer += STREAM_DECODER.decode();
            const { payloads: trailingPayloads } = extractSsePayloads(`${sseBuffer}\n\n`);
            for (const dataStr of trailingPayloads) {
                if (dataStr === '[DONE]') break;
                try {
                    const parsed = JSON.parse(dataStr);
                    if (parsed.content) {
                        await emit(EVENTS.TOKEN_STREAM, parsed.content);
                    }
                } catch {
                    console.warn('Failed to parse trailing chunk data', dataStr);
                }
            }

            await emit(EVENTS.GENERATION_COMPLETE, 'DONE');
        } catch (error: unknown) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.info('Generation cancelled by user');
                await emit(EVENTS.GENERATION_COMPLETE, 'CANCELLED');
            } else if (error instanceof TypeError && error.message.includes('fetch')) {
                const isLocal = targetUrl.includes('127.0.0.1') || targetUrl.includes('localhost');
                const msg = isLocal
                    ? 'Failed to communicate with the model server. It appears the model is not running. Please ensure a model is selected and loaded successfully.'
                    : `Failed to connect to ${targetUrl}. The server might be offline, unreachable, or CORS is not enabled.`;
                await emit(EVENTS.GENERATION_ERROR, msg);
            } else if (error instanceof Error) {
                await emit(EVENTS.GENERATION_ERROR, `Generation stopped: ${error.message}`);
            } else {
                await emit(EVENTS.GENERATION_ERROR, `Generation stopped unexpectedly: ${String(error)}`);
            }
        } finally {
            currentAbortController = null;
        }
    },

    async runChatPipeline(request: PipelineRunRequest): Promise<PipelineRunAck> {
        return invoke('run_chat_pipeline', {
            request: {
                chat_id: request.chatId,
                prompt: request.prompt,
                selected_doc_ids: request.selectedDocIds,
                request_id: request.requestId,
            },
        });
    },

    async cancelGeneration(): Promise<void> {
        if (currentAbortController) {
            currentAbortController.abort();
        }
        await invoke('cancel_generation').catch(() => undefined);
    },

    async onTokenStream(callback: (event: StreamTokenEvent) => void): Promise<UnlistenFn> {
        return listen<unknown>(EVENTS.TOKEN_STREAM, (event) => {
            callback(normalizeTokenPayload(event.payload));
        });
    },

    async onGenerationComplete(callback: (event: StreamCompleteEvent) => void): Promise<UnlistenFn> {
        return listen<unknown>(EVENTS.GENERATION_COMPLETE, (event) => {
            callback(normalizeCompletePayload(event.payload));
        });
    },

    async onGenerationError(callback: (event: StreamErrorEvent) => void): Promise<UnlistenFn> {
        return listen<unknown>(EVENTS.GENERATION_ERROR, (event) => {
            callback(normalizeErrorPayload(event.payload));
        });
    },
};

function normalizeTokenPayload(payload: unknown): StreamTokenEvent {
    if (typeof payload === 'string') {
        return { token: payload };
    }

    if (isObject(payload)) {
        const requestId = readString(payload.request_id);
        const token = readString(payload.token) ?? '';
        return { token, requestId };
    }

    return { token: '' };
}

function normalizeCompletePayload(payload: unknown): StreamCompleteEvent {
    if (typeof payload === 'string') {
        return {
            finishReason: payload.toLowerCase(),
        };
    }

    if (isObject(payload)) {
        return {
            requestId: readString(payload.request_id),
            finishReason: readString(payload.finish_reason),
            retrievedCount: readNumber(payload.retrieved_count),
            dedupedCount: readNumber(payload.deduped_count),
        };
    }

    return {};
}

function normalizeErrorPayload(payload: unknown): StreamErrorEvent {
    if (typeof payload === 'string') {
        return { message: payload };
    }

    if (isObject(payload)) {
        return {
            message: readString(payload.user_safe_message) ?? 'Unable to complete generation.',
            requestId: readString(payload.request_id),
            code: readString(payload.code),
            layer: readString(payload.layer),
        };
    }

    return { message: 'Unable to complete generation.' };
}

function isObject(payload: unknown): payload is Record<string, unknown> {
    return typeof payload === 'object' && payload !== null;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

