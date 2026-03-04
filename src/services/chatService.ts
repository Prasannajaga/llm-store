import { invoke } from '@tauri-apps/api/core';
import type { Chat } from '../types';

export const chatService = {
    async createChat(chat: Chat): Promise<void> {
        return invoke('create_chat', { chat });
    },

    async listChats(): Promise<Chat[]> {
        return invoke('list_chats');
    },

    async deleteChat(id: string): Promise<void> {
        return invoke('delete_chat', { id });
    },

    async renameChat(id: string, title: string): Promise<void> {
        return invoke('rename_chat', { id, title });
    },

    async setChatProject(id: string, project: string | null): Promise<void> {
        return invoke('set_chat_project', { id, project });
    },
};
