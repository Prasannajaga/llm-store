import { lazy, Suspense, useState } from 'react';
import { Plus, PanelLeftClose, Settings, MessageSquareHeart, BookOpen } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { ChatList } from './ChatList';
import { v4 as uuidv4 } from 'uuid';

const SettingsModal = lazy(async () => {
    const mod = await import('../layout/SettingsModal');
    return { default: mod.SettingsModal };
});

export function Sidebar() {
    const { isSidebarOpen, toggleSidebar, activeView, setActiveView } = useUiStore();
    const { createChat } = useChatStore();
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    const handleNewChat = () => {
        setActiveView('chat');
        createChat({
            id: uuidv4(),
            title: 'New Conversation',
            created_at: new Date().toISOString(),
        });
    };

    if (!isSidebarOpen) {
        return null;
    }

    return (
        <>
            <div className="w-[260px] flex-shrink-0 bg-[#171717] flex flex-col h-full border-r border-[#303030] transition-all duration-300">
                <div className="p-3 flex items-center justify-between">
                    <button
                        onClick={toggleSidebar}
                        className="p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
                        title="Close sidebar"
                    >
                        <PanelLeftClose size={20} />
                    </button>
                    <button
                        onClick={handleNewChat}
                        className="p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors ml-auto"
                        title="New Chat"
                    >
                        <Plus size={20} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 pt-2 flex flex-col gap-2">
                    <ChatList />
                </div>

                <div className="flex flex-col mt-auto p-3 gap-1 border-t border-neutral-800/80">
                    <button
                        onClick={() => setActiveView('knowledge')}
                        className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-colors font-medium ${
                            activeView === 'knowledge'
                                ? 'bg-neutral-700/60 text-white'
                                : 'hover:bg-neutral-800 text-neutral-200'
                        }`}
                    >
                        <BookOpen size={18} />
                        <span>Knowledge</span>
                    </button>
                    <button
                        onClick={() => setActiveView('feedback')}
                        className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-colors font-medium ${
                            activeView === 'feedback'
                                ? 'bg-neutral-700/60 text-white'
                                : 'hover:bg-neutral-800 text-neutral-200'
                        }`}
                    >
                        <MessageSquareHeart size={18} />
                        <span>Feedback History</span>
                    </button>
                    <button
                        onClick={() => setIsSettingsOpen(true)}
                        className="w-full flex items-center gap-3 px-3 py-3 hover:bg-neutral-800 rounded-lg text-sm text-neutral-200 transition-colors font-medium">
                        <Settings size={18} />
                        <span>Settings</span>
                    </button>
                </div>
            </div>

            {isSettingsOpen && (
                <Suspense fallback={null}>
                    <SettingsModal onClose={() => setIsSettingsOpen(false)} />
                </Suspense>
            )}
        </>
    );
}
