import { useEffect } from 'react';
import { useChatStore } from '../store/chatStore';

export function useChat() {
    const loadChats = useChatStore((state) => state.loadChats);
    const chats = useChatStore((state) => state.chats);
    const activeChatId = useChatStore((state) => state.activeChatId);
    const setActiveChat = useChatStore((state) => state.setActiveChat);
    const createChat = useChatStore((state) => state.createChat);
    const deleteChat = useChatStore((state) => state.deleteChat);
    const renameChat = useChatStore((state) => state.renameChat);
    const isLoading = useChatStore((state) => state.isLoading);
    const error = useChatStore((state) => state.error);

    useEffect(() => {
        loadChats();
    }, [loadChats]);

    return {
        chats,
        activeChatId,
        setActiveChat,
        createChat,
        deleteChat,
        renameChat,
        isLoading,
        error,
        loadChats,
    };
}
