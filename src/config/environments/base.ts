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
        port: 8080,
        contextSize: 2048,
        gpuLayers: 0,
        threads: 4,
        batchSize: 512,
    },
};
