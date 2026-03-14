import type { AppConfig } from './schema';
import { validateConfig } from './schema';
import { developmentConfig } from './environments/development';
import { productionConfig } from './environments/production';
import { testingConfig } from './environments/testing';

function loadConfig(): AppConfig {
    // Determine environment deterministically at startup
    const env = import.meta.env.MODE || 'development';

    let config: AppConfig;
    switch (env) {
        case 'production':
            config = productionConfig;
            break;
        case 'test':
        case 'testing':
            config = testingConfig;
            break;
        case 'development':
        default:
            config = developmentConfig;
            break;
    }

    // Fail-fast validation
    validateConfig(config);

    // Deep freeze for immutability
    return deepFreeze(config);
}

function deepFreeze<T extends object>(obj: T): T {
    Object.keys(obj).forEach(prop => {
        const value = (obj as Record<string, unknown>)[prop];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    });
    return Object.freeze(obj);
}

// Single immutable configuration instance
export const CONFIG = loadConfig();
