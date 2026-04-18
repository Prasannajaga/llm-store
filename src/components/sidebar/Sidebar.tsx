import { useCallback } from 'react';
import { Plus, PanelLeftClose, Settings, MessageSquareHeart, BookOpen } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { ChatList } from './ChatList';
import { ProjectList } from './ProjectList';
import { useProjectStore } from '../../store/projectStore';
import { v4 as uuidv4 } from 'uuid';
import { IconButton } from '../ui/IconButton';
import { SidebarNavItem } from './SidebarNavItem';

export function Sidebar() {
    const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
    const toggleSidebar = useUiStore((state) => state.toggleSidebar);
    const activeView = useUiStore((state) => state.activeView);
    const setActiveView = useUiStore((state) => state.setActiveView);
    const createChat = useChatStore((state) => state.createChat);
    const setActiveProject = useProjectStore((state) => state.setActiveProject);

    const handleNewChat = useCallback(() => {
        setActiveView('chat');
        setActiveProject(null);
        void createChat({
            id: uuidv4(),
            title: 'New Conversation',
            created_at: new Date().toISOString(),
        });
    }, [createChat, setActiveProject, setActiveView]);

    if (!isSidebarOpen) {
        return null;
    }

    return (
        <>
            <div className="w-[260px] flex-shrink-0 bg-[var(--surface-sidebar)] flex flex-col h-full transition-all duration-300">
                <div className="px-2 pt-2 pb-1 flex items-center justify-between">
                    <IconButton
                        onClick={toggleSidebar}
                        icon={<PanelLeftClose size={20} />}
                        ariaLabel="Close sidebar"
                        size="md"
                        className="hover:bg-neutral-800/80"
                    />
                    <IconButton
                        onClick={handleNewChat}
                        icon={<Plus size={20} />}
                        ariaLabel="New chat"
                        size="md"
                        className="hover:bg-neutral-800/80"
                    />
                </div>

                <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 pt-1 flex flex-col gap-3">
                    <ProjectList />
                    <ChatList />
                </div>

                <div className="flex flex-col p-2 gap-0.5">
                    <SidebarNavItem
                        icon={<BookOpen size={16} />}
                        label="Knowledge"
                        isActive={activeView === 'knowledge'}
                        onClick={() => setActiveView('knowledge')}
                    />
                    <SidebarNavItem
                        icon={<MessageSquareHeart size={16} />}
                        label="Feedback"
                        isActive={activeView === 'feedback'}
                        onClick={() => setActiveView('feedback')}
                    />
                    <SidebarNavItem
                        icon={<Settings size={16} />}
                        label="Settings"
                        isActive={activeView === 'settings'}
                        onClick={() => setActiveView('settings')}
                    />
                </div>
            </div>
        </>
    );
}
