import { useState, useMemo, useCallback, memo } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { MessageSquare, Trash2, Edit2, Check, X, Folder } from 'lucide-react';
import type { Chat } from '../../types';
import { useProjectStore } from '../../store/projectStore';

export const ChatList = memo(function ChatList() {
    const { chats, activeChatId, setActiveChat, deleteChat, renameChat, isLoading } = useChatStore();
    const { setActiveView } = useUiStore();
    const { activeProjectId, projects } = useProjectStore();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editTitle, setEditTitle] = useState('');

    const projectNameById = useMemo(
        () => new Map(projects.map((project) => [project.id, project.name])),
        [projects],
    );

    const visibleChats = useMemo(
        () => activeProjectId
            ? chats.filter((chat) => chat.project === activeProjectId)
            : chats,
        [activeProjectId, chats],
    );

    const groups = useMemo(() => {
        if (activeProjectId) {
            return [{
                key: activeProjectId,
                label: projectNameById.get(activeProjectId) ?? 'Project',
                chats: visibleChats,
            }];
        }

        const grouped = new Map<string, { key: string; label: string; chats: Chat[] }>();
        for (const chat of visibleChats) {
            const key = chat.project ?? '__no_project__';
            let label: string;
            if (!chat.project) {
                label = 'No Project';
            } else {
                label = projectNameById.get(chat.project) ?? 'No Project';
            }

            const current = grouped.get(key);
            if (current) {
                current.chats.push(chat);
            } else {
                grouped.set(key, { key, label, chats: [chat] });
            }
        }

        return Array.from(grouped.values()).sort((a, b) => {
            if (a.key === '__no_project__') return 1;
            if (b.key === '__no_project__') return -1;
            return a.label.localeCompare(b.label);
        });
    }, [activeProjectId, projectNameById, visibleChats]);

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
        <div className="flex-1 overflow-y-auto overflow-x-hidden space-y-3 scrollbar-thin scrollbar-thumb-neutral-700">
            {groups.map((group) => (
                <div key={group.key} className="space-y-0.5 mt-2">
                    <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-neutral-400">
                        <Folder size={14} className="text-neutral-500" />
                        <span className="uppercase tracking-wider truncate">{group.label}</span>
                    </div>

                    <div className="pl-2 space-y-0.5 border-l border-neutral-800/50 ml-4">
                        {group.chats.map((chat) => {
                            const isActive = chat.id === activeChatId;
                            const isEditing = editingId === chat.id;

                            return (
                                <div
                                    key={chat.id}
                                    onClick={() => { if (!isEditing) { setActiveChat(chat.id); setActiveView('chat'); } }}
                                    className={`group relative flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200 ${isActive ? 'bg-neutral-800 text-white' : 'hover:bg-neutral-800/50 text-neutral-300'
                                        }`}
                                >
                                    {isEditing ? (
                                        <div className="flex-1 flex flex-row items-center cursor-text" onClick={e => e.stopPropagation()}>
                                            <input
                                                type="text"
                                                value={editTitle}
                                                onChange={(e) => setEditTitle(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleRename(e, chat.id);
                                                    if (e.key === 'Escape') setEditingId(null);
                                                }}
                                                className="flex-1 bg-neutral-900 border border-brand-500 text-sm text-white rounded px-2 py-0.5 outline-none w-full"
                                                autoFocus
                                                onFocus={e => e.target.select()}
                                            />
                                            <button onClick={(e) => handleRename(e, chat.id)} className="p-1 text-green-400 hover:bg-neutral-700 rounded ml-1 transition-colors">
                                                <Check size={14} />
                                            </button>
                                            <button onClick={(e) => { e.stopPropagation(); setEditingId(null); }} className="p-1 text-neutral-400 hover:bg-neutral-700 rounded transition-colors">
                                                <X size={14} />
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <MessageSquare size={14} className={`shrink-0 ${isActive ? 'text-neutral-200' : 'text-neutral-500'} group-hover:text-white transition-colors`} />
                                            <div className="flex-1 truncate text-sm leading-tight select-none">
                                                {chat.title || 'New Chat'}
                                            </div>

                                            <div className={`absolute right-1 flex items-center gap-1 ${isActive ? 'opacity-100' : 'opacity-0 xl:group-hover:opacity-100'} transition-opacity bg-gradient-to-l ${isActive ? 'from-neutral-800' : 'from-neutral-800'} pl-4`}>
                                                <button
                                                    onClick={(e) => startEditing(e, chat)}
                                                    className="p-1 text-neutral-400 hover:text-white transition-colors"
                                                    title="Rename"
                                                >
                                                    <Edit2 size={14} />
                                                </button>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        deleteChat(chat.id);
                                                    }}
                                                    className="p-1 text-neutral-400 hover:text-red-400 transition-colors"
                                                    title="Delete"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
});
