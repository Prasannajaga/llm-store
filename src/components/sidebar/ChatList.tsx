import { useMemo, memo } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { SidebarChatRow } from './SidebarChatRow';

export const ChatList = memo(function ChatList() {
    const { chats, activeChatId, setActiveChat, isLoading } = useChatStore();
    const { setActiveView } = useUiStore();
    const setActiveProject = useProjectStore((state) => state.setActiveProject);

    const visibleChats = useMemo(
        () => chats.filter((chat) => !chat.project),
        [chats],
    );
    const sortedChats = useMemo(
        () => [...visibleChats].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        [visibleChats],
    );

    if (isLoading && chats.length === 0) {
        return <div className="p-4 text-sm text-neutral-500">Loading chats...</div>;
    }

    if (chats.length === 0) {
        return <div className="p-4 text-sm text-neutral-500 text-center">No previous chats</div>;
    }

    if (visibleChats.length === 0) {
        return (
            <div className="p-4 text-sm text-neutral-500 text-center">
                No recent chats
            </div>
        );
    }

    return (
        <section className="space-y-1">
            <div className="px-2 text-[11px] uppercase tracking-wider text-neutral-500 font-semibold select-none">
                Recent
            </div>
            <div className="space-y-0.5">
                {sortedChats.map((chat) => {
                    const isActive = chat.id === activeChatId;

                    return (
                        <SidebarChatRow
                            key={chat.id}
                            chat={chat}
                            isActive={isActive}
                            onSelect={() => {
                                setActiveProject(null);
                                setActiveChat(chat.id);
                                setActiveView('chat');
                            }}
                        />
                    );
                })}
            </div>
        </section>
    );
});
