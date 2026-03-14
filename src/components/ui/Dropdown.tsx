import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';

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
    onRemove?: (value: string) => void;
    placeholder?: string;
    className?: string;
}

export function Dropdown({
    options,
    value,
    onChange,
    onRemove,
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

    return (
        <div ref={dropdownRef} className={`relative inline-block text-left ${className}`}>
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center justify-between w-full px-4 py-2 text-sm font-medium transition-all duration-200 glass-panel hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-lg text-gray-200"
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
                <div className="absolute z-50 w-full mt-2 origin-top-right rounded-lg shadow-lg glass-panel max-h-60 overflow-y-auto overflow-x-hidden animate-slide-up scrollbar-thin scrollbar-thumb-neutral-700">
                    <div className="py-1">
                        {options.map((option) => (
                            <button
                                key={option.id}
                                onClick={() => {
                                    onChange(option.value);
                                    setIsOpen(false);
                                }}
                                className={`group/item flex items-center w-full px-4 py-2.5 text-sm text-left transition-colors hover:bg-white/10 ${
                                    value === option.value ? 'bg-white/5 font-medium text-indigo-400' : 'text-gray-300'
                                }`}
                            >
                                {option.icon && <span className="mr-2">{option.icon}</span>}
                                <span className="truncate flex-1">{option.label}</span>
                                {onRemove && (
                                    <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRemove(option.value);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.stopPropagation();
                                                onRemove(option.value);
                                            }
                                        }}
                                        className="ml-2 p-0.5 rounded hover:bg-red-500/20 text-neutral-500 hover:text-red-400 transition-colors opacity-0 group-hover/item:opacity-100"
                                        title="Remove model"
                                    >
                                        <X size={14} />
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
