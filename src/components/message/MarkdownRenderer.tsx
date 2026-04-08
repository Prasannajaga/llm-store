import { memo, isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { CodeBlock } from './CodeBlock';
import { MermaidBlock } from './MermaidBlock';

interface MarkdownRendererProps {
    content: string;
    isStreaming?: boolean;
}

/** Detects whether a fenced code block is a mermaid diagram. */
const MERMAID_LANGUAGE = 'mermaid';

/** Stable plugin references — never re-allocated, so ReactMarkdown skips unnecessary reconciliation. */
const REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [rehypeKatex];

function extractText(node: ReactNode): string {
    if (node === null || node === undefined || typeof node === 'boolean') {
        return '';
    }
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    if (Array.isArray(node)) {
        return node.map(extractText).join('');
    }
    if (isValidElement<{ children?: ReactNode }>(node)) {
        return extractText(node.props.children);
    }
    return '';
}

/**
 * Stable components object — hoisted out of the component so the same reference
 * is reused across renders. Without this, ReactMarkdown receives a new `components`
 * object on every render and must re-diff the entire tree.
 */
const MARKDOWN_COMPONENTS = {
    // ─── Fenced code blocks ───────────────────────────────
    code({ inline, className, children, ...props }: ComponentPropsWithoutRef<'code'> & { inline?: boolean }) {
        const match = /language-([^\s]+)/.exec(className || '');
        const language = match ? match[1] : '';
        const codeString = extractText(children).replace(/\n$/, '');

        // Use ReactMarkdown's inline signal directly so fenced one-line blocks
        // without language are still rendered as block code.
        if (inline) {
            return (
                <code
                    className="bg-neutral-700/60 text-indigo-300 px-1.5 py-0.5 rounded-md text-[0.85em] font-mono"
                    {...props}
                >
                    {children}
                </code>
            );
        }

        // Mermaid diagrams
        if (language === MERMAID_LANGUAGE) {
            return <MermaidBlock value={codeString} />;
        }

        // Regular code blocks
        return (
            <CodeBlock
                language={language || 'text'}
                value={codeString}
            />
        );
    },

    // ─── Pre element: strip the wrapper that ReactMarkdown adds ──
    pre({ children }: { children?: ReactNode }) {
        return <>{children}</>;
    },

    // ─── Tables ──────────────────────────────────────────
    table({ children, ...props }: ComponentPropsWithoutRef<'table'>) {
        return (
            <div className="my-4 overflow-x-auto rounded-lg border border-neutral-800/60">
                <table className="min-w-full text-sm" {...props}>
                    {children}
                </table>
            </div>
        );
    },
    thead({ children, ...props }: ComponentPropsWithoutRef<'thead'>) {
        return (
            <thead className="bg-[#161b22] text-neutral-300" {...props}>
                {children}
            </thead>
        );
    },
    th({ children, ...props }: ComponentPropsWithoutRef<'th'>) {
        return (
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-neutral-400 border-b border-neutral-700/60" {...props}>
                {children}
            </th>
        );
    },
    td({ children, ...props }: ComponentPropsWithoutRef<'td'>) {
        return (
            <td className="px-4 py-2.5 border-b border-neutral-800/40 text-neutral-300" {...props}>
                {children}
            </td>
        );
    },

    // ─── Blockquotes ─────────────────────────────────────
    blockquote({ children, ...props }: ComponentPropsWithoutRef<'blockquote'>) {
        return (
            <blockquote
                className="my-3 border-l-3 border-indigo-500/60 pl-4 text-neutral-400 italic"
                {...props}
            >
                {children}
            </blockquote>
        );
    },

    // ─── Horizontal rules ────────────────────────────────
    hr({ ...props }: ComponentPropsWithoutRef<'hr'>) {
        return (
            <hr
                className="my-6 border-none h-px bg-gradient-to-r from-transparent via-neutral-700 to-transparent"
                {...props}
            />
        );
    },

    // ─── Links ───────────────────────────────────────────
    a({ children, href, ...props }: ComponentPropsWithoutRef<'a'>) {
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2 decoration-indigo-400/40 hover:decoration-indigo-300/60 transition-colors"
                {...props}
            >
                {children}
            </a>
        );
    },

    // ─── Images ──────────────────────────────────────────
    img({ src, alt, ...props }: ComponentPropsWithoutRef<'img'>) {
        return (
            <img
                src={src}
                alt={alt}
                className="rounded-lg max-w-full h-auto my-4 border border-neutral-800/40"
                loading="lazy"
                {...props}
            />
        );
    },

    // ─── Lists ───────────────────────────────────────────
    ul({ children, ...props }: ComponentPropsWithoutRef<'ul'>) {
        return (
            <ul className="my-2 ml-1 list-disc list-outside space-y-1 marker:text-neutral-500" {...props}>
                {children}
            </ul>
        );
    },
    ol({ children, ...props }: ComponentPropsWithoutRef<'ol'>) {
        return (
            <ol className="my-2 ml-1 list-decimal list-outside space-y-1 marker:text-neutral-500" {...props}>
                {children}
            </ol>
        );
    },
    li({ children, ...props }: ComponentPropsWithoutRef<'li'>) {
        return (
            <li className="pl-1 text-neutral-200" {...props}>
                {children}
            </li>
        );
    },

    // ─── Headings ────────────────────────────────────────
    h1({ children, ...props }: ComponentPropsWithoutRef<'h1'>) {
        return <h1 className="text-2xl font-bold text-white mt-6 mb-3 pb-2 border-b border-neutral-700/50" {...props}>{children}</h1>;
    },
    h2({ children, ...props }: ComponentPropsWithoutRef<'h2'>) {
        return <h2 className="text-xl font-semibold text-white mt-5 mb-2 pb-1.5 border-b border-neutral-800/50" {...props}>{children}</h2>;
    },
    h3({ children, ...props }: ComponentPropsWithoutRef<'h3'>) {
        return <h3 className="text-lg font-semibold text-neutral-100 mt-4 mb-2" {...props}>{children}</h3>;
    },
    h4({ children, ...props }: ComponentPropsWithoutRef<'h4'>) {
        return <h4 className="text-base font-medium text-neutral-200 mt-3 mb-1.5" {...props}>{children}</h4>;
    },

    // ─── Paragraphs ──────────────────────────────────────
    p({ children, ...props }: ComponentPropsWithoutRef<'p'>) {
        return <p className="my-2 leading-relaxed text-neutral-200" {...props}>{children}</p>;
    },

    // ─── Strong / Em ─────────────────────────────────────
    strong({ children, ...props }: ComponentPropsWithoutRef<'strong'>) {
        return <strong className="font-semibold text-white" {...props}>{children}</strong>;
    },
    em({ children, ...props }: ComponentPropsWithoutRef<'em'>) {
        return <em className="text-neutral-300" {...props}>{children}</em>;
    },
};

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, isStreaming = false }: MarkdownRendererProps) {
    // During streaming, skip the expensive ReactMarkdown parse entirely.
    // Plain text with a blinking cursor is rendered instead, avoiding
    // ~30 full markdown re-parses per second from the flush interval.
    if (isStreaming) {
        return (
            <pre className="whitespace-pre-wrap font-sans text-neutral-200 leading-relaxed m-0 bg-transparent">
                {content}
                <span className="inline-block w-2 h-5 ml-0.5 bg-neutral-400 align-middle animate-pulse rounded-sm" />
            </pre>
        );
    }

    return (
        <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={MARKDOWN_COMPONENTS}
        >
            {content}
        </ReactMarkdown>
    );
});
