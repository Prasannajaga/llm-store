import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

interface CodeBlockProps {
    language: string;
    value: string;
}

export function CodeBlock({ language, value }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="relative rounded-md my-4 bg-neutral-950 overflow-hidden border border-neutral-800">
            <div className="flex items-center justify-between px-4 py-2 bg-neutral-900 border-b border-neutral-800">
                <span className="text-xs text-neutral-400 font-mono lowercase">{language}</span>
                <button
                    onClick={handleCopy}
                    className="text-neutral-400 hover:text-neutral-200 transition-colors flex items-center gap-1.5 text-xs"
                >
                    {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    <span>{copied ? 'Copied!' : 'Copy code'}</span>
                </button>
            </div>
            <div className="p-4 overflow-x-auto text-sm font-mono text-neutral-300 leading-relaxed max-h-[600px] scrollbar-thin scrollbar-thumb-neutral-700">
                <pre className="m-0 bg-transparent">
                    <code>{value}</code>
                </pre>
            </div>
        </div>
    );
}
