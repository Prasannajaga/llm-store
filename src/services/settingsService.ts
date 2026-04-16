import { invoke } from '@tauri-apps/api/core';

interface SettingsEntry {
    key: string;
    value: string;
}

export interface AgentFsRoot {
    id: string;
    path: string;
    normalized_path: string;
    source: string;
    created_at: string;
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

    async exportWorkspaceBackup(): Promise<string> {
        return invoke('export_workspace_backup');
    },

    async listAgentFsRoots(): Promise<AgentFsRoot[]> {
        return invoke('list_agent_fs_roots');
    },

    async grantAgentFsRoot(path: string, source?: string): Promise<AgentFsRoot> {
        return invoke('grant_agent_fs_root', { path, source });
    },

    async revokeAgentFsRoot(rootId: string): Promise<void> {
        return invoke('revoke_agent_fs_root', { rootId });
    },
};
