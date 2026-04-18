import { describe, expect, it, vi, beforeEach } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
    listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: listenMock,
    emit: vi.fn(),
}));

vi.mock('../store/modelStore', () => ({
    useModelStore: {
        getState: () => ({
            useCustomUrl: false,
            customUrl: 'http://localhost:8080/completion',
            customApiKey: '',
        }),
    },
}));

vi.mock('../store/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({
            llamaServer: { port: 8080 },
            generation: {
                maxTokens: 256,
                temperature: 0.7,
                topP: 0.9,
                topK: 40,
                repeatPenalty: 1.1,
            },
        }),
    },
}));

import { streamService } from './streamService';

describe('streamService.runChatPipeline', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValue({ request_id: 'req-1', mode: 'rust_v1' });
    });

    it('sends chat interaction mode by default', async () => {
        await streamService.runChatPipeline({
            chatId: 'chat-1',
            prompt: 'hello',
            selectedDocIds: null,
            requestId: 'req-1',
        });

        expect(invokeMock).toHaveBeenCalledWith('run_chat_pipeline', {
            request: {
                chat_id: 'chat-1',
                prompt: 'hello',
                selected_doc_ids: null,
                request_id: 'req-1',
                interaction_mode: 'chat',
            },
        });
    });

    it('sends agent interaction mode when requested', async () => {
        await streamService.runChatPipeline({
            chatId: 'chat-1',
            prompt: 'hello',
            selectedDocIds: ['doc-1'],
            requestId: 'req-2',
            interactionMode: 'agent',
        });

        expect(invokeMock).toHaveBeenCalledWith('run_chat_pipeline', {
            request: {
                chat_id: 'chat-1',
                prompt: 'hello',
                selected_doc_ids: ['doc-1'],
                request_id: 'req-2',
                interaction_mode: 'agent',
            },
        });
    });
});

describe('streamService.submitAgentToolDecision', () => {
    beforeEach(() => {
        invokeMock.mockReset();
        invokeMock.mockResolvedValue(undefined);
    });

    it('sends enum decision payload with optional legacy boolean', async () => {
        await streamService.submitAgentToolDecision(
            'req-1',
            'action-1',
            'approve_once',
            true,
        );

        expect(invokeMock).toHaveBeenCalledWith('submit_agent_tool_decision', {
            requestId: 'req-1',
            actionId: 'action-1',
            decision: 'approve_once',
            approved: true,
        });
    });

    it('retries with snake_case args when the first invoke fails', async () => {
        invokeMock
            .mockRejectedValueOnce(new Error('arg mapping failed'))
            .mockResolvedValueOnce(undefined);

        await streamService.submitAgentToolDecision(
            'req-2',
            'action-2',
            'approve_always',
            undefined,
        );

        expect(invokeMock).toHaveBeenNthCalledWith(1, 'submit_agent_tool_decision', {
            requestId: 'req-2',
            actionId: 'action-2',
            decision: 'approve_always',
            approved: true,
        });
        expect(invokeMock).toHaveBeenNthCalledWith(2, 'submit_agent_tool_decision', {
            request_id: 'req-2',
            action_id: 'action-2',
            decision: 'approve_always',
            approved: true,
        });
    });

    it('falls back to legacy approved-only payload when decision parsing fails', async () => {
        invokeMock
            .mockRejectedValueOnce(new Error('decision parse failed'))
            .mockRejectedValueOnce(new Error('decision parse failed (snake_case)'))
            .mockResolvedValueOnce(undefined);

        await streamService.submitAgentToolDecision(
            'req-legacy',
            'action-legacy',
            'approve_once',
            true,
        );

        expect(invokeMock).toHaveBeenNthCalledWith(1, 'submit_agent_tool_decision', {
            requestId: 'req-legacy',
            actionId: 'action-legacy',
            decision: 'approve_once',
            approved: true,
        });
        expect(invokeMock).toHaveBeenNthCalledWith(2, 'submit_agent_tool_decision', {
            request_id: 'req-legacy',
            action_id: 'action-legacy',
            decision: 'approve_once',
            approved: true,
        });
        expect(invokeMock).toHaveBeenNthCalledWith(3, 'submit_agent_tool_decision', {
            requestId: 'req-legacy',
            actionId: 'action-legacy',
            approved: true,
        });
    });
});

describe('streamService.onPipelineProgress', () => {
    beforeEach(() => {
        listenMock.mockReset();
    });

    it('normalizes extended progress metadata payload', async () => {
        let received: unknown;
        listenMock.mockImplementation(async (_eventName: string, callback: (event: { payload: unknown }) => void) => {
            callback({
                payload: {
                    request_id: 'req-1',
                    layer: 'agent_loop',
                    status: 'started',
                    message: 'Reading file cli.txt...',
                    activity_kind: 'tool',
                    tool: 'fs.read',
                    step: 2,
                    call_id: 'call-1',
                    display_target: 'cli.txt',
                },
            });
            return () => undefined;
        });

        await streamService.onPipelineProgress((event) => {
            received = event;
        });

        expect(received).toEqual({
            requestId: 'req-1',
            layer: 'agent_loop',
            status: 'started',
            message: 'Reading file cli.txt...',
            activityKind: 'tool',
            tool: 'fs.read',
            step: 2,
            callId: 'call-1',
            displayTarget: 'cli.txt',
        });
    });

    it('keeps legacy payloads compatible without metadata', async () => {
        let received: unknown;
        listenMock.mockImplementation(async (_eventName: string, callback: (event: { payload: unknown }) => void) => {
            callback({
                payload: {
                    request_id: 'req-legacy',
                    layer: 'prompt_build',
                    status: 'success',
                    message: 'Prompt ready',
                },
            });
            return () => undefined;
        });

        await streamService.onPipelineProgress((event) => {
            received = event;
        });

        expect(received).toEqual({
            requestId: 'req-legacy',
            layer: 'prompt_build',
            status: 'success',
            message: 'Prompt ready',
            activityKind: undefined,
            tool: undefined,
            step: undefined,
            callId: undefined,
            displayTarget: undefined,
        });
    });
});

describe('streamService.onAgentToolConfirmationRequired', () => {
    beforeEach(() => {
        listenMock.mockReset();
    });

    it('normalizes extended filesystem confirmation context payload', async () => {
        let received: unknown;
        listenMock.mockImplementation(async (_eventName: string, callback: (event: { payload: unknown }) => void) => {
            callback({
                payload: {
                    request_id: 'req-1',
                    action_id: 'act-1',
                    tool: 'fs.read',
                    summary: 'Read file: /tmp/demo.txt',
                    args_preview: '{"path":"/tmp/demo.txt"}',
                    risk_level: 'safe',
                    requested_path: '/tmp/demo.txt',
                    root_candidate: '/tmp',
                    outside_trusted_roots: true,
                },
            });
            return () => undefined;
        });

        await streamService.onAgentToolConfirmationRequired((event) => {
            received = event;
        });

        expect(received).toEqual({
            requestId: 'req-1',
            actionId: 'act-1',
            tool: 'fs.read',
            summary: 'Read file: /tmp/demo.txt',
            argsPreview: '{"path":"/tmp/demo.txt"}',
            riskLevel: 'safe',
            expiresAt: undefined,
            pattern: undefined,
            matchTarget: undefined,
            requestedPath: '/tmp/demo.txt',
            rootCandidate: '/tmp',
            outsideTrustedRoots: true,
        });
    });
});
