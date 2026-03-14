import type { ReactNode } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { useUiStore } from '../../store/uiStore';
import { PanelLeftOpen } from 'lucide-react';
import { FeedbackView } from './FeedbackView';

interface AppLayoutProps {
    children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
    const { isSidebarOpen, toggleSidebar, activeView } = useUiStore();

    return (
        <div className="flex h-screen w-full bg-neutral-800 text-neutral-100 overflow-hidden font-sans">
            <Sidebar />

            <main className="flex-1 flex flex-col h-full relative overflow-hidden transition-all">
                {!isSidebarOpen && (
                    <button
                        onClick={toggleSidebar}
                        className="absolute top-4 left-4 z-50 p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-700 transition-colors"
                        title="Open sidebar"
                    >
                        <PanelLeftOpen size={18} />
                    </button>
                )}

                {activeView === 'feedback' ? <FeedbackView /> : children}
            </main>
        </div>
    );
}
