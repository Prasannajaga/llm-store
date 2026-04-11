import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { ChatArea } from './components/chat/ChatArea';
import { useChatStore } from './store/chatStore';
import { useProjectStore } from './store/projectStore';
import { useSettingsStore } from './store/settingsStore';

function App() {
  const { loadChats, chats, setActiveChat } = useChatStore();
  const { loadProjects } = useProjectStore();
  const { loadSettings } = useSettingsStore();

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
