import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

type TextInputSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<TextInputSize, string> = {
    sm: 'h-9 text-sm px-3',
    md: 'h-10 text-sm px-3',
    lg: 'h-11 text-base px-3.5',
};

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
    inputSize?: TextInputSize;
    leftAdornment?: ReactNode;
    rightAdornment?: ReactNode;
    invalid?: boolean;
    containerClassName?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput({
    inputSize = 'md',
    leftAdornment,
    rightAdornment,
    invalid = false,
    containerClassName = '',
    className = '',
    ...props
}, ref) {
    const paddingClass = [
        leftAdornment ? 'pl-9' : '',
        rightAdornment ? 'pr-9' : '',
    ].join(' ');

    return (
        <div className={['relative', containerClassName].join(' ')}>
            {leftAdornment ? (
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">
                    {leftAdornment}
                </span>
            ) : null}
            <input
                ref={ref}
                className={[
                    'w-full rounded-lg border',
                    'bg-[var(--control-input-bg)] text-[var(--control-input-fg)]',
                    'placeholder:text-[var(--control-input-placeholder)]',
                    'outline-none transition-colors',
                    'focus:ring-1 focus:ring-[var(--control-focus-ring)]',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                    invalid
                        ? 'border-red-500/60 focus:border-red-400'
                        : 'border-[var(--control-input-border)] focus:border-[var(--control-input-border-focus)]',
                    SIZE_CLASS[inputSize],
                    paddingClass,
                    className,
                ].join(' ')}
                {...props}
            />
            {rightAdornment ? (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500">
                    {rightAdornment}
                </span>
            ) : null}
        </div>
    );
});
