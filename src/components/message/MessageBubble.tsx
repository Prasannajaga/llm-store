import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TextareaAutosize from 'react-textarea-autosize';
import { Bot, User } from 'lucide-react';
import { MessageActions } from './MessageActions';
import { CodeBlock } from './CodeBlock';
import type { Message } from '../../types';

interface MessageBubbleProps {
    message: Message | { id: string; role: 'assistant'; content: string };
    isStreaming?: boolean;
    onSaveEdit?: (id: string, newContent: string) => void;
}

export function MessageBubble({ message, isStreaming = false, onSaveEdit }: MessageBubbleProps) {
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system';

    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(message.content);

    if (isSystem) return null;

    const handleSave = () => {
        if (editContent.trim() && editContent !== message.content && onSaveEdit) {
            onSaveEdit(message.id, editContent);
        }
        setIsEditing(false);
    };

    const handleCancel = () => {
        setEditContent(message.content);
        setIsEditing(false);
    };

    return (
        <div className={`py-6 w-full ${isUser ? 'bg-transparent' : 'bg-transparent'} group`}>
            <div className={`max-w-3xl mx-auto flex gap-4 md:gap-6 px-4 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-full ${isUser ? 'bg-neutral-600 outline outline-1 outline-neutral-500' : 'bg-brand-600'}`}>
                    {isUser ? <User size={18} className="text-white" /> : <Bot size={18} className="text-white" />}
                </div>

                <div className={`flex-1 space-y-2 min-w-0 font-sans text-neutral-200 ${isUser ? 'flex flex-col items-end' : ''}`}>
                    {isEditing ? (
                        <div className="w-full bg-neutral-800 rounded-xl p-3 border border-neutral-700 shadow-lg">
                            <TextareaAutosize
                                value={editContent}
                                onChange={(e) => setEditContent(e.target.value)}
                                minRows={2}
                                className="w-full bg-transparent text-white focus:outline-none resize-none"
                                autoFocus
                            />
                            <div className="flex justify-end gap-2 mt-3">
                                <button
                                    onClick={handleCancel}
                                    className="px-3 py-1.5 text-sm rounded bg-neutral-700 hover:bg-neutral-600 text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="px-3 py-1.5 text-sm rounded bg-brand-600 hover:bg-brand-500 text-white transition-colors"
                                    disabled={!editContent.trim()}
                                >
                                    Save
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className={`prose prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 ${isUser ? 'bg-neutral-800 px-5 py-3 rounded-2xl md:rounded-3xl max-w-[85%]' : ''}`}>
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        code({ node, inline, className, children, ...props }: any) {
                                            const match = /language-(\w+)/.exec(className || '');
                                            return !inline && match ? (
                                                <CodeBlock
                                                    language={match[1]}
                                                    value={String(children).replace(/\n$/, '')}
                                                    {...props}
                                                />
                                            ) : (
                                                <code className="bg-neutral-700/50 px-1.5 py-0.5 rounded-md text-sm font-mono" {...props}>
                                                    {children}
                                                </code>
                                            );
                                        }
                                    }}
                                >
                                    {message.content + (isStreaming ? ' █' : '')}
                                </ReactMarkdown>
                            </div>
                            <MessageActions
                                message={message}
                                showCopy={!isStreaming}
                                onEdit={() => setIsEditing(true)}
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
