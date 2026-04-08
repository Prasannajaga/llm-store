import { invoke } from '@tauri-apps/api/core';

interface SettingsEntry {
    key: string;
    value: string;
}

export interface ReasoningTokenConfig {
    openMarkers: string[];
    closeMarkers: string[];
}

export const settingsService = {
    async saveSettings(entries: SettingsEntry[]): Promise<void> {
        return invoke('save_settings', { entries });
    },

    async loadSettings(): Promise<SettingsEntry[]> {
        return invoke('load_settings');
    },

    async getReasoningTokenConfig(): Promise<ReasoningTokenConfig> {
        return invoke('get_reasoning_token_config');
    },
};
