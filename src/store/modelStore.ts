import { create } from 'zustand';
import { modelService } from '../services/modelService';

interface ModelState {
    models: string[];
    activeModel: string | null;
    isLoading: boolean;
    loadModels: () => Promise<void>;
    setActiveModel: (model: string | null) => void;
}

export const useModelStore = create<ModelState>((set) => ({
    models: [],
    activeModel: null,
    isLoading: false,

    loadModels: async () => {
        set({ isLoading: true });
        try {
            const models = await modelService.listModels();
            set({
                models,
                isLoading: false,
                activeModel: models.length > 0 ? models[0] : null
            });
        } catch (err) {
            console.error('Failed to load models:', err);
            set({ isLoading: false });
        }
    },

    setActiveModel: (model) => {
        set({ activeModel: model });
        if (model) {
            modelService.loadModel(model).catch(console.error);
        }
    },
}));
