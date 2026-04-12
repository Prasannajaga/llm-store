import { Checkbox } from './Checkbox';

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
        <Checkbox
            checked={checked}
            onCheckedChange={onChange}
            disabled={disabled}
            className={`w-full rounded-xl border px-3 py-2.5 transition-all ${
                disabled ? '' : containerClass
            }`}
            label={title}
            description={description}
            labelClassName="truncate text-sm text-neutral-100"
            descriptionClassName="text-[11px] text-neutral-500"
            indicatorClassName="mt-0.5 shrink-0"
            ariaLabel={title}
        />
    );
}
