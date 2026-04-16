import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { useSettingsStore } from '../../store/settingsStore';
import { settingsService } from '../../services/settingsService';

vi.mock('../../store/settingsStore', () => ({
    useSettingsStore: vi.fn(),
}));

vi.mock('../../services/settingsService', () => ({
    settingsService: {
        listAgentFsRoots: vi.fn().mockResolvedValue([]),
        grantAgentFsRoot: vi.fn(),
        revokeAgentFsRoot: vi.fn(),
    },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn(),
}));

const mockApplySettings = vi.fn().mockResolvedValue(undefined);
const mockResetDefaults = vi.fn().mockResolvedValue(undefined);

describe('SettingsModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(settingsService.listAgentFsRoots).mockResolvedValue([]);
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

    it('renders trusted agent folders from settings service', async () => {
        vi.mocked(settingsService.listAgentFsRoots).mockResolvedValue([
            {
                id: 'root-1',
                path: '/home/demo/project',
                normalized_path: '/home/demo/project',
                source: 'settings_manual',
                created_at: '2026-01-01T00:00:00Z',
            },
        ]);

        render(<SettingsModal onClose={() => {}} />);

        expect(await screen.findByText('/home/demo/project')).toBeInTheDocument();
        expect(screen.getByText('settings_manual')).toBeInTheDocument();
    });
});
