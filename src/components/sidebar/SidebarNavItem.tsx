import type { ReactNode } from 'react';

interface SidebarNavItemProps {
    icon: ReactNode;
    label: string;
    isActive: boolean;
    onClick: () => void;
}

export function SidebarNavItem({ icon, label, isActive, onClick }: SidebarNavItemProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50 ${
                isActive
                    ? 'bg-neutral-800 text-white'
                    : 'hover:bg-neutral-800/80 text-neutral-400'
            }`}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}
