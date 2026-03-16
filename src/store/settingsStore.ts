import { create } from 'zustand';
import { CONFIG } from '../config';
import { settingsService } from '../services/settingsService';

interface LlamaServerSettings {
    executablePath: string;
    port: number;
    contextSize: number;
    gpuLayers: number;
    threads: number;
    batchSize: number;
}

/** Parameters controlling generation output — sent with each /completion request. */
interface GenerationSettings {
    maxTokens: number;
    temperature: number;
    topP: number;
    topK: number;
    repeatPenalty: number;
}

interface SettingsState {
    llamaServer: LlamaServerSettings;
    generation: GenerationSettings;
    isLoaded: boolean;
    isSaving: boolean;
    loadSettings: () => Promise<void>;
    applySettings: (draft: LlamaServerSettings & GenerationSettings) => Promise<void>;
    resetLlamaServerDefaults: () => Promise<void>;
}

const SETTINGS_KEYS = {
    EXECUTABLE_PATH: 'llamaServer.executablePath',
    PORT: 'llamaServer.port',
    CONTEXT_SIZE: 'llamaServer.contextSize',
    GPU_LAYERS: 'llamaServer.gpuLayers',
    THREADS: 'llamaServer.threads',
    BATCH_SIZE: 'llamaServer.batchSize',
    MAX_TOKENS: 'generation.maxTokens',
    TEMPERATURE: 'generation.temperature',
    TOP_P: 'generation.topP',
    TOP_K: 'generation.topK',
    REPEAT_PENALTY: 'generation.repeatPenalty',
} as const;

function settingsToEntries(server: LlamaServerSettings, gen: GenerationSettings) {
    return [
        { key: SETTINGS_KEYS.EXECUTABLE_PATH, value: server.executablePath },
        { key: SETTINGS_KEYS.PORT, value: String(server.port) },
        { key: SETTINGS_KEYS.CONTEXT_SIZE, value: String(server.contextSize) },
        { key: SETTINGS_KEYS.GPU_LAYERS, value: String(server.gpuLayers) },
        { key: SETTINGS_KEYS.THREADS, value: String(server.threads) },
        { key: SETTINGS_KEYS.BATCH_SIZE, value: String(server.batchSize) },
        { key: SETTINGS_KEYS.MAX_TOKENS, value: String(gen.maxTokens) },
        { key: SETTINGS_KEYS.TEMPERATURE, value: String(gen.temperature) },
        { key: SETTINGS_KEYS.TOP_P, value: String(gen.topP) },
        { key: SETTINGS_KEYS.TOP_K, value: String(gen.topK) },
        { key: SETTINGS_KEYS.REPEAT_PENALTY, value: String(gen.repeatPenalty) },
    ];
}

export const useSettingsStore = create<SettingsState>((set) => ({
    llamaServer: { ...CONFIG.llamaServer },
    generation: { ...CONFIG.generation },
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
            const gen = { ...CONFIG.generation };

            if (map.has(SETTINGS_KEYS.EXECUTABLE_PATH)) {
                // Read straight as a string rather than parseInt mapping
                current.executablePath = map.get(SETTINGS_KEYS.EXECUTABLE_PATH)!;
            }
            if (map.has(SETTINGS_KEYS.PORT)) current.port = parseInt(map.get(SETTINGS_KEYS.PORT)!, 10);
            if (map.has(SETTINGS_KEYS.CONTEXT_SIZE)) current.contextSize = parseInt(map.get(SETTINGS_KEYS.CONTEXT_SIZE)!, 10);
            if (map.has(SETTINGS_KEYS.GPU_LAYERS)) current.gpuLayers = parseInt(map.get(SETTINGS_KEYS.GPU_LAYERS)!, 10);
            if (map.has(SETTINGS_KEYS.THREADS)) current.threads = parseInt(map.get(SETTINGS_KEYS.THREADS)!, 10);
            if (map.has(SETTINGS_KEYS.BATCH_SIZE)) current.batchSize = parseInt(map.get(SETTINGS_KEYS.BATCH_SIZE)!, 10);
            if (map.has(SETTINGS_KEYS.MAX_TOKENS)) gen.maxTokens = parseInt(map.get(SETTINGS_KEYS.MAX_TOKENS)!, 10);
            if (map.has(SETTINGS_KEYS.TEMPERATURE)) gen.temperature = parseFloat(map.get(SETTINGS_KEYS.TEMPERATURE)!);
            if (map.has(SETTINGS_KEYS.TOP_P)) gen.topP = parseFloat(map.get(SETTINGS_KEYS.TOP_P)!);
            if (map.has(SETTINGS_KEYS.TOP_K)) gen.topK = parseInt(map.get(SETTINGS_KEYS.TOP_K)!, 10);
            if (map.has(SETTINGS_KEYS.REPEAT_PENALTY)) gen.repeatPenalty = parseFloat(map.get(SETTINGS_KEYS.REPEAT_PENALTY)!);

            set({ llamaServer: current, generation: gen, isLoaded: true });
        } catch (err) {
            console.error('Failed to load settings:', err);
            set({ isLoaded: true });
        }
    },

    applySettings: async (draft) => {
        set({ isSaving: true });
        try {
            const server: LlamaServerSettings = {
                executablePath: draft.executablePath,
                port: draft.port,
                contextSize: draft.contextSize,
                gpuLayers: draft.gpuLayers,
                threads: draft.threads,
                batchSize: draft.batchSize,
            };
            const gen: GenerationSettings = {
                maxTokens: draft.maxTokens,
                temperature: draft.temperature,
                topP: draft.topP,
                topK: draft.topK,
                repeatPenalty: draft.repeatPenalty,
            };
            const entries = settingsToEntries(server, gen);
            await settingsService.saveSettings(entries);
            set({ llamaServer: { ...server }, generation: { ...gen }, isSaving: false });
        } catch (err) {
            console.error('Failed to save settings:', err);
            set({ isSaving: false });
        }
    },

    resetLlamaServerDefaults: async () => {
        set({ isSaving: true });
        try {
            const defaults = { ...CONFIG.llamaServer };
            const genDefaults = { ...CONFIG.generation };
            const entries = settingsToEntries(defaults, genDefaults);
            await settingsService.saveSettings(entries);
            set({ llamaServer: defaults, generation: genDefaults, isSaving: false });
        } catch (err) {
            console.error('Failed to reset settings:', err);
            set({ isSaving: false });
        }
    },
}));
