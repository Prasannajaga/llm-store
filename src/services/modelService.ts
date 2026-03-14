import { invoke } from '@tauri-apps/api/core';
import type { LlamaServerArgs } from '../types';

export const modelService = {
    async listModels(): Promise<string[]> {
        return invoke('list_models');
    },

    async loadModel(modelName: string, args?: LlamaServerArgs): Promise<void> {
        return invoke('load_model', { modelName, args: args || null });
    },

    async unloadModel(): Promise<void> {
        return invoke('unload_model');
    },

    async registerModel(path: string): Promise<void> {
        return invoke('register_model', { path });
    },

    async removeModel(path: string): Promise<void> {
        return invoke('remove_model', { path });
    },
};
