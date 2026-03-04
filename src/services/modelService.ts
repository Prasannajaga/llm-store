import { invoke } from '@tauri-apps/api/core';

export const modelService = {
    async listModels(): Promise<string[]> {
        return invoke('list_models');
    },

    async loadModel(modelName: string): Promise<void> {
        return invoke('load_model', { modelName });
    },

    async unloadModel(): Promise<void> {
        return invoke('unload_model');
    },
};
