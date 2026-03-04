import { create } from 'zustand';

interface UiState {
    isSidebarOpen: boolean;
    theme: 'light' | 'dark';
    toggleSidebar: () => void;
    setTheme: (theme: 'light' | 'dark') => void;
}

export const useUiStore = create<UiState>((set) => ({
    isSidebarOpen: true,
    theme: 'dark',
    toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
    setTheme: (theme) => set({ theme }),
}));
