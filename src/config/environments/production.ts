import type { AppConfig } from '../schema';
import { baseConfig } from './base';

export const productionConfig: AppConfig = {
    ...baseConfig,
    environment: 'production',
    ui: {
        ...baseConfig.ui,
        animationsEnabled: true,
    },
    llamaServer: {
        ...baseConfig.llamaServer,
    },
};
