import { Brain } from 'lucide-react';
import { ToggleSwitch, type ToggleSwitchSize } from './ToggleSwitch';

export interface ThinkingModeSwitchProps {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    ariaLabel?: string;
    disabled?: boolean;
    size?: ToggleSwitchSize;
    label?: string;
    description?: string;
    showIcon?: boolean;
    className?: string;
    iconClassName?: string;
    labelClassName?: string;
    descriptionClassName?: string;
}

export function ThinkingModeSwitch({
    checked,
    onCheckedChange,
    ariaLabel,
    disabled = false,
    size = 'sm',
    label = 'Thinking mode',
    description,
    showIcon = true,
    className = '',
    iconClassName = 'mt-0.5 text-neutral-300',
    labelClassName = 'text-sm font-medium text-neutral-100',
    descriptionClassName = 'text-[11px] text-neutral-400',
}: ThinkingModeSwitchProps) {
    return (
        <div className={['flex items-center justify-between gap-3', className].join(' ').trim()}>
            <div className="flex items-start gap-2 min-w-0">
                {showIcon ? (
                    <span className={iconClassName}>
                        <Brain size={14} />
                    </span>
                ) : null}
                <div className="min-w-0">
                    <div className={labelClassName}>{label}</div>
                    {description ? (
                        <div className={descriptionClassName}>{description}</div>
                    ) : null}
                </div>
            </div>
            <ToggleSwitch
                checked={checked}
                onCheckedChange={onCheckedChange}
                ariaLabel={ariaLabel ?? label}
                size={size}
                disabled={disabled}
            />
        </div>
    );
}
