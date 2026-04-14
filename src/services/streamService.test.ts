import { describe, expect, it, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
    invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(),
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
