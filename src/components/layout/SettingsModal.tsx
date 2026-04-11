import { useMemo, useState } from 'react';
import { X, RotateCcw, Check, Loader2 } from 'lucide-react';
import { useSettingsStore, type LlamaPreset } from '../../store/settingsStore';
import { CONFIG } from '../../config';
import { settingsService } from '../../services/settingsService';

interface SettingsModalProps {
    onClose: () => void;
}

interface SettingsDraft {
    // Llama server
    executablePath: string;
    port: number;
    contextSize: number;
    gpuLayers: number;
    threads: number;
    batchSize: number;
    // Generation
    maxTokens: number;
    temperature: number;
    topP: number;
    topK: number;
    repeatPenalty: number;
    thinkingMode: boolean;
    maxContextChars: number;
    maxPromptChars: number;
}

type LlamaServerDraft = Pick<
    SettingsDraft,
    'executablePath' | 'port' | 'contextSize' | 'gpuLayers' | 'threads' | 'batchSize'
>;

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
                    const v = parseFloat(e.target.value);
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

interface SettingTextFieldProps {
    label: string;
    description: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

interface SettingToggleFieldProps {
    label: string;
    description: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}

function SettingTextField({ label, description, value, onChange, placeholder }: SettingTextFieldProps) {
    return (
        <div className="flex flex-col gap-2 py-3 border-b border-neutral-700/50 last:border-b-0">
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-200">{label}</div>
                <div className="text-xs text-neutral-500 mt-0.5">{description}</div>
            </div>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full px-3 py-1.5 text-sm bg-neutral-900 border border-neutral-700 rounded-lg text-neutral-200 focus:outline-none focus:border-indigo-500 transition-colors"
                spellCheck={false}
            />
        </div>
    );
}

function SettingToggleField({ label, description, checked, onChange }: SettingToggleFieldProps) {
    return (
        <div className="flex items-center justify-between gap-4 py-3 border-b border-neutral-700/50 last:border-b-0">
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-200">{label}</div>
                <div className="text-xs text-neutral-500 mt-0.5">{description}</div>
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={() => onChange(!checked)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    checked ? 'bg-indigo-500' : 'bg-neutral-700'
                }`}
            >
                <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                        checked ? 'translate-x-5' : 'translate-x-1'
                    }`}
                />
            </button>
        </div>
    );
}

const DRAFT_KEYS: (keyof SettingsDraft)[] = [
    'executablePath',
    'port',
    'contextSize',
    'gpuLayers',
    'threads',
    'batchSize',
    'maxTokens',
    'temperature',
    'topP',
    'topK',
    'repeatPenalty',
    'thinkingMode',
    'maxContextChars',
    'maxPromptChars',
];

const LLAMA_KEYS: (keyof LlamaServerDraft)[] = [
    'executablePath',
    'port',
    'contextSize',
    'gpuLayers',
    'threads',
    'batchSize',
];

function isLlamaKey(key: keyof SettingsDraft): key is keyof LlamaServerDraft {
    return LLAMA_KEYS.includes(key as keyof LlamaServerDraft);
}

function detectHardwareThreads(): number {
    if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
        return navigator.hardwareConcurrency;
    }
    return 8;
}

function toLlamaDraft(draft: SettingsDraft): LlamaServerDraft {
    return {
        executablePath: draft.executablePath,
        port: draft.port,
        contextSize: draft.contextSize,
        gpuLayers: draft.gpuLayers,
        threads: draft.threads,
        batchSize: draft.batchSize,
    };
}

function toSettingsDraft(
    current: SettingsDraft,
    llama: LlamaServerDraft,
): SettingsDraft {
    return {
        ...current,
        ...llama,
    };
}

function buildPresetLlamaConfig(
    preset: Exclude<LlamaPreset, 'custom'>,
    current: SettingsDraft,
): LlamaServerDraft {
    const cores = detectHardwareThreads();
    const base: LlamaServerDraft = {
        executablePath: current.executablePath || 'llama-server',
        port: current.port || 8080,
        contextSize: current.contextSize,
        gpuLayers: current.gpuLayers,
        threads: current.threads,
        batchSize: current.batchSize,
    };

    if (preset === 'cpu_optimized') {
        const threads = Math.max(2, cores - 1);
        return {
            ...base,
            contextSize: 2048,
            gpuLayers: 0,
            threads,
            batchSize: threads >= 10 ? 512 : 256,
        };
    }

    return {
        ...base,
        contextSize: 4096,
        gpuLayers: 99,
        threads: Math.max(4, Math.floor(cores / 2)),
        batchSize: 1024,
    };
}

function llamaDraftEquals(a: LlamaServerDraft, b: LlamaServerDraft): boolean {
    return LLAMA_KEYS.every((key) => a[key] === b[key]);
}

export function SettingsModal({ onClose }: SettingsModalProps) {
    const {
        llamaServer,
        generation,
        llamaPreset,
        applySettings,
        resetLlamaServerDefaults,
        isSaving,
    } = useSettingsStore();
    const [draft, setDraft] = useState<SettingsDraft>(() => ({ ...llamaServer, ...generation }));
    const [baseline, setBaseline] = useState<SettingsDraft>(() => ({ ...llamaServer, ...generation }));
    const [selectedPreset, setSelectedPreset] = useState<LlamaPreset>(llamaPreset);
    const [baselinePreset, setBaselinePreset] = useState<LlamaPreset>(llamaPreset);
    const [exportStatus, setExportStatus] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState(false);

    const hasChanges = useMemo(
        () => DRAFT_KEYS.some((key) => draft[key] !== baseline[key]) || selectedPreset !== baselinePreset,
        [draft, baseline, selectedPreset, baselinePreset],
    );

    const updateDraft = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
        setDraft(prev => {
            const next = { ...prev, [key]: value };
            if (selectedPreset !== 'custom' && isLlamaKey(key)) {
                const expected = buildPresetLlamaConfig(selectedPreset, next);
                if (!llamaDraftEquals(toLlamaDraft(next), expected)) {
                    setSelectedPreset('custom');
                }
            }
            return next;
        });
    };

    const handleSelectPreset = (preset: LlamaPreset) => {
        setSelectedPreset(preset);
        if (preset === 'custom') {
            return;
        }
        setDraft((prev) => {
            const nextLlama = buildPresetLlamaConfig(preset, prev);
            return toSettingsDraft(prev, nextLlama);
        });
    };

    const handleApply = async () => {
        await applySettings(draft, selectedPreset);
        setBaseline(draft);
        setBaselinePreset(selectedPreset);
    };

    const handleReset = async () => {
        await resetLlamaServerDefaults();
        const cpuDefaults = buildPresetLlamaConfig('cpu_optimized', {
            ...CONFIG.llamaServer,
            ...CONFIG.generation,
        });
        const defaults: SettingsDraft = {
            ...CONFIG.generation,
            ...cpuDefaults,
        };
        setDraft(defaults);
        setBaseline(defaults);
        setSelectedPreset('cpu_optimized');
        setBaselinePreset('cpu_optimized');
    };

    const handleClose = () => {
        // Close without applying — draft is discarded
        onClose();
    };

    const handleExportWorkspaceBackup = async () => {
        setIsExporting(true);
        setExportStatus(null);
        try {
            const payload = await settingsService.exportWorkspaceBackup();
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `llm-store-workspace-backup-${ts}.json`;
            const blob = new Blob([payload], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
            URL.revokeObjectURL(url);
            setExportStatus('Workspace backup exported successfully.');
        } catch (err) {
            console.error('Failed to export workspace backup:', err);
            setExportStatus('Failed to export workspace backup.');
        } finally {
            setIsExporting(false);
        }
    };

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
                    {/* ─── Llama Server Section ─── */}
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
                                Reset All
                            </button>
                        </div>

                        <div className="glass-panel p-4 rounded-lg">
                            <div className="pb-3 border-b border-neutral-700/50">
                                <div className="text-sm font-medium text-neutral-200">Preset Template</div>
                                <div className="text-xs text-neutral-500 mt-0.5">
                                    Quick tuning profile for llama-server. You can still edit values below.
                                </div>
                                <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    {([
                                        {
                                            id: 'cpu_optimized',
                                            label: 'CPU Optimized',
                                            description: 'Best for most laptops',
                                        },
                                        {
                                            id: 'gpu_optimized',
                                            label: 'GPU Optimized',
                                            description: 'Higher throughput if GPU supports offload',
                                        },
                                        {
                                            id: 'custom',
                                            label: 'Custom',
                                            description: 'Manual control',
                                        },
                                    ] as const).map((option) => (
                                        <button
                                            key={option.id}
                                            onClick={() => handleSelectPreset(option.id)}
                                            className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                                                selectedPreset === option.id
                                                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-200'
                                                    : 'border-neutral-700 bg-neutral-900 hover:border-neutral-500 text-neutral-300'
                                            }`}
                                        >
                                            <div className="text-xs font-semibold">{option.label}</div>
                                            <div className="text-[11px] mt-1 text-neutral-400">{option.description}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <SettingTextField
                                label="Executable Path"
                                description="Absolute path or global command (e.g., 'llama-server' or '/opt/homebrew/bin/llama-server')"
                                value={draft.executablePath}
                                onChange={(v) => updateDraft('executablePath', v)}
                                placeholder="llama-server"
                            />
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
                                description="Maximum context window size in tokens (memory allocation)"
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

                    {/* ─── Generation Parameters Section ─── */}
                    <div>
                        <h3 className="text-sm font-medium text-neutral-300 uppercase tracking-wider mb-4">
                            Generation Parameters
                        </h3>

                        <div className="glass-panel p-4 rounded-lg">
                            <SettingField
                                label="Max Tokens"
                                description="Maximum number of tokens to generate per response"
                                value={draft.maxTokens}
                                onChange={(v) => updateDraft('maxTokens', v)}
                                min={1}
                                max={8192}
                                step={64}
                            />
                            <SettingField
                                label="Temperature"
                                description="Controls randomness (0 = deterministic, higher = more creative)"
                                value={draft.temperature}
                                onChange={(v) => updateDraft('temperature', v)}
                                min={0}
                                max={2}
                                step={0.05}
                            />
                            <SettingField
                                label="Top P"
                                description="Nucleus sampling threshold (0-1, lower = more focused)"
                                value={draft.topP}
                                onChange={(v) => updateDraft('topP', v)}
                                min={0.01}
                                max={1}
                                step={0.05}
                            />
                            <SettingField
                                label="Top K"
                                description="Limits token candidates per step (0 = disabled)"
                                value={draft.topK}
                                onChange={(v) => updateDraft('topK', v)}
                                min={0}
                                max={200}
                            />
                            <SettingField
                                label="Repeat Penalty"
                                description="Penalizes repeated tokens (1.0 = no penalty, higher = less repetition)"
                                value={draft.repeatPenalty}
                                onChange={(v) => updateDraft('repeatPenalty', v)}
                                min={0.5}
                                max={2}
                                step={0.05}
                            />
                            <SettingToggleField
                                label="Thinking Mode"
                                description="Enable reasoning tags/stream. Disable for direct answers without reasoning trace."
                                checked={draft.thinkingMode}
                                onChange={(v) => updateDraft('thinkingMode', v)}
                            />
                            <SettingField
                                label="Max Context Chars"
                                description="Pipeline cap for total knowledge context included in a prompt."
                                value={draft.maxContextChars}
                                onChange={(v) => updateDraft('maxContextChars', v)}
                                min={1500}
                                step={500}
                            />
                            <SettingField
                                label="Max Prompt Chars"
                                description="Hard cap for final prompt size after template application."
                                value={draft.maxPromptChars}
                                onChange={(v) => updateDraft('maxPromptChars', v)}
                                min={4000}
                                step={500}
                            />
                        </div>
                    </div>

                    <div>
                        <h3 className="text-sm font-medium text-neutral-300 uppercase tracking-wider mb-4">
                            Data Backup
                        </h3>
                        <div className="glass-panel p-4 rounded-lg">
                            <div className="text-sm font-medium text-neutral-200">Workspace Export</div>
                            <div className="text-xs text-neutral-500 mt-0.5">
                                Export chats, messages, feedback, settings, registered models, and knowledge store as JSON.
                            </div>
                            <button
                                onClick={handleExportWorkspaceBackup}
                                disabled={isExporting}
                                className="mt-3 flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-neutral-700 hover:bg-neutral-600 text-white disabled:opacity-50"
                            >
                                {isExporting ? <Loader2 size={14} className="animate-spin" /> : null}
                                Export Workspace Backup
                            </button>
                            {exportStatus ? (
                                <p className="text-xs text-neutral-500 mt-2">{exportStatus}</p>
                            ) : null}
                        </div>
                    </div>
                </div>

                {/* Footer with Apply button */}
                <div className="flex items-center justify-between p-4 border-t border-neutral-700 bg-neutral-800/80">
                    <p className="text-xs text-neutral-500">
                        Server changes apply on next model load. Generation params apply immediately.
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
