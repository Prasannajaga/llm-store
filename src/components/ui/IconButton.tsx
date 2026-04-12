import type { ButtonHTMLAttributes, ReactNode } from 'react';

type IconButtonTone = 'neutral' | 'brand' | 'danger' | 'success' | 'warning';
type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg';
type IconButtonShape = 'rounded' | 'circle';

const SIZE_CLASS: Record<IconButtonSize, string> = {
    xs: 'h-6 w-6',
    sm: 'h-7 w-7',
    md: 'h-8 w-8',
    lg: 'h-10 w-10',
};

const SHAPE_CLASS: Record<IconButtonShape, string> = {
    rounded: 'rounded-md',
    circle: 'rounded-full',
};

const TONE_CLASS: Record<IconButtonTone, { idle: string; active: string }> = {
    neutral: {
        idle: 'text-[var(--control-icon-fg)] hover:text-[var(--control-icon-fg-hover)] hover:bg-[var(--control-icon-bg-hover)]',
        active: 'text-[var(--control-icon-fg-active)] bg-[var(--control-icon-bg-active)]',
    },
    brand: {
        idle: 'text-indigo-300 hover:text-indigo-200 hover:bg-indigo-500/20',
        active: 'text-indigo-100 bg-indigo-500/30',
    },
    danger: {
        idle: 'text-red-300 hover:text-red-200 hover:bg-red-500/18',
        active: 'text-red-200 bg-red-500/22',
    },
    success: {
        idle: 'text-emerald-300 hover:text-emerald-200 hover:bg-emerald-500/18',
        active: 'text-emerald-200 bg-emerald-500/22',
    },
    warning: {
        idle: 'text-amber-300 hover:text-amber-200 hover:bg-amber-500/18',
        active: 'text-amber-200 bg-amber-500/22',
    },
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
    ariaLabel: string;
    icon: ReactNode;
    tone?: IconButtonTone;
    size?: IconButtonSize;
    shape?: IconButtonShape;
    active?: boolean;
}

export function IconButton({
    ariaLabel,
    icon,
    tone = 'neutral',
    size = 'md',
    shape = 'rounded',
    active = false,
    className = '',
    type = 'button',
    title,
    ...props
}: IconButtonProps) {
    const toneClass = active ? TONE_CLASS[tone].active : TONE_CLASS[tone].idle;

    return (
        <button
            type={type}
            aria-label={ariaLabel}
            title={title ?? ariaLabel}
            className={[
                'inline-flex items-center justify-center border border-transparent',
                'transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                SIZE_CLASS[size],
                SHAPE_CLASS[shape],
                toneClass,
                className,
            ].join(' ')}
            {...props}
        >
            {icon}
        </button>
    );
}
