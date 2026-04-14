import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { EVENTS } from '../constants';
import type { InteractionMode } from '../types';

export interface PipelineRunRequest {
    chatId: string;
    prompt: string;
    selectedDocIds: string[] | null;
    requestId: string;
    interactionMode?: InteractionMode;
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
    contextPayload?: string;
}

export interface StreamErrorEvent {
    message: string;
    requestId?: string;
    code?: string;
    layer?: string;
}

export type ProgressStatus = 'started' | 'success' | 'fallback' | 'failed';

export interface StreamProgressEvent {
    message: string;
    requestId?: string;
    layer?: string;
    status?: ProgressStatus;
}

export type AgentToolRiskLevel = 'safe' | 'confirm' | 'high';

export interface AgentToolConfirmationEvent {
    requestId: string;
    actionId: string;
    tool: string;
    summary: string;
    argsPreview: string;
    riskLevel: AgentToolRiskLevel;
    expiresAt?: string;
}

export const streamService = {
    async runChatPipeline(request: PipelineRunRequest): Promise<PipelineRunAck> {
        return invoke('run_chat_pipeline', {
            request: {
                chat_id: request.chatId,
                prompt: request.prompt,
                selected_doc_ids: request.selectedDocIds,
                request_id: request.requestId,
                interaction_mode: request.interactionMode ?? 'chat',
            },
        });
    },

    async submitAgentToolDecision(requestId: string, actionId: string, approved: boolean): Promise<void> {
        return invoke('submit_agent_tool_decision', {
            requestId,
            actionId,
            approved,
        });
    },

    async cancelGeneration(): Promise<void> {
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

    async onPipelineProgress(callback: (event: StreamProgressEvent) => void): Promise<UnlistenFn> {
        return listen<unknown>(EVENTS.PIPELINE_PROGRESS, (event) => {
            callback(normalizeProgressPayload(event.payload));
        });
    },

    async onAgentToolConfirmationRequired(
        callback: (event: AgentToolConfirmationEvent) => void,
    ): Promise<UnlistenFn> {
        return listen<unknown>(EVENTS.AGENT_TOOL_CONFIRMATION_REQUIRED, (event) => {
            const payload = normalizeAgentToolConfirmationPayload(event.payload);
            if (!payload) {
                return;
            }
            callback(payload);
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
            contextPayload: readString(payload.context_payload),
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

function normalizeProgressPayload(payload: unknown): StreamProgressEvent {
    if (typeof payload === 'string') {
        return { message: payload };
    }

    if (isObject(payload)) {
        const status = readString(payload.status) as ProgressStatus | undefined;
        return {
            message: readString(payload.message) ?? 'Processing...',
            requestId: readString(payload.request_id),
            layer: readString(payload.layer),
            status,
        };
    }

    return { message: 'Processing...' };
}

function normalizeAgentToolConfirmationPayload(payload: unknown): AgentToolConfirmationEvent | null {
    if (!isObject(payload)) {
        return null;
    }

    const requestId = readString(payload.request_id) ?? readString(payload.requestId);
    const actionId = readString(payload.action_id) ?? readString(payload.actionId);
    const tool = readString(payload.tool);
    const summary = readString(payload.summary);
    const argsPreview = readString(payload.args_preview) ?? readString(payload.argsPreview) ?? '';
    const riskLevelRaw = readString(payload.risk_level) ?? readString(payload.riskLevel);
    const expiresAt = readString(payload.expires_at) ?? readString(payload.expiresAt);

    if (!requestId || !actionId || !tool || !summary) {
        return null;
    }

    const normalizedRiskLevel: AgentToolRiskLevel = riskLevelRaw === 'high'
        ? 'high'
        : riskLevelRaw === 'confirm'
            ? 'confirm'
            : 'safe';

    return {
        requestId,
        actionId,
        tool,
        summary,
        argsPreview,
        riskLevel: normalizedRiskLevel,
        expiresAt: expiresAt ?? undefined,
    };
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
