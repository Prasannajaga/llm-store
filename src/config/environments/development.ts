import type { AppConfig } from '../schema';
import { baseConfig } from './base';

export const developmentConfig: AppConfig = {
    ...baseConfig,
    environment: 'development',
    model: {
        ...baseConfig.model,
    },
    ui: {
        ...baseConfig.ui,
        animationsEnabled: true,
    },
    llamaServer: {
        ...baseConfig.llamaServer,
    },
};
