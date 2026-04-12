import { Check } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';

type CheckboxSize = 'sm' | 'md';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange' | 'size'> {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    label?: ReactNode;
    description?: ReactNode;
    ariaLabel?: string;
    size?: CheckboxSize;
    className?: string;
    labelClassName?: string;
    descriptionClassName?: string;
    indicatorClassName?: string;
}

export function Checkbox({
    checked,
    onCheckedChange,
    label,
    description,
    ariaLabel,
    size = 'md',
    disabled = false,
    className = '',
    labelClassName = '',
    descriptionClassName = '',
    indicatorClassName = '',
    ...props
}: CheckboxProps) {
    const containerClass = disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer';
    const indicatorSizeClass = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
    const iconSize = size === 'sm' ? 10 : 12;

    return (
        <label className={[
            'group inline-flex items-start gap-2 select-none',
            containerClass,
            className,
        ].join(' ')}>
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => {
                    if (disabled) {
                        return;
                    }
                    onCheckedChange(event.target.checked);
                }}
                aria-label={ariaLabel}
                className="sr-only"
                {...props}
            />

            <span
                aria-hidden
                className={[
                    'inline-flex items-center justify-center rounded-md border transition-colors',
                    indicatorSizeClass,
                    checked
                        ? 'border-[var(--control-checkbox-border-checked)] bg-[var(--control-checkbox-bg-checked)] text-[var(--control-checkbox-icon)]'
                        : 'border-[var(--control-checkbox-border)] bg-[var(--control-checkbox-bg)] text-transparent group-hover:border-[var(--control-checkbox-border-hover)]',
                    indicatorClassName,
                ].join(' ')}
            >
                <Check size={iconSize} strokeWidth={2.6} />
            </span>

            {(label || description) ? (
                <span className="min-w-0 flex-1">
                    {label ? (
                        <span className={['block', labelClassName].join(' ')}>
                            {label}
                        </span>
                    ) : null}
                    {description ? (
                        <span className={['mt-0.5 block', descriptionClassName].join(' ')}>
                            {description}
                        </span>
                    ) : null}
                </span>
            ) : null}
        </label>
    );
}
