import { useCallback, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';
import { useChatStore } from '../../store/chatStore';
import { useUiStore } from '../../store/uiStore';
import { IconButton } from '../ui/IconButton';
import { TextInput } from '../ui/TextInput';

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
    const rowClass = (isActive: boolean) => `w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
        isActive
            ? 'bg-neutral-800 text-neutral-100'
            : 'text-neutral-300 hover:bg-neutral-800/75'
    }`;

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

            <div className="space-y-0.5">
                <button
                    onClick={() => pickProject(null)}
                    className={rowClass(activeProjectId === null)}
                >
                    <span className={`h-1.5 w-1.5 rounded-full ${activeProjectId === null ? 'bg-neutral-200' : 'bg-neutral-600'}`} />
                    <span className="truncate">All chats</span>
                </button>

                {projects.map((project) => (
                    <button
                        key={project.id}
                        onClick={() => pickProject(project.id)}
                        className={rowClass(activeProjectId === project.id)}
                    >
                        <span className={`h-1.5 w-1.5 rounded-full ${activeProjectId === project.id ? 'bg-neutral-200' : 'bg-neutral-600'}`} />
                        <span className="truncate">{project.name}</span>
                    </button>
                ))}
            </div>
        </section>
    );
}
