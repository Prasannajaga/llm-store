import { useCallback, useState } from 'react';
import { Folder, FolderOpen, Plus, X } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';

export function ProjectList() {
    const {
        projects,
        activeProjectId,
        isCreating,
        createError,
        createProject,
        setActiveProject,
        clearCreateError,
    } = useProjectStore();
    const { chats, setActiveChat } = useChatStore();
    const { setActiveView } = useUiStore();
    const [isAddOpen, setIsAddOpen] = useState(false);
    const [projectName, setProjectName] = useState('');

    const pickProject = useCallback((projectId: string | null) => {
        setActiveProject(projectId);
        const nextChat = projectId
            ? chats.find((chat) => chat.project === projectId)
            : chats[0];
        setActiveChat(nextChat?.id ?? null);
        setActiveView('chat');
    }, [chats, setActiveChat, setActiveProject, setActiveView]);

    const handleCreate = useCallback(async () => {
        const created = await createProject(projectName);
        if (!created) {
            return;
        }
        setProjectName('');
        setIsAddOpen(false);
        pickProject(created.id);
    }, [createProject, pickProject, projectName]);

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between px-2 py-1">
                <div className="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold">
                    Projects
                </div>
                <button
                    onClick={() => {
                        setIsAddOpen((prev) => !prev);
                        clearCreateError();
                    }}
                    className="rounded-md p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 transition-colors"
                    title="Create project"
                >
                    {isAddOpen ? <X size={14} /> : <Plus size={14} />}
                </button>
            </div>

            {isAddOpen && (
                <div className="space-y-1.5 px-2">
                    <input
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
                        className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-indigo-500"
                        autoFocus
                    />
                    {createError ? (
                        <p className="text-[11px] text-red-300">{createError}</p>
                    ) : null}
                    <button
                        onClick={() => void handleCreate()}
                        disabled={isCreating || !projectName.trim()}
                        className="w-full rounded-md bg-neutral-700 px-2.5 py-1.5 text-xs text-neutral-100 hover:bg-neutral-600 disabled:opacity-50 transition-colors"
                    >
                        {isCreating ? 'Creating...' : 'Create'}
                    </button>
                </div>
            )}

            <div className="space-y-0.5 px-1">
                <button
                    onClick={() => pickProject(null)}
                    className={`w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                        activeProjectId === null
                            ? 'bg-neutral-800 text-white'
                            : 'text-neutral-300 hover:bg-neutral-800/60'
                    }`}
                >
                    <FolderOpen size={14} className="text-neutral-400" />
                    <span className="truncate">All Chats</span>
                </button>

                {projects.map((project) => (
                    <button
                        key={project.id}
                        onClick={() => pickProject(project.id)}
                        className={`w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                            activeProjectId === project.id
                                ? 'bg-neutral-800 text-white'
                                : 'text-neutral-300 hover:bg-neutral-800/60'
                        }`}
                    >
                        <Folder size={14} className="text-neutral-500" />
                        <span className="truncate">{project.name}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
