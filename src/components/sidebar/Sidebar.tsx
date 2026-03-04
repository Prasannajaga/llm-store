import { useState } from 'react';
import { Plus, PanelLeftClose, Settings } from 'lucide-react';
import { useUiStore } from '../../store/uiStore';
import { useChatStore } from '../../store/chatStore';
import { ChatList } from './ChatList';
import { SettingsModal } from '../layout/SettingsModal';
import { v4 as uuidv4 } from 'uuid';

export function Sidebar() {
    const { isSidebarOpen, toggleSidebar } = useUiStore();
    const { createChat } = useChatStore();
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    const handleNewChat = () => {
        createChat({
            id: uuidv4(),
            title: 'New Conversation',
            created_at: new Date().toISOString(),
        });
    };

    if (!isSidebarOpen) {
        return null;
    }

    return (
        <>
            <div className="w-[260px] flex-shrink-0 bg-[#171717] flex flex-col h-full border-r border-[#303030] transition-all duration-300">
                <div className="p-3 flex items-center justify-between">
                    <button
                        onClick={toggleSidebar}
                        className="p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors"
                        title="Close sidebar"
                    >
                        <PanelLeftClose size={20} />
                    </button>
                    <button
                        onClick={handleNewChat}
                        className="p-2 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-colors ml-auto"
                        title="New Chat"
                    >
                        <Plus size={20} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 flex flex-col gap-2">
                    <ChatList />
                </div>

                <div className="flex flex-col mt-auto p-3">
                    <button
                        onClick={() => setIsSettingsOpen(true)}
                        className="w-full flex items-center gap-3 px-3 py-3 hover:bg-neutral-800 rounded-lg text-sm text-neutral-200 transition-colors font-medium">
                        <Settings size={18} />
                        <span>Settings</span>
                    </button>
                </div>
            </div>

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
            />
        </>
    );
}
