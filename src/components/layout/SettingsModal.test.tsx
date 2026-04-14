import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { useSettingsStore } from '../../store/settingsStore';

vi.mock('../../store/settingsStore', () => ({
    useSettingsStore: vi.fn(),
}));

const mockApplySettings = vi.fn().mockResolvedValue(undefined);
const mockResetDefaults = vi.fn().mockResolvedValue(undefined);

describe('SettingsModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(useSettingsStore).mockReturnValue({
            llamaServer: {
                executablePath: 'llama-server',
                port: 8080,
                contextSize: 2048,
                gpuLayers: 0,
                threads: 8,
                batchSize: 256,
            },
            generation: {
                maxTokens: 1024,
                temperature: 0.7,
                topP: 0.9,
                topK: 40,
                repeatPenalty: 1.1,
                thinkingMode: false,
                agentMode: false,
                maxContextChars: 15000,
                maxPromptChars: 32000,
            },
            llamaPreset: 'cpu_optimized',
            applySettings: mockApplySettings,
            resetLlamaServerDefaults: mockResetDefaults,
            isSaving: false,
        } as never);
    });

    it('toggles thinking switch and submits updated draft values', async () => {
        render(<SettingsModal onClose={() => {}} />);

        const executableInput = screen.getByRole('textbox', { name: 'Executable Path' }) as HTMLInputElement;
        fireEvent.change(executableInput, { target: { value: '/usr/local/bin/llama' } });
        expect(executableInput.value).toBe('/usr/local/bin/llama');

        const thinkingSwitch = screen.getByRole('switch', { name: 'Thinking Mode' });
        expect(thinkingSwitch).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(thinkingSwitch);
        expect(thinkingSwitch).toHaveAttribute('aria-checked', 'true');

        fireEvent.click(screen.getByRole('button', { name: /apply/i }));

        await waitFor(() => {
            expect(mockApplySettings).toHaveBeenCalledTimes(1);
        });
        const [draft] = mockApplySettings.mock.calls[0];
        expect(draft.executablePath).toBe('/usr/local/bin/llama');
        expect(draft.thinkingMode).toBe(true);
    });
});
