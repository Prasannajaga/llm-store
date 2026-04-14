import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from './ChatInput';
import { useSettingsStore } from '../../store/settingsStore';

vi.mock('../../services/knowledgeService', () => ({
    knowledgeService: {
        listDocuments: vi.fn().mockResolvedValue([]),
    },
}));

describe('ChatInput', () => {
    beforeEach(() => {
        useSettingsStore.setState((state) => ({
            ...state,
            generation: {
                ...state.generation,
                thinkingMode: false,
                agentMode: false,
            },
        }));
    });

    it('submits trimmed prompt on Enter', async () => {
        const onAsk = vi.fn().mockResolvedValue(undefined);
        render(<ChatInput onAsk={onAsk} />);

        const textarea = screen.getByPlaceholderText(/Message LLM/);
        fireEvent.change(textarea, { target: { value: '  hello model  ' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        await waitFor(() => {
            expect(onAsk).toHaveBeenCalledWith('hello model', null);
        });
    });

    it('restores input if submit fails', async () => {
        const onAsk = vi.fn().mockRejectedValue(new Error('network down'));
        render(<ChatInput onAsk={onAsk} />);

        const textarea = screen.getByPlaceholderText(/Message LLM/) as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'retry me' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        await waitFor(() => {
            expect(onAsk).toHaveBeenCalledWith('retry me', null);
        });
        await waitFor(() => {
            expect(textarea.value).toBe('retry me');
        });
    });

    it('keeps agent mode switch available', () => {
        render(<ChatInput onAsk={vi.fn().mockResolvedValue(undefined)} />);

        fireEvent.click(screen.getByRole('button', { name: 'Knowledge & tools' }));

        const agentSwitch = screen.getByRole('switch', { name: 'Agent mode' });
        expect(agentSwitch).toBeEnabled();
    });
});
