import { create } from 'zustand';
import { modelService } from '../services/modelService';
import { CONFIG } from '../config';
import { useSettingsStore } from './settingsStore';
import { settingsService } from '../services/settingsService';
import type { LlamaServerArgs } from '../types';

const MODEL_SETTINGS_KEYS = {
    ACTIVE_MODEL: 'model.activeModel',
    USE_CUSTOM_URL: 'model.useCustomUrl',
    CUSTOM_URL: 'model.customUrl',
    CUSTOM_API_KEY: 'model.customApiKey',
} as const;

function parseBooleanSetting(value: string | undefined): boolean | null {
    if (value === undefined) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return null;
}

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
    customApiKey: string;
    loadModels: () => Promise<void>;
    setActiveModel: (model: string | null) => void;
    removeModel: (path: string) => Promise<void>;
    setUseCustomUrl: (useUrl: boolean) => void;
    setCustomServerConfig: (url: string, apiKey: string) => void;
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
    customApiKey: '',

    loadModels: async () => {
        set({ isLoading: true });
        try {
            const [models, settingsEntries] = await Promise.all([
                modelService.listModels(),
                settingsService.loadSettings().catch(() => []),
            ]);
            const settingsMap = new Map(settingsEntries.map((entry) => [entry.key, entry.value]));
            const persistedActive = settingsMap.get(MODEL_SETTINGS_KEYS.ACTIVE_MODEL) ?? null;
            const persistedUseCustom = parseBooleanSetting(settingsMap.get(MODEL_SETTINGS_KEYS.USE_CUSTOM_URL));
            const persistedCustomUrl = settingsMap.get(MODEL_SETTINGS_KEYS.CUSTOM_URL);
            const persistedCustomApiKey = settingsMap.get(MODEL_SETTINGS_KEYS.CUSTOM_API_KEY);
            const current = get();

            set({
                models,
                activeModel: current.activeModel ?? persistedActive,
                useCustomUrl: persistedUseCustom ?? current.useCustomUrl,
                customUrl: persistedCustomUrl || current.customUrl,
                customApiKey: persistedCustomApiKey ?? current.customApiKey,
                isLoading: false,
            });
        } catch (err) {
            console.error('Failed to load models:', err);
            set({ isLoading: false });
        }
    },

    setActiveModel: (model) => {
        set({ activeModel: model, useCustomUrl: false, modelLoadError: null });
        settingsService.saveSettings([
            { key: MODEL_SETTINGS_KEYS.ACTIVE_MODEL, value: model ?? '' },
            { key: MODEL_SETTINGS_KEYS.USE_CUSTOM_URL, value: 'false' },
        ]).catch((err) => {
            console.warn('Failed to persist active model selection:', err);
        });

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
                settingsService.saveSettings([
                    { key: MODEL_SETTINGS_KEYS.ACTIVE_MODEL, value: '' },
                ]).catch((err) => {
                    console.warn('Failed to clear persisted active model after removal:', err);
                });
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
        settingsService.saveSettings([
            { key: MODEL_SETTINGS_KEYS.USE_CUSTOM_URL, value: String(useUrl) },
        ]).catch((err) => {
            console.warn('Failed to persist custom-url mode:', err);
        });

        if (useUrl) {
            modelService.unloadModel().catch(console.error);
        } else {
            const { activeModel } = get();
            if (activeModel) {
                getActiveModel(activeModel); // trigger reload
            }
        }
    },

    setCustomServerConfig: (url, apiKey) => {
        const normalizedUrl = url.trim();
        set({ customUrl: normalizedUrl, customApiKey: apiKey, useCustomUrl: true });
        settingsService.saveSettings([
            { key: MODEL_SETTINGS_KEYS.CUSTOM_URL, value: normalizedUrl },
            { key: MODEL_SETTINGS_KEYS.CUSTOM_API_KEY, value: apiKey },
            { key: MODEL_SETTINGS_KEYS.USE_CUSTOM_URL, value: 'true' },
        ]).catch((err) => {
            console.warn('Failed to persist custom server config:', err);
        });
        modelService.unloadModel().catch(console.error);
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
