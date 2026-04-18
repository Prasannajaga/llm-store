import { useModelStore } from '../../store/modelStore';
import { Cpu, Link, Settings2, FolderOpen, XCircle, KeyRound, Globe, X } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { Dropdown } from '../ui/Dropdown';
import { open } from '@tauri-apps/plugin-dialog';
import { CONFIG } from '../../config';
import { DROPDOWN_ACTION_IDS } from '../../constants';
import { IconButton } from '../ui/IconButton';
import { TextInput } from '../ui/TextInput';

function isExternalModelPath(model: string): boolean {
    return model.startsWith('/') || model.includes('\\') || /^[a-zA-Z]:[\\/]/.test(model);
}

export const ModelSelector = memo(function ModelSelector() {
    const models = useModelStore((state) => state.models);
    const activeModel = useModelStore((state) => state.activeModel);
    const setActiveModel = useModelStore((state) => state.setActiveModel);
    const loadModels = useModelStore((state) => state.loadModels);
    const isLoading = useModelStore((state) => state.isLoading);
    const isModelLoading = useModelStore((state) => state.isModelLoading);
    const modelLoadError = useModelStore((state) => state.modelLoadError);
    const clearModelLoadError = useModelStore((state) => state.clearModelLoadError);
    const useCustomUrl = useModelStore((state) => state.useCustomUrl);
    const customUrl = useModelStore((state) => state.customUrl);
    const customApiKey = useModelStore((state) => state.customApiKey);
    const setCustomServerConfig = useModelStore((state) => state.setCustomServerConfig);
    const addCustomLocalModel = useModelStore((state) => state.addCustomLocalModel);
    const removeModel = useModelStore((state) => state.removeModel);

    const [isCustomServerModalOpen, setIsCustomServerModalOpen] = useState(false);
    const [tempUrl, setTempUrl] = useState(customUrl);
    const [tempApiKey, setTempApiKey] = useState(customApiKey);
    const [customServerError, setCustomServerError] = useState<string | null>(null);

    useEffect(() => {
        loadModels();
    }, [loadModels]);

    useEffect(() => {
        setTempUrl(customUrl);
    }, [customUrl]);

    useEffect(() => {
        setTempApiKey(customApiKey);
    }, [customApiKey]);

    const displayModels = useMemo(() => {
        if (!activeModel || models.includes(activeModel)) {
            return models;
        }
        return [activeModel, ...models];
    }, [activeModel, models]);

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-400 rounded-lg border border-neutral-700 bg-[var(--surface-elevated)]">
                <Cpu size={18} className="animate-pulse" />
                <span>Loading...</span>
            </div>
        );
    }

    const dropdownOptions = [
        ...displayModels.map((model) => ({
            id: model,
            value: model,
            label: model.split(/[\\/]/).pop() || model,
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
    const nonRemovableModels = models.filter((model) => !isExternalModelPath(model));

    const handleDropdownChange = async (value: string) => {
        if (value === DROPDOWN_ACTION_IDS.CUSTOM_URL) {
            setTempUrl(customUrl);
            setTempApiKey(customApiKey);
            setCustomServerError(null);
            setIsCustomServerModalOpen(true);
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
            setIsCustomServerModalOpen(false);
        }
    };

    const handleRemoveModel = (value: string) => {
        // Don't allow removing built-in action items
        if (value === DROPDOWN_ACTION_IDS.BROWSE_MODEL || value === DROPDOWN_ACTION_IDS.CUSTOM_URL) {
            return;
        }
        if (!isExternalModelPath(value)) {
            return;
        }
        removeModel(value);
    };

    const closeCustomServerModal = () => {
        setIsCustomServerModalOpen(false);
        setCustomServerError(null);
    };

    const handleCustomServerSubmit = () => {
        const normalizedUrl = tempUrl.trim();
        if (!normalizedUrl) {
            setCustomServerError('URL is required.');
            return;
        }
        try {
            const parsed = new URL(normalizedUrl);
            if (!parsed.protocol.startsWith('http')) {
                throw new Error('Unsupported protocol');
            }
        } catch {
            setCustomServerError('Enter a valid HTTP/HTTPS URL.');
            return;
        }

        setCustomServerConfig(normalizedUrl, tempApiKey.trim());
        closeCustomServerModal();
    };

    const handleModalFieldKeyDown = (key: string) => {
        if (key === 'Enter') {
            handleCustomServerSubmit();
        } else if (key === 'Escape') {
            closeCustomServerModal();
        }
    };

    return (
        <>
            <div className="relative group inline-flex flex-col gap-2 max-w-full">
                <div className="flex items-center gap-2">
                    <Dropdown
                        options={dropdownOptions}
                        value={currentDropdownValue}
                        onChange={handleDropdownChange}
                        onRemove={handleRemoveModel}
                        disabled={isModelLoading}
                        nonRemovableValues={[
                            DROPDOWN_ACTION_IDS.BROWSE_MODEL,
                            DROPDOWN_ACTION_IDS.CUSTOM_URL,
                            ...nonRemovableModels,
                        ]}
                        placeholder="Select Model"
                        className="w-64 z-50"
                    />

                    {isModelLoading && (
                        <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--accent-color)] rounded-full border border-neutral-700 bg-[var(--surface-elevated)] animate-pulse whitespace-nowrap">
                            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-color)]"></div>
                            Starting Engine...
                        </div>
                    )}

                    {useCustomUrl && (
                        <IconButton
                            onClick={() => {
                                setTempUrl(customUrl);
                                setTempApiKey(customApiKey);
                                setCustomServerError(null);
                                setIsCustomServerModalOpen(true);
                            }}
                            icon={<Settings2 size={16} />}
                            ariaLabel="Edit custom server credentials"
                            size="md"
                            className="border border-neutral-700 bg-[var(--surface-elevated)] hover:bg-white/5 flex-shrink-0"
                        />
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

            {isCustomServerModalOpen && (
                <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
                    <div className="w-full max-w-md overflow-hidden rounded-xl border border-neutral-700 bg-neutral-800 shadow-2xl">
                        <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-3">
                            <h3 className="text-sm font-semibold text-white">Custom Server</h3>
                            <IconButton
                                onClick={closeCustomServerModal}
                                icon={<X size={16} />}
                                ariaLabel="Close custom server modal"
                                size="xs"
                            />
                        </div>

                        <div className="space-y-4 px-4 py-4">
                            <div>
                                <label className="mb-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                                    <Globe size={13} />
                                    URL
                                </label>
                                <TextInput
                                    type="text"
                                    value={tempUrl}
                                    onChange={(e) => setTempUrl(e.target.value)}
                                    onKeyDown={(e) => handleModalFieldKeyDown(e.key)}
                                    placeholder="https://your-host/v1/chat/completions"
                                    inputSize="md"
                                    className="w-full bg-neutral-900"
                                    autoFocus
                                    aria-label="Custom server URL"
                                />
                            </div>

                            <div>
                                <label className="mb-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-neutral-300">
                                    <KeyRound size={13} />
                                    API key
                                </label>
                                <TextInput
                                    type="password"
                                    value={tempApiKey}
                                    onChange={(e) => setTempApiKey(e.target.value)}
                                    onKeyDown={(e) => handleModalFieldKeyDown(e.key)}
                                    placeholder="sk-... (optional)"
                                    inputSize="md"
                                    className="w-full bg-neutral-900"
                                    aria-label="Custom server API key"
                                />
                                <p className="mt-1 text-[11px] text-neutral-500">
                                    Sent as `Authorization: Bearer &lt;API key&gt;` for custom URL requests.
                                </p>
                            </div>

                            {customServerError && (
                                <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-300">
                                    {customServerError}
                                </div>
                            )}
                        </div>

                        <div className="flex items-center justify-end gap-2 border-t border-neutral-700 bg-neutral-800/70 px-4 py-3">
                            <button
                                onClick={closeCustomServerModal}
                                className="rounded-lg border border-neutral-600 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700/60 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCustomServerSubmit}
                                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
                            >
                                Use Custom Server
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
});
