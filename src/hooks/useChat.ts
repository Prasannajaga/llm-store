import { useEffect } from 'react';
import { useChatStore } from '../store/chatStore';

export function useChat() {
    const store = useChatStore();
    const loadChats = useChatStore((state) => state.loadChats);

    useEffect(() => {
        loadChats();
    }, [loadChats]);

    return store;
}
