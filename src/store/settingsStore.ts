import { create } from 'zustand';
import { CONFIG } from '../config';
import { settingsService } from '../services/settingsService';

interface LlamaServerSettings {
    port: number;
    contextSize: number;
    gpuLayers: number;
    threads: number;
    batchSize: number;
}

interface SettingsState {
    llamaServer: LlamaServerSettings;
    isLoaded: boolean;
    isSaving: boolean;
    loadSettings: () => Promise<void>;
    applySettings: (draft: LlamaServerSettings) => Promise<void>;
    resetLlamaServerDefaults: () => Promise<void>;
}

const SETTINGS_KEYS = {
    PORT: 'llamaServer.port',
    CONTEXT_SIZE: 'llamaServer.contextSize',
    GPU_LAYERS: 'llamaServer.gpuLayers',
    THREADS: 'llamaServer.threads',
    BATCH_SIZE: 'llamaServer.batchSize',
} as const;

function settingsToEntries(settings: LlamaServerSettings) {
    return [
        { key: SETTINGS_KEYS.PORT, value: String(settings.port) },
        { key: SETTINGS_KEYS.CONTEXT_SIZE, value: String(settings.contextSize) },
        { key: SETTINGS_KEYS.GPU_LAYERS, value: String(settings.gpuLayers) },
        { key: SETTINGS_KEYS.THREADS, value: String(settings.threads) },
        { key: SETTINGS_KEYS.BATCH_SIZE, value: String(settings.batchSize) },
    ];
}

export const useSettingsStore = create<SettingsState>((set) => ({
    llamaServer: { ...CONFIG.llamaServer },
    isLoaded: false,
    isSaving: false,

    loadSettings: async () => {
        try {
            const entries = await settingsService.loadSettings();
            if (entries.length === 0) {
                set({ isLoaded: true });
                return;
            }

            const map = new Map(entries.map(e => [e.key, e.value]));
            const current = { ...CONFIG.llamaServer };

            if (map.has(SETTINGS_KEYS.PORT)) current.port = parseInt(map.get(SETTINGS_KEYS.PORT)!, 10);
            if (map.has(SETTINGS_KEYS.CONTEXT_SIZE)) current.contextSize = parseInt(map.get(SETTINGS_KEYS.CONTEXT_SIZE)!, 10);
            if (map.has(SETTINGS_KEYS.GPU_LAYERS)) current.gpuLayers = parseInt(map.get(SETTINGS_KEYS.GPU_LAYERS)!, 10);
            if (map.has(SETTINGS_KEYS.THREADS)) current.threads = parseInt(map.get(SETTINGS_KEYS.THREADS)!, 10);
            if (map.has(SETTINGS_KEYS.BATCH_SIZE)) current.batchSize = parseInt(map.get(SETTINGS_KEYS.BATCH_SIZE)!, 10);

            set({ llamaServer: current, isLoaded: true });
        } catch (err) {
            console.error('Failed to load settings:', err);
            set({ isLoaded: true });
        }
    },

    applySettings: async (draft) => {
        set({ isSaving: true });
        try {
            const entries = settingsToEntries(draft);
            await settingsService.saveSettings(entries);
            set({ llamaServer: { ...draft }, isSaving: false });
        } catch (err) {
            console.error('Failed to save settings:', err);
            set({ isSaving: false });
        }
    },

    resetLlamaServerDefaults: async () => {
        set({ isSaving: true });
        try {
            const defaults = { ...CONFIG.llamaServer };
            const entries = settingsToEntries(defaults);
            await settingsService.saveSettings(entries);
            set({ llamaServer: defaults, isSaving: false });
        } catch (err) {
            console.error('Failed to reset settings:', err);
            set({ isSaving: false });
        }
    },
}));
