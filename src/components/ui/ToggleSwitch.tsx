import type { ButtonHTMLAttributes } from 'react';

export type ToggleSwitchSize = 'sm' | 'md';

export interface ToggleSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'role' | 'aria-checked' | 'aria-label' | 'onChange'> {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    ariaLabel: string;
    size?: ToggleSwitchSize;
}

export function ToggleSwitch({
    checked,
    onCheckedChange,
    ariaLabel,
    size = 'sm',
    className = '',
    disabled = false,
    type = 'button',
    ...props
}: ToggleSwitchProps) {
    const trackSizeClass = size === 'md' ? 'h-6 w-11' : 'h-5 w-10';
    const thumbSizeClass = size === 'md' ? 'h-4 w-4' : 'h-4 w-4';
    const thumbTranslateClass = size === 'md'
        ? (checked ? 'translate-x-6' : 'translate-x-1')
        : (checked ? 'translate-x-5' : 'translate-x-1');

    return (
        <button
            type={type}
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => {
                if (disabled) return;
                onCheckedChange(!checked);
            }}
            className={[
                'relative inline-flex shrink-0 items-center rounded-full border border-transparent',
                'transition-colors cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50',
                checked
                    ? 'bg-[var(--control-switch-bg-on)]'
                    : 'bg-[var(--control-switch-bg-off)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                trackSizeClass,
                className,
            ].join(' ')}
            {...props}
        >
            <span
                className={[
                    'inline-block transform rounded-full',
                    'bg-[var(--control-switch-thumb)] transition-transform',
                    thumbSizeClass,
                    thumbTranslateClass,
                ].join(' ')}
            />
        </button>
    );
}
