import { useModelStore } from '../../store/modelStore';
import { Cpu, Link, Settings2, FolderOpen, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dropdown } from '../ui/Dropdown';
import { open } from '@tauri-apps/plugin-dialog';
import { CONFIG } from '../../config';
import { DROPDOWN_ACTION_IDS } from '../../constants';

export function ModelSelector() {
    const { 
        models, 
        activeModel, 
        setActiveModel, 
        loadModels, 
        isLoading,
        isModelLoading,
        modelLoadError,
        clearModelLoadError,
        useCustomUrl,
        customUrl,
        setUseCustomUrl,
        setCustomUrl,
        addCustomLocalModel,
        removeModel
    } = useModelStore();

    const [isEditingUrl, setIsEditingUrl] = useState(false);
    const [tempUrl, setTempUrl] = useState(customUrl);

    useEffect(() => {
        loadModels();
    }, [loadModels]);

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400 glass-panel rounded-lg">
                <Cpu size={18} className="animate-pulse" />
                <span>Loading...</span>
            </div>
        );
    }

    const dropdownOptions = [
        ...models.map((model) => ({
            id: model,
            value: model,
            label: model.split('/').pop() || model,
            icon: <Cpu size={16} className="text-neutral-400" />
        })),
        {
            id: DROPDOWN_ACTION_IDS.BROWSE_MODEL,
            value: DROPDOWN_ACTION_IDS.BROWSE_MODEL,
            label: 'Browse for Model...',
            icon: <FolderOpen size={16} className="text-neutral-400" />
        }
    ];

    if (CONFIG.model.allowCustomUrl) {
        dropdownOptions.push({
            id: DROPDOWN_ACTION_IDS.CUSTOM_URL,
            value: DROPDOWN_ACTION_IDS.CUSTOM_URL,
            label: 'Custom Server URL',
            icon: <Link size={16} className="text-neutral-400" />
        });
    }

    const currentDropdownValue = useCustomUrl ? DROPDOWN_ACTION_IDS.CUSTOM_URL : (activeModel || '');

    const handleDropdownChange = async (value: string) => {
        if (value === DROPDOWN_ACTION_IDS.CUSTOM_URL) {
            setUseCustomUrl(true);
            setIsEditingUrl(true);
        } else if (value === DROPDOWN_ACTION_IDS.BROWSE_MODEL) {
            try {
                const selected = await open({
                    multiple: false,
                    filters: [{
                        name: 'GGUF Models',
                        extensions: ['gguf']
                    }]
                });
                if (selected && typeof selected === 'string') {
                    addCustomLocalModel(selected);
                } else if (activeModel) {
                     setActiveModel(activeModel);
                }
            } catch (err) {
                console.error("Failed to open dialog", err);
            }
        } else {
            setActiveModel(value);
            setIsEditingUrl(false);
        }
    };

    const handleRemoveModel = (value: string) => {
        // Don't allow removing built-in action items
        if (value === DROPDOWN_ACTION_IDS.BROWSE_MODEL || value === DROPDOWN_ACTION_IDS.CUSTOM_URL) {
            return;
        }
        removeModel(value);
    };

    const handleUrlSubmit = () => {
        setCustomUrl(tempUrl);
        setIsEditingUrl(false);
    };

    return (
        <div className="relative group inline-flex flex-col gap-2 max-w-full">
            <div className="flex items-center gap-2">
                <Dropdown
                    options={dropdownOptions}
                    value={currentDropdownValue}
                    onChange={handleDropdownChange}
                    onRemove={handleRemoveModel}
                    nonRemovableValues={[DROPDOWN_ACTION_IDS.BROWSE_MODEL, DROPDOWN_ACTION_IDS.CUSTOM_URL]}
                    placeholder="Select Model"
                    className="w-64 z-50"
                />
                
                {isModelLoading && (
                    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--accent-color)] glass-panel rounded-full animate-pulse whitespace-nowrap">
                        <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-color)]"></div>
                        Starting Engine...
                    </div>
                )}
                
                {useCustomUrl && (
                    <div className={`transition-all duration-300 overflow-hidden flex items-center ${isEditingUrl ? 'opacity-100 max-w-xs' : 'opacity-0 max-w-0'}`}>
                        <input 
                            type="text" 
                            value={tempUrl}
                            onChange={(e) => setTempUrl(e.target.value)}
                            onBlur={handleUrlSubmit}
                            onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
                            placeholder="http://localhost:8080/completion"
                            className="premium-input px-3 py-1.5 text-sm w-full outline-none focus:ring-0"
                            autoFocus
                        />
                    </div>
                )}
                {useCustomUrl && !isEditingUrl && (
                    <button 
                        onClick={() => setIsEditingUrl(true)}
                        className="p-2 text-neutral-400 hover:text-white glass-panel hover:bg-white/10 transition-colors rounded-lg flex-shrink-0"
                        title="Edit custom URL"
                    >
                        <Settings2 size={16} />
                    </button>
                )}
            </div>

            {modelLoadError && (
                <div className="flex items-center gap-2 px-3 py-2 text-xs bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 max-w-sm animate-[slide-up_0.2s_ease-out]">
                    <XCircle size={14} className="shrink-0" />
                    <span className="flex-1 truncate">{modelLoadError}</span>
                    <button
                        onClick={clearModelLoadError}
                        className="shrink-0 hover:text-red-300 transition-colors text-xs underline"
                    >
                        Dismiss
                    </button>
                </div>
            )}
        </div>
    );
}
