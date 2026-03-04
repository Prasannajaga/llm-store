import { useEffect } from 'react';
import { useChatStore } from '../store/chatStore';

export function useChat() {
    const store = useChatStore();

    useEffect(() => {
        store.loadChats();
    }, [store.loadChats]);

    return store;
}
