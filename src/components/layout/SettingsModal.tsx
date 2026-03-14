import { useState, useEffect } from 'react';
import { X, RotateCcw, Check, Loader2 } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

interface LlamaServerDraft {
    port: number;
    contextSize: number;
    gpuLayers: number;
    threads: number;
    batchSize: number;
}

interface SettingFieldProps {
    label: string;
    description: string;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
}

function SettingField({ label, description, value, onChange, min = 0, max, step = 1 }: SettingFieldProps) {
    return (
        <div className="flex items-center justify-between gap-4 py-3 border-b border-neutral-700/50 last:border-b-0">
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-200">{label}</div>
                <div className="text-xs text-neutral-500 mt-0.5">{description}</div>
            </div>
            <input
                type="number"
                value={value}
                onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v)) onChange(v);
                }}
                min={min}
                max={max}
                step={step}
                className="w-24 px-3 py-1.5 text-sm bg-neutral-900 border border-neutral-700 rounded-lg text-neutral-200 focus:outline-none focus:border-indigo-500 transition-colors text-right"
            />
        </div>
    );
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { llamaServer, applySettings, resetLlamaServerDefaults, isSaving } = useSettingsStore();
    const [draft, setDraft] = useState<LlamaServerDraft>({ ...llamaServer });
    const [hasChanges, setHasChanges] = useState(false);

    // Sync draft with store when modal opens
    useEffect(() => {
        if (isOpen) {
            setDraft({ ...llamaServer });
            setHasChanges(false);
        }
    }, [isOpen, llamaServer]);

    const updateDraft = <K extends keyof LlamaServerDraft>(key: K, value: LlamaServerDraft[K]) => {
        setDraft(prev => {
            const next = { ...prev, [key]: value };
            // Check if any field differs from store
            const changed = (Object.keys(next) as (keyof LlamaServerDraft)[]).some(
                k => next[k] !== llamaServer[k]
            );
            setHasChanges(changed);
            return next;
        });
    };

    const handleApply = async () => {
        await applySettings(draft);
        setHasChanges(false);
    };

    const handleReset = async () => {
        await resetLlamaServerDefaults();
        setHasChanges(false);
    };

    const handleClose = () => {
        // Close without applying — draft is discarded
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4">
            <div className="bg-neutral-800 border border-neutral-700 rounded-xl w-full max-w-lg overflow-hidden flex flex-col shadow-2xl max-h-[80vh]">
                <div className="flex items-center justify-between p-4 border-b border-neutral-700">
                    <h2 className="text-lg font-semibold text-white">Settings</h2>
                    <button
                        onClick={handleClose}
                        className="text-neutral-400 hover:text-white p-1 rounded-lg hover:bg-neutral-700 transition"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="p-6 space-y-6 flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-neutral-700">
                    <div>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-medium text-neutral-300 uppercase tracking-wider">
                                Llama Server Configuration
                            </h3>
                            <button
                                onClick={handleReset}
                                disabled={isSaving}
                                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-neutral-400 hover:text-white bg-neutral-700/50 hover:bg-neutral-700 rounded-lg transition-colors disabled:opacity-50"
                                title="Reset to defaults"
                            >
                                <RotateCcw size={12} />
                                Reset
                            </button>
                        </div>

                        <div className="glass-panel p-4 rounded-lg">
                            <SettingField
                                label="Port"
                                description="Server port for llama-server"
                                value={draft.port}
                                onChange={(v) => updateDraft('port', v)}
                                min={1}
                                max={65535}
                            />
                            <SettingField
                                label="Context Size"
                                description="Maximum context window size in tokens"
                                value={draft.contextSize}
                                onChange={(v) => updateDraft('contextSize', v)}
                                min={128}
                                step={256}
                            />
                            <SettingField
                                label="GPU Layers"
                                description="Number of layers to offload to GPU (0 = CPU only)"
                                value={draft.gpuLayers}
                                onChange={(v) => updateDraft('gpuLayers', v)}
                                min={0}
                            />
                            <SettingField
                                label="Threads"
                                description="Number of CPU threads to use for inference"
                                value={draft.threads}
                                onChange={(v) => updateDraft('threads', v)}
                                min={1}
                            />
                            <SettingField
                                label="Batch Size"
                                description="Batch size for prompt evaluation"
                                value={draft.batchSize}
                                onChange={(v) => updateDraft('batchSize', v)}
                                min={1}
                                step={64}
                            />
                        </div>
                    </div>
                </div>

                {/* Footer with Apply button */}
                <div className="flex items-center justify-between p-4 border-t border-neutral-700 bg-neutral-800/80">
                    <p className="text-xs text-neutral-500">
                        Changes apply on next model load.
                    </p>
                    <button
                        onClick={handleApply}
                        disabled={!hasChanges || isSaving}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30"
                    >
                        {isSaving ? (
                            <Loader2 size={14} className="animate-spin" />
                        ) : (
                            <Check size={14} />
                        )}
                        Apply Changes
                    </button>
                </div>
            </div>
        </div>
    );
}
