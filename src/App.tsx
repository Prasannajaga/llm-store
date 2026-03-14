import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { ChatArea } from './components/chat/ChatArea';
import { useChatStore } from './store/chatStore';
import { useSettingsStore } from './store/settingsStore';

function App() {
  const { loadChats, chats, setActiveChat } = useChatStore();
  const { loadSettings } = useSettingsStore();

  useEffect(() => {
    loadChats();
    loadSettings();
  }, [loadChats, loadSettings]);

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
