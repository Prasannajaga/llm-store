import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInput } from './ChatInput';

describe('ChatInput', () => {
    it('submits trimmed prompt on Enter', async () => {
        const onAsk = vi.fn().mockResolvedValue(undefined);
        render(<ChatInput onAsk={onAsk} />);

        const textarea = screen.getByPlaceholderText('Message LLM...');
        fireEvent.change(textarea, { target: { value: '  hello model  ' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        await waitFor(() => {
            expect(onAsk).toHaveBeenCalledWith('hello model');
        });
    });

    it('restores input if submit fails', async () => {
        const onAsk = vi.fn().mockRejectedValue(new Error('network down'));
        render(<ChatInput onAsk={onAsk} />);

        const textarea = screen.getByPlaceholderText('Message LLM...') as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'retry me' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        await waitFor(() => {
            expect(onAsk).toHaveBeenCalledWith('retry me');
        });
        await waitFor(() => {
            expect(textarea.value).toBe('retry me');
        });
    });
});
