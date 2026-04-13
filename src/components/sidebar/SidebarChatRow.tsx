import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
} from 'react';
import { Trash2, Edit2, Check, X, FolderOpen } from 'lucide-react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useProjectStore } from '../../store/projectStore';
import { IconButton } from '../ui/IconButton';
import { TextInput } from '../ui/TextInput';

interface SidebarChatRowProps {
    chat: Chat;
    isActive: boolean;
    onSelect: () => void;
}

export function SidebarChatRow({ chat, isActive, onSelect }: SidebarChatRowProps) {
    const { renameChat, deleteChat, setChatProject } = useChatStore();
    const { projects, setActiveProject } = useProjectStore();
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState('');
    const [isMoveOpen, setIsMoveOpen] = useState(false);
    const rowRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isMoveOpen) {
            return;
        }
        const handleClickOutside = (event: globalThis.MouseEvent) => {
            if (rowRef.current && !rowRef.current.contains(event.target as Node)) {
                setIsMoveOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isMoveOpen]);

    const handleRename = useCallback(async (event: ReactMouseEvent | ReactKeyboardEvent) => {
        event.stopPropagation();
        const trimmedTitle = editTitle.trim();
        if (trimmedTitle) {
            await renameChat(chat.id, trimmedTitle);
        }
        setIsEditing(false);
    }, [chat.id, editTitle, renameChat]);

    const handleMoveChat = useCallback(async (targetProjectId: string | null) => {
        if ((chat.project ?? null) === targetProjectId) {
            setIsMoveOpen(false);
            return;
        }
        await setChatProject(chat.id, targetProjectId);
        setActiveProject(targetProjectId);
        setIsMoveOpen(false);
    }, [chat.id, chat.project, setActiveProject, setChatProject]);

    return (
        <div
            ref={rowRef}
            onClick={() => {
                if (!isEditing) {
                    onSelect();
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
                    onClick={(event) => event.stopPropagation()}
                >
                    <TextInput
                        type="text"
                        value={editTitle}
                        onChange={(event) => setEditTitle(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                void handleRename(event);
                            }
                            if (event.key === 'Escape') {
                                setIsEditing(false);
                            }
                        }}
                        inputSize="sm"
                        className="flex-1 w-full rounded bg-[var(--surface-panel)] py-0.5"
                        autoFocus
                        onFocus={(event) => event.target.select()}
                        aria-label="Rename chat"
                    />
                    <IconButton
                        onClick={(event) => void handleRename(event)}
                        icon={<Check size={14} />}
                        ariaLabel="Confirm chat rename"
                        tone="success"
                        size="xs"
                        className="hover:bg-neutral-700"
                    />
                    <IconButton
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsEditing(false);
                        }}
                        icon={<X size={14} />}
                        ariaLabel="Cancel chat rename"
                        size="xs"
                        className="hover:bg-neutral-700"
                    />
                </div>
            ) : (
                <>
                    <div className="flex-1 truncate text-sm leading-tight select-none pr-14">
                        {chat.title || 'New Chat'}
                    </div>

                    <div
                        className={`absolute right-1 flex items-center gap-0.5 transition-opacity ${
                            isActive || isMoveOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        }`}
                    >
                        <IconButton
                            onClick={(event) => {
                                event.stopPropagation();
                                setIsMoveOpen((previous) => !previous);
                            }}
                            icon={<FolderOpen size={13} />}
                            ariaLabel="Move chat"
                            size="xs"
                            active={isMoveOpen}
                            className="hover:bg-neutral-700/70"
                        />
                        <IconButton
                            onClick={(event) => {
                                event.stopPropagation();
                                setIsMoveOpen(false);
                                setEditTitle(chat.title || 'New Chat');
                                setIsEditing(true);
                            }}
                            icon={<Edit2 size={13} />}
                            ariaLabel="Rename chat"
                            size="xs"
                            className="hover:bg-neutral-700/70"
                        />
                        <IconButton
                            onClick={(event) => {
                                event.stopPropagation();
                                void deleteChat(chat.id);
                            }}
                            icon={<Trash2 size={13} />}
                            ariaLabel="Delete chat"
                            tone="danger"
                            size="xs"
                            className="hover:bg-neutral-700/70"
                        />
                    </div>

                    {isMoveOpen ? (
                        <div
                            className="absolute right-1 top-8 z-40 w-44 rounded-md border border-[var(--surface-elevated-strong)] bg-[var(--surface-sidebar)] p-1 shadow-lg"
                            onClick={(event) => event.stopPropagation()}
                        >
                            <button
                                onClick={() => void handleMoveChat(null)}
                                className={`w-full flex items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors ${
                                    !chat.project
                                        ? 'bg-neutral-800 text-neutral-100'
                                        : 'text-neutral-300 hover:bg-neutral-800/75'
                                }`}
                            >
                                <span>Recent</span>
                                {!chat.project ? <Check size={12} /> : null}
                            </button>
                            {projects.length > 0 ? (
                                <div className="mt-1 border-t border-[var(--surface-elevated-strong)] pt-1">
                                    {projects.map((project) => {
                                        const isAssigned = chat.project === project.id;
                                        return (
                                            <button
                                                key={project.id}
                                                onClick={() => void handleMoveChat(project.id)}
                                                className={`w-full flex items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors ${
                                                    isAssigned
                                                        ? 'bg-neutral-800 text-neutral-100'
                                                        : 'text-neutral-300 hover:bg-neutral-800/75'
                                                }`}
                                            >
                                                <span className="truncate">{project.name}</span>
                                                {isAssigned ? <Check size={12} /> : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}
