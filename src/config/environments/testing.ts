import type { AppConfig } from '../schema';
import { baseConfig } from './base';

export const testingConfig: AppConfig = {
    ...baseConfig,
    environment: 'testing',
    ui: {
        ...baseConfig.ui,
        animationsEnabled: false,
    },
    llamaServer: {
        ...baseConfig.llamaServer,
    },
    generation: {
        ...baseConfig.generation,
    },
};
