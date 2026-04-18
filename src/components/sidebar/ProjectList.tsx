import { memo, useCallback, useMemo, useState } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import type { Chat } from '../../types';
import { IconButton } from '../ui/IconButton';
import { TextInput } from '../ui/TextInput';
import { SidebarChatRow } from './SidebarChatRow';

export const ProjectList = memo(function ProjectList() {
    const projects = useProjectStore((state) => state.projects);
    const isCreating = useProjectStore((state) => state.isCreating);
    const createError = useProjectStore((state) => state.createError);
    const createProject = useProjectStore((state) => state.createProject);
    const setActiveProject = useProjectStore((state) => state.setActiveProject);
    const clearCreateError = useProjectStore((state) => state.clearCreateError);
    const chats = useChatStore((state) => state.chats);
    const activeChatId = useChatStore((state) => state.activeChatId);
    const setActiveChat = useChatStore((state) => state.setActiveChat);
    const setActiveView = useUiStore((state) => state.setActiveView);
    const [isAddOpen, setIsAddOpen] = useState(false);
    const [projectName, setProjectName] = useState('');
    const activeChatProjectId = chats.find((chat) => chat.id === activeChatId)?.project ?? null;
    const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>(
        () => (activeChatProjectId ? { [activeChatProjectId]: true } : {}),
    );

    const chatsByProject = useMemo(() => {
        const grouped: Record<string, typeof chats> = {};
        for (const project of projects) {
            grouped[project.id] = [];
        }
        for (const chat of chats) {
            if (!chat.project) {
                continue;
            }
            if (grouped[chat.project]) {
                grouped[chat.project].push(chat);
            }
        }
        for (const projectId of Object.keys(grouped)) {
            grouped[projectId].sort((a, b) => b.created_at.localeCompare(a.created_at));
        }
        return grouped;
    }, [chats, projects]);

    const handleCreate = useCallback(async () => {
        const created = await createProject(projectName);
        if (!created) {
            return;
        }
        setProjectName('');
        setIsAddOpen(false);
        setExpandedProjectIds((previous) => ({ ...previous, [created.id]: true }));
        setActiveProject(created.id);
    }, [createProject, projectName, setActiveProject]);
    const handleSelectChat = useCallback((chat: Chat) => {
        const projectId = chat.project ?? null;
        if (projectId) {
            setExpandedProjectIds((previous) => ({
                ...previous,
                [projectId]: true,
            }));
        }
        setActiveProject(projectId);
        setActiveChat(chat.id);
        setActiveView('chat');
    }, [setActiveChat, setActiveProject, setActiveView]);

    return (
        <section className="space-y-1.5">
            <div className="flex items-center justify-between px-2">
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold select-none">
                    Projects
                </div>
                <IconButton
                    onClick={() => {
                        setIsAddOpen((prev) => !prev);
                        clearCreateError();
                    }}
                    icon={isAddOpen ? <X size={14} /> : <Plus size={14} />}
                    ariaLabel="Create project"
                    size="xs"
                    className="hover:bg-neutral-800/80"
                />
            </div>

            {isAddOpen && (
                <div className="space-y-1.5 px-2 pt-0.5 pb-1.5">
                    <TextInput
                        type="text"
                        value={projectName}
                        onChange={(event) => setProjectName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                void handleCreate();
                            }
                            if (event.key === 'Escape') {
                                setIsAddOpen(false);
                                setProjectName('');
                            }
                        }}
                        placeholder="New project"
                        inputSize="sm"
                        className="w-full rounded-md bg-[var(--surface-panel)]"
                        autoFocus
                        aria-label="New project"
                    />
                    {createError ? (
                        <p className="text-[11px] text-red-300">{createError}</p>
                    ) : null}
                    <div className="flex items-center justify-end gap-2">
                        <button
                            onClick={() => {
                                setIsAddOpen(false);
                                setProjectName('');
                                clearCreateError();
                            }}
                            className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/80 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => void handleCreate()}
                            disabled={isCreating || !projectName.trim()}
                            className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-100 hover:bg-neutral-700 disabled:opacity-50 transition-colors"
                        >
                            {isCreating ? 'Creating...' : 'Create'}
                        </button>
                    </div>
                </div>
            )}

            {projects.length === 0 ? (
                <div className="px-2 py-2 text-xs text-neutral-500">No projects yet</div>
            ) : (
                <div className="space-y-0.5">
                    {projects.map((project) => {
                        const projectChats = chatsByProject[project.id] ?? [];
                        const isExpanded = expandedProjectIds[project.id] ?? false;
                        const isActiveProject = activeChatProjectId === project.id;

                        return (
                            <div key={project.id} className="rounded-lg">
                                <button
                                    onClick={() => {
                                        setExpandedProjectIds((previous) => ({
                                            ...previous,
                                            [project.id]: !isExpanded,
                                        }));
                                        setActiveProject(project.id);
                                    }}
                                    className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                                        isActiveProject
                                            ? 'bg-neutral-800 text-neutral-100'
                                            : 'text-neutral-300 hover:bg-neutral-800/75'
                                    }`}
                                >
                                    <ChevronRight
                                        size={14}
                                        className={`shrink-0 transition-transform duration-200 ${
                                            isExpanded ? 'rotate-90' : ''
                                        }`}
                                    />
                                    <span className="truncate">{project.name}</span>
                                    <span className="ml-auto rounded-full bg-neutral-800/85 px-1.5 py-0.5 text-[10px] leading-none text-neutral-400">
                                        {projectChats.length}
                                    </span>
                                </button>

                                <div
                                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                                        isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                                    }`}
                                >
                                    <div className="overflow-hidden pl-4 pr-1 pt-1 space-y-0.5">
                                        {projectChats.length === 0 ? (
                                            <div className="px-2 py-1.5 text-xs text-neutral-500">No chats yet</div>
                                        ) : (
                                            projectChats.map((chat) => (
                                                <SidebarChatRow
                                                    key={chat.id}
                                                    chat={chat}
                                                    isActive={chat.id === activeChatId}
                                                    onSelect={handleSelectChat}
                                                />
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
});
