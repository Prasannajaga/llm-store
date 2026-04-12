import { Check } from 'lucide-react';

interface CheckboxOptionRowProps {
    checked: boolean;
    title: string;
    description?: string;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
}

export function CheckboxOptionRow({
    checked,
    title,
    description,
    onChange,
    disabled = false,
}: CheckboxOptionRowProps) {
    const containerClass = checked
        ? 'border-indigo-400/60 bg-indigo-500/12'
        : 'border-neutral-700/70 bg-neutral-800/70 hover:border-neutral-500/70 hover:bg-neutral-700/25';

    return (
        <label
            className={`group flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-all ${
                disabled ? 'opacity-50 cursor-not-allowed' : `cursor-pointer ${containerClass}`
            }`}
        >
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="sr-only"
            />

            <span
                className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all ${
                    checked
                        ? 'border-indigo-300/90 bg-indigo-400/20 text-indigo-100'
                        : 'border-neutral-500/80 bg-neutral-800 text-transparent group-hover:border-neutral-300/70'
                }`}
                aria-hidden
            >
                <Check size={12} strokeWidth={2.5} />
            </span>

            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-neutral-100">{title}</span>
                {description ? (
                    <span className="mt-0.5 block text-[11px] text-neutral-500">{description}</span>
                ) : null}
            </span>
        </label>
    );
}
