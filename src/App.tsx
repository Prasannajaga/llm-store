import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { ChatArea } from './components/chat/ChatArea';
import { useChatStore } from './store/chatStore';
import { useProjectStore } from './store/projectStore';
import { useSettingsStore } from './store/settingsStore';

function App() {
  const loadChats = useChatStore((state) => state.loadChats);
  const chats = useChatStore((state) => state.chats);
  const setActiveChat = useChatStore((state) => state.setActiveChat);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const loadSettings = useSettingsStore((state) => state.loadSettings);

  useEffect(() => {
    loadChats();
    loadProjects();
    loadSettings();
  }, [loadChats, loadProjects, loadSettings]);

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
