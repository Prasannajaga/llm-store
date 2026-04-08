import { lazy, Suspense, type ReactNode } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { useUiStore } from '../../store/uiStore';
import { PanelLeftOpen } from 'lucide-react';

const FeedbackView = lazy(async () => {
    const mod = await import('./FeedbackView');
    return { default: mod.FeedbackView };
});
const KnowledgeView = lazy(async () => {
    const mod = await import('./KnowledgeView');
    return { default: mod.KnowledgeView };
});

interface AppLayoutProps {
    children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
    const { isSidebarOpen, toggleSidebar, activeView } = useUiStore();
    const viewFallback = (
        <div className="flex-1 bg-[#212121] animate-[slide-up_0.16s_ease-out]" />
    );

    return (
        <div className="flex h-screen w-full bg-neutral-800 text-neutral-100 overflow-hidden font-sans">
            <Sidebar />

            <main className="flex-1 flex flex-col h-full relative overflow-hidden transition-all">
                {!isSidebarOpen && (
                    <button
                        onClick={toggleSidebar}
                        className="absolute top-4 left-4 z-30 p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-700 transition-colors"
                        title="Open sidebar"
                    >
                        <PanelLeftOpen size={18} />
                    </button>
                )}

                {activeView === 'feedback' ? (
                    <Suspense fallback={viewFallback}>
                        <div className="flex-1 animate-[slide-up_0.16s_ease-out]">
                            <FeedbackView />
                        </div>
                    </Suspense>
                ) : activeView === 'knowledge' ? (
                    <Suspense fallback={viewFallback}>
                        <div className="flex-1 animate-[slide-up_0.16s_ease-out]">
                            <KnowledgeView />
                        </div>
                    </Suspense>
                ) : children}
            </main>
        </div>
    );
}
