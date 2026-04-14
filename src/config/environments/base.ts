import type { AppConfig } from '../schema';

export const baseConfig: Omit<AppConfig, 'environment'> = {
    model: {
        defaultName: 'Llama-3-8B-Instruct.Q4_K_M.gguf',
        allowCustomUrl: true,
        customUrlDefault: 'http://localhost:8080/completion',
    },
    ui: {
        theme: 'system',
        animationsEnabled: true,
    },
    llamaServer: {
        executablePath: 'llama-server',
        port: 8080,
        contextSize: 2048,
        gpuLayers: 0,
        threads: 4,
        batchSize: 512,
    },
    generation: {
        maxTokens: 512,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        repeatPenalty: 1.1,
        thinkingMode: false,
        agentMode: false,
        maxContextChars: 12000,
        maxPromptChars: 24000,
    },
};
