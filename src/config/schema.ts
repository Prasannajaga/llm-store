export interface AppConfig {
    environment: 'development' | 'production' | 'testing';
    model: {
        defaultName: string;
        allowCustomUrl: boolean;
        customUrlDefault: string;
    };
    ui: {
        theme: 'light' | 'dark' | 'system';
        animationsEnabled: boolean;
    };
    llamaServer: {
        executablePath: string;
        port: number;
        contextSize: number;
        gpuLayers: number;
        threads: number;
        batchSize: number;
    };
    generation: {
        maxTokens: number;
        temperature: number;
        topP: number;
        topK: number;
        repeatPenalty: number;
        thinkingMode: boolean;
    };
}

export function validateConfig(config: unknown): asserts config is AppConfig {
    if (!config || typeof config !== 'object') throw new Error("Config is undefined or invalid");
    const c = config as Record<string, unknown>;
    
    if (!['development', 'production', 'testing'].includes(c.environment as string)) {
        throw new Error(`Invalid environment: ${c.environment}`);
    }
    
    const cm = c.model as Record<string, unknown> || {};
    if (typeof cm.defaultName !== 'string') throw new Error("Missing or invalid model.defaultName");
    if (typeof cm.allowCustomUrl !== 'boolean') throw new Error("Missing or invalid model.allowCustomUrl");
    if (typeof cm.customUrlDefault !== 'string') throw new Error("Missing or invalid model.customUrlDefault");

    const cu = c.ui as Record<string, unknown> || {};
    if (!['light', 'dark', 'system'].includes(cu.theme as string)) throw new Error("Invalid ui.theme");
    if (typeof cu.animationsEnabled !== 'boolean') throw new Error("Missing or invalid ui.animationsEnabled");

    const cls = c.llamaServer as Record<string, unknown> || {};
    if (typeof cls.executablePath !== 'string') throw new Error("Missing or invalid llamaServer.executablePath");
    if (typeof cls.port !== 'number' || cls.port <= 0) throw new Error("Missing or invalid llamaServer.port");
    if (typeof cls.contextSize !== 'number' || cls.contextSize <= 0) throw new Error("Missing or invalid llamaServer.contextSize");
    if (typeof cls.gpuLayers !== 'number') throw new Error("Missing or invalid llamaServer.gpuLayers");
    if (typeof cls.threads !== 'number' || cls.threads <= 0) throw new Error("Missing or invalid llamaServer.threads");
    if (typeof cls.batchSize !== 'number' || cls.batchSize <= 0) throw new Error("Missing or invalid llamaServer.batchSize");

    const cg = c.generation as Record<string, unknown> || {};
    if (typeof cg.maxTokens !== 'number' || cg.maxTokens <= 0) throw new Error("Missing or invalid generation.maxTokens");
    if (typeof cg.temperature !== 'number' || cg.temperature < 0) throw new Error("Missing or invalid generation.temperature");
    if (typeof cg.topP !== 'number' || cg.topP <= 0 || cg.topP > 1) throw new Error("Missing or invalid generation.topP");
    if (typeof cg.topK !== 'number' || cg.topK < 0) throw new Error("Missing or invalid generation.topK");
    if (typeof cg.repeatPenalty !== 'number' || cg.repeatPenalty < 0) throw new Error("Missing or invalid generation.repeatPenalty");
    if (typeof cg.thinkingMode !== 'boolean') throw new Error("Missing or invalid generation.thinkingMode");
}
