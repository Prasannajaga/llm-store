import { create } from 'zustand';

type ActiveView = 'chat' | 'feedback' | 'knowledge' | 'settings';

interface UiState {
    isSidebarOpen: boolean;
    theme: 'light' | 'dark';
    activeView: ActiveView;
    toggleSidebar: () => void;
    setSidebarOpen: (isOpen: boolean) => void;
    setTheme: (theme: 'light' | 'dark') => void;
    setActiveView: (view: ActiveView) => void;
}

export const useUiStore = create<UiState>((set) => ({
    isSidebarOpen: true,
    theme: 'dark',
    activeView: 'chat',
    toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
    setSidebarOpen: (isOpen) => set({ isSidebarOpen: isOpen }),
    setTheme: (theme) => set({ theme }),
    setActiveView: (view) => set({ activeView: view }),
}));
