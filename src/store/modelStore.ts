import { create } from 'zustand';
import { modelService } from '../services/modelService';
import { CONFIG } from '../config';
import { useSettingsStore } from './settingsStore';
import type { LlamaServerArgs } from '../types';

/** Reads current llama-server settings from the settings store and builds the typed args object. */
function buildLlamaServerArgs(): LlamaServerArgs {
    const { llamaServer } = useSettingsStore.getState();
    return {
        executable_path: llamaServer.executablePath,
        port: llamaServer.port,
        context_size: llamaServer.contextSize,
        gpu_layers: llamaServer.gpuLayers,
        threads: llamaServer.threads,
        batch_size: llamaServer.batchSize,
    };
}

interface ModelState {
    models: string[];
    activeModel: string | null;
    isLoading: boolean;
    isModelLoading: boolean;
    modelLoadError: string | null;
    useCustomUrl: boolean;
    customUrl: string;
    loadModels: () => Promise<void>;
    setActiveModel: (model: string | null) => void;
    removeModel: (path: string) => Promise<void>;
    setUseCustomUrl: (useUrl: boolean) => void;
    setCustomUrl: (url: string) => void;
    addCustomLocalModel: (path: string) => void;
    clearModelLoadError: () => void;
}

export const useModelStore = create<ModelState>((set, get) => ({
    models: [],
    activeModel: null,
    isLoading: false,
    isModelLoading: false,
    modelLoadError: null,
    useCustomUrl: false,
    customUrl: CONFIG.model.customUrlDefault,

    loadModels: async () => {
        set({ isLoading: true });
        try {
            const models = await modelService.listModels();
            set({
                models,
                isLoading: false,
            });
        } catch (err) {
            console.error('Failed to load models:', err);
            set({ isLoading: false });
        }
    },

    setActiveModel: (model) => {
        set({ activeModel: model, useCustomUrl: false, modelLoadError: null });
        if (model) {
            set({ isModelLoading: true });
            const args = buildLlamaServerArgs();
            modelService.loadModel(model, args)
                .then(() => set({ isModelLoading: false }))
                .catch((err) => {
                    const errorMsg = typeof err === 'string' ? err : String(err);
                    console.error('Failed to load model:', errorMsg);
                    set({ isModelLoading: false, modelLoadError: errorMsg });
                });
        }
    },

    removeModel: async (path: string) => {
        try {
            const { activeModel } = get();
            // If removing the active model, unload it first
            if (activeModel === path) {
                await modelService.unloadModel();
                set({ activeModel: null });
            }
            await modelService.removeModel(path);
            // Refresh models list
            const models = await modelService.listModels();
            set({ models });
        } catch (err) {
            console.error('Failed to remove model:', err);
        }
    },

    setUseCustomUrl: (useUrl) => {
        set({ useCustomUrl: useUrl });
        if (useUrl) {
            modelService.unloadModel().catch(console.error);
        } else {
            const { activeModel } = get();
            if (activeModel) {
                getActiveModel(activeModel); // trigger reload
            }
        }
    },

    setCustomUrl: (url) => {
        set({ customUrl: url, useCustomUrl: true });
    },
    
    addCustomLocalModel: (path: string) => {
        // Register in backend DB for persistence across restarts
        modelService.registerModel(path)
            .then(() => {
                // Refresh the list from backend (scan + DB merge)
                return modelService.listModels();
            })
            .then((models) => {
                set({ models });
                // Now select and load the newly added model
                get().setActiveModel(path);
            })
            .catch((err) => {
                console.error('Failed to register model:', err);
                // Fallback: add locally anyway
                const { models } = get();
                if (!models.includes(path)) {
                    set({ models: [...models, path] });
                }
                get().setActiveModel(path);
            });
    },

    clearModelLoadError: () => {
        set({ modelLoadError: null });
    }
}));

// Helper logic to trigger the load using setter above
function getActiveModel(activeModel: string) {
    useModelStore.getState().setActiveModel(activeModel);
}
