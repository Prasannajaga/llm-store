import { useModelStore } from '../../store/modelStore';
import { ChevronDown, Cpu } from 'lucide-react';
import { useEffect } from 'react';

export function ModelSelector() {
    const { models, activeModel, setActiveModel, loadModels, isLoading } = useModelStore();

    useEffect(() => {
        loadModels();
    }, [loadModels]);

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400">
                <Cpu size={18} className="animate-pulse" />
                <span>Loading...</span>
            </div>
        );
    }

    if (models.length === 0) {
        return null;
    }

    return (
        <div className="relative group inline-block">
            <select
                value={activeModel || ''}
                onChange={(e) => setActiveModel(e.target.value)}
                className="appearance-none bg-transparent hover:bg-neutral-800/80 text-neutral-200 text-lg font-medium rounded-xl px-3 py-2 pr-8 focus:outline-none cursor-pointer transition-colors"
                title="Select Model"
            >
                {models.map((model) => (
                    <option key={model} value={model} className="bg-neutral-900 text-base font-normal">
                        {model}
                    </option>
                ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-neutral-400 group-hover:text-neutral-200 transition-colors">
                <ChevronDown size={18} strokeWidth={2.5} />
            </div>
        </div>
    );
}
