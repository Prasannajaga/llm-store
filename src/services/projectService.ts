import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../types';

export const projectService = {
    async createProject(name: string): Promise<Project> {
        return invoke('create_project', { name });
    },

    async listProjects(): Promise<Project[]> {
        return invoke('list_projects');
    },

    async deleteProject(id: string): Promise<void> {
        return invoke('delete_project', { id });
    },
};
