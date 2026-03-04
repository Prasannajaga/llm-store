import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { EVENTS } from '../constants';

export const streamService = {
    async generateStream(prompt: string): Promise<void> {
        return invoke('generate_stream', { prompt });
    },

    async cancelGeneration(): Promise<void> {
        return invoke('cancel_generation');
    },

    async onTokenStream(callback: (token: string) => void): Promise<UnlistenFn> {
        return listen<string>(EVENTS.TOKEN_STREAM, (event) => {
            callback(event.payload);
        });
    },

    async onGenerationComplete(callback: () => void): Promise<UnlistenFn> {
        return listen(EVENTS.GENERATION_COMPLETE, () => {
            callback();
        });
    },

    async onGenerationError(callback: (error: string) => void): Promise<UnlistenFn> {
        return listen<string>(EVENTS.GENERATION_ERROR, (event) => {
            callback(event.payload);
        });
    },
};
