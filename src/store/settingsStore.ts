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
    thinkingMode: boolean;
    maxContextChars: number;
    maxPromptChars: number;
}

export type PipelineMode = 'legacy' | 'rust_v1';
export type LlamaPreset = 'cpu_optimized' | 'gpu_optimized' | 'custom';

interface SettingsState {
    llamaServer: LlamaServerSettings;
    generation: GenerationSettings;
    pipelineMode: PipelineMode;
    llamaPreset: LlamaPreset;
    isLoaded: boolean;
    isSaving: boolean;
    loadSettings: () => Promise<void>;
    applySettings: (
        draft: LlamaServerSettings & GenerationSettings,
        preset?: LlamaPreset,
    ) => Promise<void>;
    resetLlamaServerDefaults: () => Promise<void>;
    setPipelineMode: (mode: PipelineMode) => Promise<void>;
    setThinkingMode: (enabled: boolean) => Promise<void>;
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
    THINKING_MODE: 'generation.thinkingMode',
    MAX_CONTEXT_CHARS: 'pipeline.prompt.max_context_chars',
    MAX_PROMPT_CHARS: 'pipeline.prompt.max_prompt_chars',
    PIPELINE_MODE: 'pipeline.mode',
    LLAMA_PRESET: 'llamaServer.preset',
} as const;

function detectHardwareThreads(): number {
    if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
        return navigator.hardwareConcurrency;
    }
    return 8;
}

function buildCpuOptimizedServerDefaults(base: LlamaServerSettings): LlamaServerSettings {
    const threads = Math.max(2, detectHardwareThreads() - 1);
    return {
        ...base,
        gpuLayers: 0,
        threads,
        batchSize: threads >= 10 ? 512 : 256,
        contextSize: 2048,
    };
}

function settingsToEntries(
    server: LlamaServerSettings,
    gen: GenerationSettings,
    pipelineMode: PipelineMode,
    llamaPreset: LlamaPreset,
) {
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
        { key: SETTINGS_KEYS.THINKING_MODE, value: String(gen.thinkingMode) },
        { key: SETTINGS_KEYS.MAX_CONTEXT_CHARS, value: String(gen.maxContextChars) },
        { key: SETTINGS_KEYS.MAX_PROMPT_CHARS, value: String(gen.maxPromptChars) },
        { key: SETTINGS_KEYS.PIPELINE_MODE, value: pipelineMode },
        { key: SETTINGS_KEYS.LLAMA_PRESET, value: llamaPreset },
    ];
}

function llamaServerSettingsEqual(a: LlamaServerSettings, b: LlamaServerSettings): boolean {
    return (
        a.executablePath === b.executablePath
        && a.port === b.port
        && a.contextSize === b.contextSize
        && a.gpuLayers === b.gpuLayers
        && a.threads === b.threads
        && a.batchSize === b.batchSize
    );
}

export const useSettingsStore = create<SettingsState>((set) => ({
    llamaServer: buildCpuOptimizedServerDefaults({ ...CONFIG.llamaServer }),
    generation: { ...CONFIG.generation },
    pipelineMode: 'rust_v1',
    llamaPreset: 'cpu_optimized',
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
            const current = buildCpuOptimizedServerDefaults({ ...CONFIG.llamaServer });
            const gen = { ...CONFIG.generation };
            let pipelineMode: PipelineMode = 'rust_v1';
            let llamaPreset: LlamaPreset = 'cpu_optimized';

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
            if (map.has(SETTINGS_KEYS.THINKING_MODE)) {
                const raw = map.get(SETTINGS_KEYS.THINKING_MODE)!.trim().toLowerCase();
                gen.thinkingMode = raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
            }
            if (map.has(SETTINGS_KEYS.MAX_CONTEXT_CHARS)) {
                gen.maxContextChars = parseInt(map.get(SETTINGS_KEYS.MAX_CONTEXT_CHARS)!, 10);
            }
            if (map.has(SETTINGS_KEYS.MAX_PROMPT_CHARS)) {
                gen.maxPromptChars = parseInt(map.get(SETTINGS_KEYS.MAX_PROMPT_CHARS)!, 10);
            }
            if (map.has(SETTINGS_KEYS.PIPELINE_MODE)) {
                const mode = map.get(SETTINGS_KEYS.PIPELINE_MODE);
                if (mode === 'legacy' || mode === 'rust_v1') {
                    pipelineMode = mode;
                }
            }
            if (map.has(SETTINGS_KEYS.LLAMA_PRESET)) {
                const preset = map.get(SETTINGS_KEYS.LLAMA_PRESET);
                if (preset === 'cpu_optimized' || preset === 'gpu_optimized' || preset === 'custom') {
                    llamaPreset = preset;
                }
            }

            set({ llamaServer: current, generation: gen, pipelineMode, llamaPreset, isLoaded: true });
        } catch (err) {
            console.error('Failed to load settings:', err);
            set({ isLoaded: true });
        }
    },

    applySettings: async (draft, preset) => {
        set({ isSaving: true });
        try {
            const previousServer = useSettingsStore.getState().llamaServer;
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
                thinkingMode: draft.thinkingMode,
                maxContextChars: draft.maxContextChars,
                maxPromptChars: draft.maxPromptChars,
            };
            const mode = useSettingsStore.getState().pipelineMode;
            const selectedPreset = preset ?? useSettingsStore.getState().llamaPreset;
            const entries = settingsToEntries(server, gen, mode, selectedPreset);
            await settingsService.saveSettings(entries);
            set({
                llamaServer: { ...server },
                generation: { ...gen },
                llamaPreset: selectedPreset,
                isSaving: false,
            });

            if (!llamaServerSettingsEqual(previousServer, server)) {
                void import('./modelStore')
                    .then(({ useModelStore }) => useModelStore.getState().reloadActiveModel())
                    .catch((err) => {
                        console.warn('Failed to auto-reload model after settings update:', err);
                    });
            }
        } catch (err) {
            console.error('Failed to save settings:', err);
            set({ isSaving: false });
        }
    },

    resetLlamaServerDefaults: async () => {
        set({ isSaving: true });
        try {
            const defaults = buildCpuOptimizedServerDefaults({ ...CONFIG.llamaServer });
            const genDefaults = { ...CONFIG.generation };
            const mode = useSettingsStore.getState().pipelineMode;
            const entries = settingsToEntries(defaults, genDefaults, mode, 'cpu_optimized');
            await settingsService.saveSettings(entries);
            set({
                llamaServer: defaults,
                generation: genDefaults,
                llamaPreset: 'cpu_optimized',
                isSaving: false,
            });
        } catch (err) {
            console.error('Failed to reset settings:', err);
            set({ isSaving: false });
        }
    },

    setPipelineMode: async (mode) => {
        set({ pipelineMode: mode });
        try {
            await settingsService.saveSettings([
                { key: SETTINGS_KEYS.PIPELINE_MODE, value: mode },
            ]);
        } catch (err) {
            console.error('Failed to save pipeline mode:', err);
        }
    },

    setThinkingMode: async (enabled) => {
        set((state) => ({
            generation: {
                ...state.generation,
                thinkingMode: enabled,
            },
        }));
        try {
            await settingsService.saveSettings([
                { key: SETTINGS_KEYS.THINKING_MODE, value: String(enabled) },
            ]);
        } catch (err) {
            console.error('Failed to save thinking mode:', err);
        }
    },
}));
