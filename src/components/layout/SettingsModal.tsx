import { X } from 'lucide-react';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/60 z-[100] flex items-center justify-center p-4">
            <div className="bg-neutral-800 border border-neutral-700 rounded-xl w-full max-w-lg overflow-hidden flex flex-col shadow-2xl">
                <div className="flex items-center justify-between p-4 border-b border-neutral-700">
                    <h2 className="text-lg font-semibold text-white">Settings</h2>
                    <button
                        onClick={onClose}
                        className="text-neutral-400 hover:text-white p-1 rounded-lg hover:bg-neutral-700 transition"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="p-6 space-y-6 flex-1 overflow-y-auto">
                    <div>
                        <h3 className="text-sm font-medium text-neutral-300 mb-3 uppercase tracking-wider">General</h3>
                        {/* More settings will go here */}
                        <div className="text-sm text-neutral-400">
                            General settings coming soon.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
