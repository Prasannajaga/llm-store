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

    it('stores queued confirmations and submits enum approval decisions', async () => {
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
                expiresAt: '2099-01-01T00:00:00Z',
            });
            handlers.confirm?.({
                requestId: 'req-agent',
                actionId: 'action-2',
                tool: 'fs.write',
                summary: 'Write file',
                argsPreview: 'path=/tmp/a',
                riskLevel: 'high',
                expiresAt: '2099-01-01T00:00:00Z',
            });
        });

        expect(result.current.pendingAgentConfirmation?.actionId).toBe('action-1');

        await act(async () => {
            await result.current.approveAgentToolAlways();
        });

        expect(submitDecisionMock).toHaveBeenCalledWith(
            'req-agent',
            'action-1',
            'approve_always',
            true,
        );
        expect(result.current.pendingAgentConfirmation?.actionId).toBe('action-2');

        await act(async () => {
            await result.current.denyAgentTool();
        });

        expect(submitDecisionMock).toHaveBeenCalledWith(
            'req-agent',
            'action-2',
            'deny',
            false,
        );
        await waitFor(() => {
            expect(result.current.pendingAgentConfirmation).toBeNull();
        });
    });

    it('skips expired queued confirmations and submits the next valid one', async () => {
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
                actionId: 'expired-action',
                tool: 'fs.read',
                summary: 'Read file',
                argsPreview: '{"path":"./notes.txt"}',
                riskLevel: 'safe',
                expiresAt: '2000-01-01T00:00:00Z',
            });
            handlers.confirm?.({
                requestId: 'req-agent',
                actionId: 'valid-action',
                tool: 'fs.write',
                summary: 'Write file',
                argsPreview: '{"path":"./notes.txt","content":"hi"}',
                riskLevel: 'high',
                expiresAt: '2099-01-01T00:00:00Z',
            });
        });

        await act(async () => {
            await result.current.approveAgentToolOnce();
        });

        expect(submitDecisionMock).toHaveBeenCalledWith(
            'req-agent',
            'valid-action',
            'approve_once',
            true,
        );
    });

    it('ignores already-expired confirmation events', async () => {
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
                actionId: 'expired-action',
                tool: 'fs.read',
                summary: 'Read file',
                argsPreview: '{"path":"./notes.txt"}',
                riskLevel: 'safe',
                expiresAt: '2000-01-01T00:00:00Z',
            });
        });

        expect(result.current.pendingAgentConfirmation).toBeNull();
    });

    it('records ordered progress steps with rich metadata for the UI timeline', async () => {
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
            handlers.progress?.({
                requestId: 'req-agent',
                layer: 'agent_loop',
                status: 'started',
                activityKind: 'analyzing',
                message: 'Analyzing next action...',
                step: 1,
            });
            handlers.progress?.({
                requestId: 'req-agent',
                layer: 'agent_loop',
                status: 'started',
                activityKind: 'tool',
                tool: 'fs.read',
                callId: 'call-1',
                displayTarget: 'cli.txt',
                message: 'Reading file cli.txt...',
                step: 1,
            });
            handlers.progress?.({
                requestId: 'req-agent',
                layer: 'agent_loop',
                status: 'success',
                activityKind: 'tool',
                tool: 'fs.read',
                callId: 'call-1',
                displayTarget: 'cli.txt',
                message: 'Finished reading file cli.txt',
                step: 1,
            });
            handlers.progress?.({
                requestId: 'req-agent',
                layer: 'agent_loop',
                status: 'success',
                activityKind: 'tool',
                tool: 'fs.read',
                callId: 'call-1',
                displayTarget: 'cli.txt',
                message: 'Finished reading file cli.txt',
                step: 1,
            });
            handlers.progress?.({
                requestId: 'req-agent',
                layer: 'agent_loop',
                status: 'failed',
                activityKind: 'tool',
                tool: 'fs.write',
                callId: 'call-2',
                displayTarget: 'notes.md',
                message: 'File write failed',
                step: 2,
            });
            handlers.progress?.({
                requestId: 'req-agent',
                layer: 'agent_loop',
                status: 'fallback',
                activityKind: 'tool',
                tool: 'shell.exec',
                callId: 'call-3',
                message: 'Action was denied',
                step: 3,
            });
            handlers.progress?.({
                requestId: 'req-agent',
                layer: 'agent_loop',
                status: 'success',
                activityKind: 'tool',
                tool: 'knowledge.search',
                callId: 'call-4',
                message: 'Knowledge search finished',
                step: 4,
            });
        });

        expect(result.current.progressSteps).toHaveLength(6);
        expect(result.current.progressSteps[1]).toMatchObject({
            activityKind: 'analyzing',
            message: 'Analyzing next action...',
            step: 1,
        });
        expect(result.current.progressSteps[2]).toMatchObject({
            activityKind: 'tool',
            tool: 'fs.read',
            callId: 'call-1',
            displayTarget: 'cli.txt',
            message: 'Finished reading file cli.txt',
            status: 'success',
        });
        expect(result.current.progressSteps[4]).toMatchObject({
            activityKind: 'tool',
            tool: 'shell.exec',
            message: 'Action was denied',
            status: 'fallback',
        });
        expect(result.current.progressSteps[5]).toMatchObject({
            activityKind: 'tool',
            tool: 'knowledge.search',
            message: 'Knowledge search finished',
            status: 'success',
        });
        expect(result.current.progress).toMatchObject({
            message: 'Knowledge search finished',
            status: 'success',
        });
    });
});
