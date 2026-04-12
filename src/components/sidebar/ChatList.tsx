import { useState, useMemo, useCallback, memo } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { Trash2, Edit2, Check, X } from 'lucide-react';
import type { Chat } from '../../types';
import { useProjectStore } from '../../store/projectStore';

export const ChatList = memo(function ChatList() {
    const { chats, activeChatId, setActiveChat, deleteChat, renameChat, isLoading } = useChatStore();
    const { setActiveView } = useUiStore();
    const { activeProjectId } = useProjectStore();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState('');

    const visibleChats = useMemo(
        () => activeProjectId
            ? chats.filter((chat) => chat.project === activeProjectId)
            : chats,
        [activeProjectId, chats],
    );
    const sortedChats = useMemo(
        () => [...visibleChats].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        [visibleChats],
    );

    const startEditing = useCallback((e: React.MouseEvent, chat: Chat) => {
        e.stopPropagation();
        setEditingId(chat.id);
        setEditTitle(chat.title || 'New Chat');
    }, []);

    const handleRename = useCallback(async (e: React.MouseEvent | React.KeyboardEvent, id: string) => {
        e.stopPropagation();
        if (editTitle.trim()) {
            await renameChat(id, editTitle.trim());
        }
        setEditingId(null);
    }, [editTitle, renameChat]);

    if (isLoading && chats.length === 0) {
        return <div className="p-4 text-sm text-neutral-500">Loading chats...</div>;
    }

    if (chats.length === 0) {
        return <div className="p-4 text-sm text-neutral-500 text-center">No previous chats</div>;
    }

    if (visibleChats.length === 0) {
        return (
            <div className="p-4 text-sm text-neutral-500 text-center">
                No chats in this project
            </div>
        );
    }

    return (
        <section className="space-y-1">
            <div className="px-2 text-[11px] uppercase tracking-wider text-neutral-500 font-semibold select-none">
                Chats
            </div>
            <div className="space-y-0.5">
                {sortedChats.map((chat) => {
                    const isActive = chat.id === activeChatId;
                    const isEditing = editingId === chat.id;

                    return (
                        <div
                            key={chat.id}
                            onClick={() => {
                                if (!isEditing) {
                                    setActiveChat(chat.id);
                                    setActiveView('chat');
                                }
                            }}
                            className={`group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                                isActive
                                    ? 'bg-neutral-800 text-white'
                                    : 'text-neutral-300 hover:bg-neutral-800/75'
                            }`}
                        >
                            {isEditing ? (
                                <div
                                    className="flex-1 flex items-center cursor-text gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <input
                                        type="text"
                                        value={editTitle}
                                        onChange={(e) => setEditTitle(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleRename(e, chat.id);
                                            if (e.key === 'Escape') setEditingId(null);
                                        }}
                                        className="flex-1 bg-[var(--surface-panel)] border border-neutral-600 text-sm text-white rounded px-2 py-0.5 outline-none focus:border-neutral-500 w-full"
                                        autoFocus
                                        onFocus={(e) => e.target.select()}
                                    />
                                    <button
                                        onClick={(e) => handleRename(e, chat.id)}
                                        className="p-1 text-green-400 hover:bg-neutral-700 rounded transition-colors"
                                    >
                                        <Check size={14} />
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setEditingId(null);
                                        }}
                                        className="p-1 text-neutral-400 hover:bg-neutral-700 rounded transition-colors"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <div className="flex-1 truncate text-sm leading-tight select-none pr-10">
                                        {chat.title || 'New Chat'}
                                    </div>

                                    <div
                                        className={`absolute right-1 flex items-center gap-0.5 transition-opacity ${
                                            isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                                        }`}
                                    >
                                        <button
                                            onClick={(e) => startEditing(e, chat)}
                                            className="p-1 text-neutral-400 hover:text-white hover:bg-neutral-700/70 rounded transition-colors"
                                            title="Rename"
                                        >
                                            <Edit2 size={13} />
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                deleteChat(chat.id);
                                            }}
                                            className="p-1 text-neutral-400 hover:text-red-400 hover:bg-neutral-700/70 rounded transition-colors"
                                            title="Delete"
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
});
