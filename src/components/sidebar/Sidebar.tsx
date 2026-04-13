import { Plus, PanelLeftClose, Settings, MessageSquareHeart, BookOpen } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { ChatList } from './ChatList';
import { ProjectList } from './ProjectList';
import { useProjectStore } from '../../store/projectStore';
import { v4 as uuidv4 } from 'uuid';
import { IconButton } from '../ui/IconButton';

export function Sidebar() {
    const { isSidebarOpen, toggleSidebar, activeView, setActiveView } = useUiStore();
    const { createChat } = useChatStore();
    const activeProjectId = useProjectStore((state) => state.activeProjectId);

    const handleNewChat = () => {
        setActiveView('chat');
        createChat({
            id: uuidv4(),
            title: 'New Conversation',
            project: activeProjectId ?? undefined,
            created_at: new Date().toISOString(),
        });
    };

    if (!isSidebarOpen) {
        return null;
    }

    return (
        <>
            <div className="w-[260px] flex-shrink-0 bg-[var(--surface-sidebar)] flex flex-col h-full border-r border-[var(--surface-elevated-strong)] transition-all duration-300">
                <div className="px-2 pt-2 pb-1 flex items-center">
                    <IconButton
                        onClick={toggleSidebar}
                        icon={<PanelLeftClose size={20} />}
                        ariaLabel="Close sidebar"
                        size="md"
                        className="hover:bg-neutral-800/80"
                    />
                </div>
                <div className="px-2 pb-2">
                    <button
                        onClick={handleNewChat}
                        className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800/85 transition-colors"
                        title="New Chat"
                    >
                        <Plus size={16} className="text-neutral-300" />
                        <span>New chat</span>
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 flex flex-col gap-3">
                    <ProjectList />
                    <ChatList />
                </div>

                <div className="flex flex-col mt-auto p-2 gap-0.5 border-t border-[var(--surface-elevated-strong)]">
                    <button
                        onClick={() => setActiveView('knowledge')}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                            activeView === 'knowledge'
                                ? 'bg-neutral-800 text-white'
                                : 'hover:bg-neutral-800/80 text-neutral-300'
                        }`}
                    >
                        <BookOpen size={16} />
                        <span>Knowledge</span>
                    </button>
                    <button
                        onClick={() => setActiveView('feedback')}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                            activeView === 'feedback'
                                ? 'bg-neutral-800 text-white'
                                : 'hover:bg-neutral-800/80 text-neutral-300'
                        }`}
                    >
                        <MessageSquareHeart size={16} />
                        <span>Feedback</span>
                    </button>
                    <button
                        onClick={() => setActiveView('settings')}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                            activeView === 'settings'
                                ? 'bg-neutral-800 text-white'
                                : 'hover:bg-neutral-800/80 text-neutral-300'
                        }`}>
                        <Settings size={16} />
                        <span>Settings</span>
                    </button>
                </div>
            </div>
        </>
    );
}
