import { useMemo, useState } from 'react';
import { X, RotateCcw, Check, Loader2 } from 'lucide-react';
import { useSettingsStore, type LlamaPreset } from '../../store/settingsStore';
import { CONFIG } from '../../config';
import { TextInput } from '../ui/TextInput';
import { IconButton } from '../ui/IconButton';
import { ThinkingModeSwitch } from '../ui/ThinkingModeSwitch';

interface SettingsModalProps {
    onClose?: () => void;
    mode?: 'modal' | 'page';
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
    description?: string;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
}

function SettingField({ label, description, value, onChange, min = 0, max, step = 1 }: SettingFieldProps) {
    return (
        <div className="flex items-center justify-between gap-4 py-2.5 border-b border-neutral-700/60 last:border-b-0">
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-200">{label}</div>
                {description ? (
                    <div className="text-[11px] text-neutral-500 mt-0.5">{description}</div>
                ) : null}
            </div>
            <TextInput
                type="number"
                value={value}
                onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) onChange(v);
                }}
                min={min}
                max={max}
                step={step}
                inputSize="sm"
                className="w-24 text-right"
                aria-label={label}
            />
        </div>
    );
}

interface SettingTextFieldProps {
    label: string;
    description?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

function SettingTextField({ label, description, value, onChange, placeholder }: SettingTextFieldProps) {
    return (
        <div className="flex flex-col gap-2 py-2.5 border-b border-neutral-700/60 last:border-b-0">
            <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-200">{label}</div>
                {description ? (
                    <div className="text-[11px] text-neutral-500 mt-0.5">{description}</div>
                ) : null}
            </div>
            <TextInput
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                inputSize="md"
                className="w-full"
                spellCheck={false}
                aria-label={label}
            />
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

export function SettingsModal({ onClose, mode = 'modal' }: SettingsModalProps) {
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
    const isModal = mode === 'modal';

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
        if (onClose) {
            // Close without applying — draft is discarded
            onClose();
            return;
        }
        // In page mode, "close/cancel" resets local draft to baseline.
        setDraft(baseline);
        setSelectedPreset(baselinePreset);
    };

    return (
        <div className={isModal ? 'fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4' : 'flex-1 min-h-0 flex flex-col h-full bg-[var(--surface-app)] overflow-hidden'}>
            <div className={isModal ? 'w-full max-w-3xl max-h-[86vh] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl flex flex-col' : 'flex-1 min-h-0 overflow-hidden flex flex-col'}>
                <div className={isModal ? 'flex items-center justify-between border-b border-neutral-700 px-4 py-3' : 'shrink-0 px-4 md:px-6 pt-5 md:pt-6 pb-4 border-b border-neutral-700/50 flex items-center justify-between'}>
                    <div>
                        <h2 className={`${isModal ? 'text-base' : 'text-lg'} font-semibold text-white`}>Settings</h2>
                        <p className="text-xs text-neutral-500">Simple runtime and generation controls.</p>
                    </div>
                    {onClose && (
                        <IconButton
                            onClick={handleClose}
                            icon={<X size={18} />}
                            ariaLabel="Close settings"
                            size="sm"
                        />
                    )}
                </div>

                <div className={isModal
                    ? 'flex-1 overflow-y-auto p-4 md:p-5 space-y-4 scrollbar-thin scrollbar-thumb-neutral-700'
                    : 'flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5 space-y-4 scrollbar-thin scrollbar-thumb-neutral-700'}
                >
                    <section className="rounded-lg border border-neutral-700 bg-neutral-800/40 px-4 py-3">
                        <div className="mb-2.5 flex items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold text-neutral-200">Server</h3>
                            <button
                                onClick={handleReset}
                                disabled={isSaving}
                                className="inline-flex items-center gap-1.5 rounded-md border border-neutral-600 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-700/70 transition-colors disabled:opacity-50"
                                title="Reset server settings"
                            >
                                <RotateCcw size={12} />
                                Reset
                            </button>
                        </div>

                        <div className="pb-2.5 border-b border-neutral-700/60">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                {([
                                    { id: 'cpu_optimized', label: 'CPU Optimized' },
                                    { id: 'gpu_optimized', label: 'GPU Optimized' },
                                    { id: 'custom', label: 'Custom' },
                                ] as const).map((option) => (
                                    <button
                                        key={option.id}
                                        onClick={() => handleSelectPreset(option.id)}
                                        className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                                            selectedPreset === option.id
                                                ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200'
                                                : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500'
                                        }`}
                                    >
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <SettingTextField
                            label="Executable Path"
                            description="Binary path or command"
                            value={draft.executablePath}
                            onChange={(v) => updateDraft('executablePath', v)}
                            placeholder="llama-server"
                        />
                        <SettingField
                            label="Port"
                            value={draft.port}
                            onChange={(v) => updateDraft('port', v)}
                            min={1}
                            max={65535}
                        />
                        <SettingField
                            label="Context Size"
                            value={draft.contextSize}
                            onChange={(v) => updateDraft('contextSize', v)}
                            min={128}
                            step={256}
                        />
                        <SettingField
                            label="GPU Layers"
                            description="0 = CPU only"
                            value={draft.gpuLayers}
                            onChange={(v) => updateDraft('gpuLayers', v)}
                            min={0}
                        />
                        <SettingField
                            label="Threads"
                            value={draft.threads}
                            onChange={(v) => updateDraft('threads', v)}
                            min={1}
                        />
                        <SettingField
                            label="Batch Size"
                            value={draft.batchSize}
                            onChange={(v) => updateDraft('batchSize', v)}
                            min={1}
                            step={64}
                        />
                    </section>

                    <section className="rounded-lg border border-neutral-700 bg-neutral-800/40 px-4 py-3">
                        <h3 className="mb-2.5 text-sm font-semibold text-neutral-200">Generation</h3>
                        <SettingField
                            label="Max Tokens"
                            value={draft.maxTokens}
                            onChange={(v) => updateDraft('maxTokens', v)}
                            min={1}
                            max={8192}
                            step={64}
                        />
                        <SettingField
                            label="Temperature"
                            value={draft.temperature}
                            onChange={(v) => updateDraft('temperature', v)}
                            min={0}
                            max={2}
                            step={0.05}
                        />
                        <SettingField
                            label="Top P"
                            value={draft.topP}
                            onChange={(v) => updateDraft('topP', v)}
                            min={0.01}
                            max={1}
                            step={0.05}
                        />
                        <SettingField
                            label="Top K"
                            description="0 = disabled"
                            value={draft.topK}
                            onChange={(v) => updateDraft('topK', v)}
                            min={0}
                            max={200}
                        />
                        <SettingField
                            label="Repeat Penalty"
                            value={draft.repeatPenalty}
                            onChange={(v) => updateDraft('repeatPenalty', v)}
                            min={0.5}
                            max={2}
                            step={0.05}
                        />
                        <div className="py-2.5 border-b border-neutral-700/60">
                            <ThinkingModeSwitch
                                checked={draft.thinkingMode}
                                onCheckedChange={(v) => updateDraft('thinkingMode', v)}
                                ariaLabel="Thinking Mode"
                                label="Thinking Mode"
                                description="Show reasoning stream during response"
                                showIcon={false}
                                size="sm"
                                className="gap-4"
                                labelClassName="text-sm font-medium text-neutral-200"
                                descriptionClassName="text-[11px] text-neutral-500 mt-0.5"
                            />
                        </div>
                        <SettingField
                            label="Max Context Chars"
                            value={draft.maxContextChars}
                            onChange={(v) => updateDraft('maxContextChars', v)}
                            min={1500}
                            step={500}
                        />
                        <SettingField
                            label="Max Prompt Chars"
                            value={draft.maxPromptChars}
                            onChange={(v) => updateDraft('maxPromptChars', v)}
                            min={4000}
                            step={500}
                        />
                    </section>
                </div>

                <div className={`flex items-center justify-between gap-3 border-t border-neutral-700 ${isModal ? 'px-4 py-3 bg-neutral-900' : 'px-4 md:px-6 py-3 bg-[var(--surface-app)]'}`}>
                    <p className="text-xs text-neutral-500">
                        Server updates apply on next model load.
                    </p>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleClose}
                            className="rounded-md border border-neutral-600 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 transition-colors"
                        >
                            {onClose ? 'Cancel' : 'Discard changes'}
                        </button>
                        <button
                            onClick={handleApply}
                            disabled={!hasChanges || isSaving}
                            className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                            Apply
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
