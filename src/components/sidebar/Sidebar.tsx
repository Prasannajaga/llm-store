import { useCallback, useEffect, useState } from 'react';
import { Plus, PanelLeftClose, Settings, MessageSquareHeart, BookOpen } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { ChatList } from './ChatList';
import { ProjectList } from './ProjectList';
import { useProjectStore } from '../../store/projectStore';
import { v4 as uuidv4 } from 'uuid';
import { IconButton } from '../ui/IconButton';
import { SidebarNavItem } from './SidebarNavItem';

const MOBILE_SIDEBAR_QUERY = '(max-width: 767px)';

function getIsMobileViewport(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia(MOBILE_SIDEBAR_QUERY).matches;
}

export function Sidebar() {
    const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
    const toggleSidebar = useUiStore((state) => state.toggleSidebar);
    const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
    const activeView = useUiStore((state) => state.activeView);
    const setActiveView = useUiStore((state) => state.setActiveView);
    const createChat = useChatStore((state) => state.createChat);
    const setActiveProject = useProjectStore((state) => state.setActiveProject);
    const [isMobileViewport, setIsMobileViewport] = useState(getIsMobileViewport);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }
        const mediaQuery = window.matchMedia(MOBILE_SIDEBAR_QUERY);
        const handleChange = (event: MediaQueryListEvent) => {
            setIsMobileViewport(event.matches);
        };

        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', handleChange);
            return () => mediaQuery.removeEventListener('change', handleChange);
        }

        mediaQuery.addListener(handleChange);
        return () => mediaQuery.removeListener(handleChange);
    }, []);

    const closeSidebarOnMobile = useCallback(() => {
        if (isMobileViewport) {
            setSidebarOpen(false);
        }
    }, [isMobileViewport, setSidebarOpen]);

    useEffect(() => {
        if (!isSidebarOpen || !isMobileViewport) {
            return;
        }
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setSidebarOpen(false);
            }
        };
        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('keydown', handleEscape);
        };
    }, [isMobileViewport, isSidebarOpen, setSidebarOpen]);

    const handleNewChat = useCallback(() => {
        setActiveView('chat');
        setActiveProject(null);
        void createChat({
            id: uuidv4(),
            title: 'New Conversation',
            created_at: new Date().toISOString(),
        });
        closeSidebarOnMobile();
    }, [closeSidebarOnMobile, createChat, setActiveProject, setActiveView]);

    const handleViewChange = useCallback((view: 'knowledge' | 'feedback' | 'settings') => {
        setActiveView(view);
        closeSidebarOnMobile();
    }, [closeSidebarOnMobile, setActiveView]);

    if (!isSidebarOpen) {
        return null;
    }

    const containerClassName = [
        'w-[260px] flex-shrink-0 bg-[var(--surface-sidebar)] flex flex-col h-full transition-all duration-300 border-r border-neutral-800/80',
        isMobileViewport ? 'fixed inset-y-0 left-0 z-40 shadow-2xl' : '',
    ].join(' ');

    return (
        <>
            {isMobileViewport && (
                <button
                    type="button"
                    onClick={() => setSidebarOpen(false)}
                    aria-label="Close sidebar backdrop"
                    className="fixed inset-0 z-30 bg-black/55 backdrop-blur-[1px]"
                />
            )}

            <aside className={containerClassName}>
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
                    <ProjectList onChatSelected={closeSidebarOnMobile} />
                    <ChatList onChatSelected={closeSidebarOnMobile} />
                </div>

                <div className="flex flex-col p-2 gap-0.5">
                    <SidebarNavItem
                        icon={<BookOpen size={16} />}
                        label="Knowledge"
                        isActive={activeView === 'knowledge'}
                        onClick={() => handleViewChange('knowledge')}
                    />
                    <SidebarNavItem
                        icon={<MessageSquareHeart size={16} />}
                        label="Feedback"
                        isActive={activeView === 'feedback'}
                        onClick={() => handleViewChange('feedback')}
                    />
                    <SidebarNavItem
                        icon={<Settings size={16} />}
                        label="Settings"
                        isActive={activeView === 'settings'}
                        onClick={() => handleViewChange('settings')}
                    />
                </div>
            </aside>
        </>
    );
}
