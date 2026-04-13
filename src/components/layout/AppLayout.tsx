import { lazy, Suspense, type ReactNode } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { useUiStore } from '../../store/uiStore';
import { PanelLeftOpen } from 'lucide-react';
import { IconButton } from '../ui/IconButton';

const FeedbackView = lazy(async () => {
    const mod = await import('./FeedbackView');
    return { default: mod.FeedbackView };
});
const KnowledgeView = lazy(async () => {
    const mod = await import('./KnowledgeView');
    return { default: mod.KnowledgeView };
});
const SettingsView = lazy(async () => {
    const mod = await import('./SettingsView');
    return { default: mod.SettingsView };
});

interface AppLayoutProps {
    children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
    const { isSidebarOpen, toggleSidebar, activeView } = useUiStore();
    const viewFallback = (
        <div className="flex-1 bg-[var(--surface-app)] animate-[slide-up_0.16s_ease-out]" />
    );

    return (
        <div className="flex h-screen w-full bg-[var(--surface-app)] text-neutral-100 overflow-hidden font-sans">
            <Sidebar />

            <main className="flex-1 flex flex-col h-full relative overflow-hidden transition-all">
                {!isSidebarOpen && (
                    <IconButton
                        onClick={toggleSidebar}
                        icon={<PanelLeftOpen size={18} />}
                        ariaLabel="Open sidebar"
                        size="md"
                        className="absolute top-4 left-4 z-30 hover:bg-neutral-700"
                    />
                )}

                {activeView === 'feedback' ? (
                    <Suspense fallback={viewFallback}>
                        <div className="flex-1 min-h-0 animate-[slide-up_0.16s_ease-out]">
                            <FeedbackView />
                        </div>
                    </Suspense>
                ) : activeView === 'knowledge' ? (
                    <Suspense fallback={viewFallback}>
                        <div className="flex-1 min-h-0 animate-[slide-up_0.16s_ease-out]">
                            <KnowledgeView />
                        </div>
                    </Suspense>
                ) : activeView === 'settings' ? (
                    <Suspense fallback={viewFallback}>
                        <div className="flex-1 min-h-0 animate-[slide-up_0.16s_ease-out]">
                            <SettingsView />
                        </div>
                    </Suspense>
                ) : children}
            </main>
        </div>
    );
}
