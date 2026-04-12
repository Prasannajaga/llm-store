import ReactTextareaAutosize from 'react-textarea-autosize';
import { forwardRef, type ComponentProps } from 'react';

type AutosizeVariant = 'default' | 'embedded';

export interface AutosizeTextInputProps extends Omit<ComponentProps<typeof ReactTextareaAutosize>, 'className'> {
    variant?: AutosizeVariant;
    invalid?: boolean;
    className?: string;
}

export const AutosizeTextInput = forwardRef<HTMLTextAreaElement, AutosizeTextInputProps>(function AutosizeTextInput({
    variant = 'default',
    invalid = false,
    className = '',
    ...props
}, ref) {
    const variantClass = variant === 'embedded'
        ? 'bg-transparent border-0 focus:ring-0'
        : [
            'rounded-lg border',
            'bg-[var(--control-input-bg)]',
            invalid
                ? 'border-red-500/60 focus:border-red-400'
                : 'border-[var(--control-input-border)] focus:border-[var(--control-input-border-focus)]',
            'focus:ring-1 focus:ring-[var(--control-focus-ring)]',
        ].join(' ');

    return (
        <ReactTextareaAutosize
            ref={ref}
            className={[
                'w-full',
                'text-[var(--control-input-fg)] placeholder:text-[var(--control-input-placeholder)]',
                'outline-none transition-colors',
                'disabled:opacity-60 disabled:cursor-not-allowed',
                variantClass,
                className,
            ].join(' ')}
            {...props}
        />
    );
});
