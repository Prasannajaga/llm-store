import { invoke } from '@tauri-apps/api/core';
import type { Message } from '../types';

export const messageService = {
    async getMessages(chatId: string): Promise<Message[]> {
        return invoke('get_messages', { chatId });
    },

    async saveMessage(message: Message): Promise<void> {
        return invoke('save_message', { message });
    },

    async deleteMessage(id: string): Promise<void> {
        return invoke('delete_message', { id });
    },

    async editMessage(id: string, content: string): Promise<void> {
        return invoke('edit_message', { id, content });
    },
};
