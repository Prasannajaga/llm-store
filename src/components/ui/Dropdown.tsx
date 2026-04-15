import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { IconButton } from './IconButton';

export interface DropdownOption {
    id: string;
    label: string | ReactNode;
    value: string;
    icon?: ReactNode;
}

interface DropdownProps {
    options: DropdownOption[];
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    onRemove?: (value: string) => void;
    /** Values that must never show a remove button (action items, etc.). */
    nonRemovableValues?: string[];
    placeholder?: string;
    className?: string;
}

export function Dropdown({
    options,
    value,
    onChange,
    disabled = false,
    onRemove,
    nonRemovableValues = [],
    placeholder = 'Select an option',
    className = ''
}: DropdownProps) {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const selectedOption = options.find((opt) => opt.value === value);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    /** Determine whether an option is allowed to display the remove button. */
    const canRemove = (optionValue: string): boolean => {
        if (!onRemove) return false;
        // Never allow removing the currently-selected item from the dropdown
        if (optionValue === value) return false;
        // Never allow removing protected action items
        if (nonRemovableValues.includes(optionValue)) return false;
        return true;
    };

    return (
        <div ref={dropdownRef} className={`relative inline-block text-left ${className}`}>
            <button
                type="button"
                onClick={() => {
                    if (disabled) return;
                    setIsOpen(!isOpen);
                }}
                disabled={disabled}
                className={`flex items-center justify-between w-full px-4 py-2 text-sm font-medium transition-colors duration-150 rounded-lg border border-neutral-700 bg-[var(--surface-elevated)] text-neutral-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/5'
                }`}
            >
                <span className="flex items-center gap-2 truncate">
                    {selectedOption?.icon}
                    {selectedOption ? selectedOption.label : placeholder}
                </span>
                <ChevronDown
                    className={`nav-icon w-4 h-4 ml-2 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                />
            </button>

            {isOpen && (
                <div className="absolute z-50 w-full mt-2 origin-top-right rounded-lg shadow-lg border border-neutral-700 bg-[var(--surface-elevated)] max-h-60 overflow-y-auto overflow-x-hidden animate-slide-up scrollbar-thin scrollbar-thumb-neutral-700">
                    <div className="py-1">
                        {options.map((option) => (
                            <div
                                key={option.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => {
                                    onChange(option.value);
                                    setIsOpen(false);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        onChange(option.value);
                                        setIsOpen(false);
                                    }
                                }}
                                className={`group/item flex items-center w-full px-4 py-2.5 text-sm text-left transition-colors hover:bg-white/10 cursor-pointer ${
                                    value === option.value ? 'bg-white/5 font-medium text-indigo-400' : 'text-gray-300'
                                }`}
                            >
                                {option.icon && <span className="mr-2">{option.icon}</span>}
                                <span className="truncate flex-1">{option.label}</span>
                                {canRemove(option.value) && (
                                    <IconButton
                                        icon={<X size={14} />}
                                        ariaLabel="Remove model"
                                        tone="danger"
                                        size="xs"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRemove!(option.value);
                                        }}
                                        className="ml-2 opacity-0 group-hover/item:opacity-100"
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
