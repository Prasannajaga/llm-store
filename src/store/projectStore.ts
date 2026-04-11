import { create } from 'zustand';
import type { Project } from '../types';
import { projectService } from '../services/projectService';

interface ProjectState {
    projects: Project[];
    activeProjectId: string | null;
    isLoading: boolean;
    isCreating: boolean;
    createError: string | null;
    loadProjects: () => Promise<void>;
    createProject: (name: string) => Promise<Project | null>;
    deleteProject: (id: string) => Promise<void>;
    setActiveProject: (id: string | null) => void;
    clearCreateError: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
    projects: [],
    activeProjectId: null,
    isLoading: false,
    isCreating: false,
    createError: null,

    loadProjects: async () => {
        set({ isLoading: true });
        try {
            const projects = await projectService.listProjects();
            const activeProjectId = get().activeProjectId;
            const projectStillExists = activeProjectId
                ? projects.some((project) => project.id === activeProjectId)
                : true;
            set({
                projects,
                activeProjectId: projectStillExists ? activeProjectId : null,
                isLoading: false,
            });
        } catch (err) {
            console.error('Failed to load projects:', err);
            set({ isLoading: false });
        }
    },

    createProject: async (name) => {
        const normalized = name.trim();
        if (!normalized) {
            set({ createError: 'Project name cannot be empty.' });
            return null;
        }
        set({ isCreating: true, createError: null });
        try {
            const project = await projectService.createProject(normalized);
            set((state) => ({
                projects: [...state.projects, project].sort((a, b) => a.name.localeCompare(b.name)),
                activeProjectId: project.id,
                isCreating: false,
            }));
            return project;
        } catch (err) {
            const message = String(err);
            const normalizedMessage = message.includes('UNIQUE')
                ? 'A project with that name already exists.'
                : message;
            set({ isCreating: false, createError: normalizedMessage });
            return null;
        }
    },

    deleteProject: async (id) => {
        try {
            await projectService.deleteProject(id);
            set((state) => ({
                projects: state.projects.filter((project) => project.id !== id),
                activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
            }));
        } catch (err) {
            console.error('Failed to delete project:', err);
        }
    },

    setActiveProject: (id) => {
        set({ activeProjectId: id });
    },

    clearCreateError: () => {
        set({ createError: null });
    },
}));
