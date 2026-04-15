import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const SIZE_CLASS: Record<ButtonSize, string> = {
    sm: 'px-2.5 py-1 text-xs rounded-lg',
    md: 'px-3.5 py-1.5 text-sm rounded-lg',
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
    primary:
        'bg-white text-neutral-900 hover:bg-neutral-200 disabled:bg-white/10 disabled:text-white/30',
    secondary:
        'border border-neutral-700 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40',
    ghost:
        'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60 disabled:opacity-40',
    danger:
        'border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-40',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: ReactNode;
}

export function Button({
    variant = 'secondary',
    size = 'md',
    icon,
    className = '',
    children,
    type = 'button',
    ...props
}: ButtonProps) {
    return (
        <button
            type={type}
            className={[
                'inline-flex items-center justify-center gap-1.5 font-medium',
                'transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50',
                'disabled:cursor-not-allowed',
                SIZE_CLASS[size],
                VARIANT_CLASS[variant],
                className,
            ].join(' ')}
            {...props}
        >
            {icon}
            {children}
        </button>
    );
}
