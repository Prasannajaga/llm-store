import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    AgentToolConfirmationEvent,
    StreamCompleteEvent,
    StreamErrorEvent,
    StreamProgressEvent,
    StreamTokenEvent,
} from '../services/streamService';

const { handlers, runChatPipelineMock, submitDecisionMock } = vi.hoisted(() => ({
    handlers: {} as {
        token?: (event: StreamTokenEvent) => void;
        complete?: (event: StreamCompleteEvent) => void;
        error?: (event: StreamErrorEvent) => void;
        progress?: (event: StreamProgressEvent) => void;
        confirm?: (event: AgentToolConfirmationEvent) => void;
    },
    runChatPipelineMock: vi.fn(),
    submitDecisionMock: vi.fn(),
}));

vi.mock('../services/streamService', () => ({
    streamService: {
        generateStream: vi.fn(),
        runChatPipeline: runChatPipelineMock,
        submitAgentToolDecision: submitDecisionMock,
        cancelGeneration: vi.fn(),
        onTokenStream: vi.fn(async (callback: (event: StreamTokenEvent) => void) => {
            handlers.token = callback;
            return () => undefined;
        }),
        onGenerationComplete: vi.fn(async (callback: (event: StreamCompleteEvent) => void) => {
            handlers.complete = callback;
            return () => undefined;
        }),
        onGenerationError: vi.fn(async (callback: (event: StreamErrorEvent) => void) => {
            handlers.error = callback;
            return () => undefined;
        }),
        onPipelineProgress: vi.fn(async (callback: (event: StreamProgressEvent) => void) => {
            handlers.progress = callback;
            return () => undefined;
        }),
        onAgentToolConfirmationRequired: vi.fn(async (callback: (event: AgentToolConfirmationEvent) => void) => {
            handlers.confirm = callback;
            return () => undefined;
        }),
    },
}));

vi.mock('../services/settingsService', () => ({
    settingsService: {
        getReasoningTokenConfig: vi.fn().mockResolvedValue({
            openMarkers: ['<think>'],
            closeMarkers: ['</think>'],
        }),
    },
}));

import { useStreaming } from './useStreaming';

describe('useStreaming agent confirmation lifecycle', () => {
    beforeEach(() => {
        runChatPipelineMock.mockReset();
        submitDecisionMock.mockReset();
        runChatPipelineMock.mockResolvedValue({
            request_id: 'req-agent',
            mode: 'rust_v1',
        });
        handlers.token = undefined;
        handlers.complete = undefined;
        handlers.error = undefined;
        handlers.progress = undefined;
        handlers.confirm = undefined;
    });

    it('stores pending confirmation and submits approval decision', async () => {
        const { result } = renderHook(() => useStreaming());

        await act(async () => {
            await result.current.generatePipeline({
                chatId: 'chat-1',
                prompt: 'run tools',
                selectedDocIds: null,
                requestId: 'req-agent',
                interactionMode: 'agent',
            });
        });

        await act(async () => {
            handlers.confirm?.({
                requestId: 'req-agent',
                actionId: 'action-1',
                tool: 'shell.exec',
                summary: 'Run shell command',
                argsPreview: 'pwd',
                riskLevel: 'confirm',
                expiresAt: '2026-01-01T00:00:00Z',
            });
        });

        expect(result.current.pendingAgentConfirmation?.actionId).toBe('action-1');

        await act(async () => {
            await result.current.approveAgentTool();
        });

        expect(submitDecisionMock).toHaveBeenCalledWith('req-agent', 'action-1', true);
        await waitFor(() => {
            expect(result.current.pendingAgentConfirmation).toBeNull();
        });
    });
});
