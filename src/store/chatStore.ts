import { create } from 'zustand';
import type { Chat } from '../types';
import { chatService } from '../services/chatService';

interface ChatState {
    chats: Chat[];
    activeChatId: string | null;
    isLoading: boolean;
    error: string | null;
    loadChats: () => Promise<void>;
    setActiveChat: (id: string | null) => void;
    createChat: (chat: Chat) => Promise<void>;
    deleteChat: (id: string) => Promise<void>;
    renameChat: (id: string, title: string) => Promise<void>;
    setChatProject: (id: string, project: string | null) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
    chats: [],
    activeChatId: null,
    isLoading: false,
    error: null,

    loadChats: async () => {
        set({ isLoading: true, error: null });
        try {
            const chats = await chatService.listChats();
            set({ chats, isLoading: false });
        } catch (err: any) {
            set({ error: err.toString(), isLoading: false });
        }
    },

    setActiveChat: (id) => {
        set({ activeChatId: id });
    },

    createChat: async (chat) => {
        try {
            await chatService.createChat(chat);
            const currentChats = get().chats;
            set({ chats: [chat, ...currentChats], activeChatId: chat.id });
        } catch (err: any) {
            set({ error: err.toString() });
        }
    },

    deleteChat: async (id) => {
        try {
            await chatService.deleteChat(id);
            const currentChats = get().chats.filter((c) => c.id !== id);
            const { activeChatId } = get();
            set({
                chats: currentChats,
                activeChatId: activeChatId === id ? null : activeChatId,
            });
        } catch (err: any) {
            set({ error: err.toString() });
        }
    },

    renameChat: async (id, title) => {
        try {
            await chatService.renameChat(id, title);
            const chats = get().chats.map(chat =>
                chat.id === id ? { ...chat, title } : chat
            );
            set({ chats });
        } catch (err: any) {
            set({ error: err.toString() });
        }
    },

    setChatProject: async (id, project) => {
        try {
            await chatService.setChatProject(id, project);
            const chats = get().chats.map(chat =>
                chat.id === id ? { ...chat, project: project ?? undefined } : chat
            );
            set({ chats });
        } catch (err: any) {
            set({ error: err.toString() });
        }
    },
}));
