import { Check, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { useState, useEffect, useRef, memo } from 'react';

interface CodeBlockProps {
    language: string;
    value: string;
}

/** Maximum lines shown before collapsing with a "Show more" toggle. */
const COLLAPSE_THRESHOLD = 40;

export const CodeBlock = memo(function CodeBlock({ language, value }: CodeBlockProps) {
    const [copied, setCopied] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
    const codeRef = useRef<HTMLElement>(null);

    const lineCount = value.split('\n').length;
    const shouldCollapse = lineCount > COLLAPSE_THRESHOLD;

    // Initial collapse state
    useEffect(() => {
        if (shouldCollapse) setIsCollapsed(true);
    }, [shouldCollapse]);

    // Lazy-load highlight.js for syntax highlighting
    useEffect(() => {
        let cancelled = false;

        async function highlight() {
            try {
                const hljs = (await import('highlight.js')).default;
                if (cancelled) return;

                let result: string;
                if (language && hljs.getLanguage(language)) {
                    result = hljs.highlight(value, { language }).value;
                } else {
                    result = hljs.highlightAuto(value).value;
                }
                setHighlightedHtml(result);
            } catch {
                // Fallback: leave as plain text
            }
        }

        highlight();
        return () => { cancelled = true; };
    }, [value, language]);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const displayLanguage = language === 'text' ? 'plain text' : language;

    return (
        <div className="code-block-container relative rounded-lg my-4 bg-[#0d1117] overflow-hidden border border-neutral-800/60">
            {/* Header bar */}
            <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-neutral-800/60">
                <div className="flex items-center gap-3">
                    <span className="text-xs text-neutral-400 font-mono lowercase select-none">
                        {displayLanguage}
                    </span>
                    {shouldCollapse && (
                        <button
                            onClick={() => setIsCollapsed(!isCollapsed)}
                            className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                        >
                            {isCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                            {isCollapsed ? `Show all ${lineCount} lines` : 'Collapse'}
                        </button>
                    )}
                </div>
                <button
                    onClick={handleCopy}
                    className="text-neutral-400 hover:text-neutral-200 transition-colors flex items-center gap-1.5 text-xs"
                >
                    {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                </button>
            </div>

            {/* Code body */}
            <div
                className={`overflow-x-auto text-sm font-mono leading-relaxed scrollbar-thin scrollbar-thumb-neutral-700 transition-[max-height] duration-300 ease-in-out ${
                    isCollapsed ? 'max-h-[320px]' : 'max-h-[800px]'
                }`}
            >
                <pre className="m-0 bg-transparent p-4">
                    {highlightedHtml ? (
                        <code
                            ref={codeRef}
                            className={`hljs language-${language}`}
                            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                        />
                    ) : (
                        <code ref={codeRef} className="text-neutral-300">{value}</code>
                    )}
                </pre>
            </div>

            {/* Fade out overlay when collapsed */}
            {isCollapsed && shouldCollapse && (
                <div
                    className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[#0d1117] to-transparent pointer-events-none"
                />
            )}
        </div>
    );
});
