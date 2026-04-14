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
    agentMode: boolean;
    maxContextChars: number;
    maxPromptChars: number;
}

export type LlamaPreset = 'cpu_optimized' | 'gpu_optimized' | 'custom';
const RUST_PIPELINE_MODE = 'rust_v1';

interface SettingsState {
    llamaServer: LlamaServerSettings;
    generation: GenerationSettings;
    llamaPreset: LlamaPreset;
    isLoaded: boolean;
    isSaving: boolean;
    loadSettings: () => Promise<void>;
    applySettings: (
        draft: LlamaServerSettings & GenerationSettings,
        preset?: LlamaPreset,
    ) => Promise<void>;
    resetLlamaServerDefaults: () => Promise<void>;
    setThinkingMode: (enabled: boolean) => Promise<void>;
    setAgentMode: (enabled: boolean) => Promise<void>;
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
    AGENT_MODE: 'generation.agentMode',
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
        { key: SETTINGS_KEYS.AGENT_MODE, value: String(gen.agentMode) },
        { key: SETTINGS_KEYS.MAX_CONTEXT_CHARS, value: String(gen.maxContextChars) },
        { key: SETTINGS_KEYS.MAX_PROMPT_CHARS, value: String(gen.maxPromptChars) },
        { key: SETTINGS_KEYS.PIPELINE_MODE, value: RUST_PIPELINE_MODE },
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

function parseIntOrFallback(raw: string | undefined, fallback: number): number {
    if (raw === undefined) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatOrFallback(raw: string | undefined, fallback: number): number {
    if (raw === undefined) {
        return fallback;
    }
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

export const useSettingsStore = create<SettingsState>((set) => ({
    llamaServer: buildCpuOptimizedServerDefaults({ ...CONFIG.llamaServer }),
    generation: { ...CONFIG.generation },
    llamaPreset: 'cpu_optimized',
    isLoaded: false,
    isSaving: false,

    loadSettings: async () => {
        try {
            const entries = await settingsService.loadSettings();
            const map = new Map(entries.map(e => [e.key, e.value]));
            const current = buildCpuOptimizedServerDefaults({ ...CONFIG.llamaServer });
            const gen = { ...CONFIG.generation };
            let llamaPreset: LlamaPreset = 'cpu_optimized';
            const persistedMode = map.get(SETTINGS_KEYS.PIPELINE_MODE);
            const shouldPersistRustPipelineMode = persistedMode !== RUST_PIPELINE_MODE;

            if (map.has(SETTINGS_KEYS.EXECUTABLE_PATH)) {
                // Read straight as a string rather than parseInt mapping
                current.executablePath = map.get(SETTINGS_KEYS.EXECUTABLE_PATH)!;
            }
            current.port = parseIntOrFallback(map.get(SETTINGS_KEYS.PORT), current.port);
            current.contextSize = parseIntOrFallback(map.get(SETTINGS_KEYS.CONTEXT_SIZE), current.contextSize);
            current.gpuLayers = parseIntOrFallback(map.get(SETTINGS_KEYS.GPU_LAYERS), current.gpuLayers);
            current.threads = parseIntOrFallback(map.get(SETTINGS_KEYS.THREADS), current.threads);
            current.batchSize = parseIntOrFallback(map.get(SETTINGS_KEYS.BATCH_SIZE), current.batchSize);
            gen.maxTokens = parseIntOrFallback(map.get(SETTINGS_KEYS.MAX_TOKENS), gen.maxTokens);
            gen.temperature = parseFloatOrFallback(map.get(SETTINGS_KEYS.TEMPERATURE), gen.temperature);
            gen.topP = parseFloatOrFallback(map.get(SETTINGS_KEYS.TOP_P), gen.topP);
            gen.topK = parseIntOrFallback(map.get(SETTINGS_KEYS.TOP_K), gen.topK);
            gen.repeatPenalty = parseFloatOrFallback(map.get(SETTINGS_KEYS.REPEAT_PENALTY), gen.repeatPenalty);
            gen.thinkingMode = parseBoolean(
                map.get(SETTINGS_KEYS.THINKING_MODE),
                gen.thinkingMode,
            );
            gen.agentMode = parseBoolean(
                map.get(SETTINGS_KEYS.AGENT_MODE),
                gen.agentMode,
            );
            gen.maxContextChars = parseIntOrFallback(
                map.get(SETTINGS_KEYS.MAX_CONTEXT_CHARS),
                gen.maxContextChars,
            );
            gen.maxPromptChars = parseIntOrFallback(
                map.get(SETTINGS_KEYS.MAX_PROMPT_CHARS),
                gen.maxPromptChars,
            );
            if (map.has(SETTINGS_KEYS.LLAMA_PRESET)) {
                const preset = map.get(SETTINGS_KEYS.LLAMA_PRESET);
                if (preset === 'cpu_optimized' || preset === 'gpu_optimized' || preset === 'custom') {
                    llamaPreset = preset;
                }
            }

            // Ensure new installs / upgraded workspaces persist missing defaults
            // so frontend and rust pipeline read the same settings source.
            const resolvedEntries = settingsToEntries(current, gen, llamaPreset);
            const missingEntries = resolvedEntries.filter((entry) => !map.has(entry.key));
            const needsPipelineModeCorrection = shouldPersistRustPipelineMode
                && !missingEntries.some((entry) => entry.key === SETTINGS_KEYS.PIPELINE_MODE);
            const entriesToPersist = needsPipelineModeCorrection
                ? [
                    ...missingEntries,
                    { key: SETTINGS_KEYS.PIPELINE_MODE, value: RUST_PIPELINE_MODE },
                ]
                : missingEntries;
            if (entriesToPersist.length > 0) {
                await settingsService.saveSettings(entriesToPersist).catch((err) => {
                    console.warn('Failed to backfill missing settings defaults:', err);
                });
            }

            set({ llamaServer: current, generation: gen, llamaPreset, isLoaded: true });
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
                agentMode: draft.agentMode,
                maxContextChars: draft.maxContextChars,
                maxPromptChars: draft.maxPromptChars,
            };
            const selectedPreset = preset ?? useSettingsStore.getState().llamaPreset;
            const entries = settingsToEntries(server, gen, selectedPreset);
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
            const entries = settingsToEntries(defaults, genDefaults, 'cpu_optimized');
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

    setAgentMode: async (enabled) => {
        set((state) => ({
            generation: {
                ...state.generation,
                agentMode: enabled,
            },
        }));
        try {
            await settingsService.saveSettings([
                { key: SETTINGS_KEYS.AGENT_MODE, value: String(enabled) },
            ]);
        } catch (err) {
            console.error('Failed to save agent mode:', err);
        }
    },
}));
