import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { ChatArea } from './components/chat/ChatArea';
import { useChatStore } from './store/chatStore';

function App() {
  const { loadChats, chats, setActiveChat } = useChatStore();

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  // Set first chat auto if no active chat
  useEffect(() => {
    if (chats.length > 0) {
      if (!useChatStore.getState().activeChatId) {
        setActiveChat(chats[0].id);
      }
    }
  }, [chats, setActiveChat]);

  return (
    <AppLayout>
      <ChatArea />
    </AppLayout>
  );
}

export default App;
