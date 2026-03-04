import { Check, Copy, Edit2 } from 'lucide-react';
import { useState } from 'react';
import type { Message } from '../../types';

interface MessageActionsProps {
    message: Message | { id: string; role: 'assistant'; content: string };
    showCopy: boolean;
    onEdit?: () => void;
}

export function MessageActions({ message, showCopy, onEdit }: MessageActionsProps) {
    const [copied, setCopied] = useState(false);
    const isUser = message.role === 'user';

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy', err);
        }
    };

    return (
        <div className="pt-2 flex items-center gap-2 text-neutral-500 opacity-0 group-hover:opacity-100 transition-opacity">
            {showCopy && (
                <button
                    onClick={handleCopy}
                    className="p-1.5 hover:text-neutral-300 transition-colors rounded-md hover:bg-neutral-800"
                    title="Copy response"
                >
                    {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                </button>
            )}

            {isUser && onEdit && (
                <button
                    onClick={onEdit}
                    className="p-1.5 hover:text-neutral-300 transition-colors rounded-md hover:bg-neutral-800"
                    title="Edit message"
                >
                    <Edit2 size={16} />
                </button>
            )}
        </div>
    );
}
