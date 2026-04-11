import { useEffect, useRef } from 'react';

const BOTTOM_THRESHOLD_PX = 24;

export function useAutoScroll(dependency: unknown) {
    const containerRef = useRef<HTMLDivElement>(null);
    const isUserScrolledUp = useRef(false);
    const pendingRaf = useRef<number | null>(null);
    const lastScrollTop = useRef(0);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        lastScrollTop.current = container.scrollTop;

        const handleScroll = () => {
            const { scrollTop, scrollHeight, clientHeight } = container;
            const isAtBottom = scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD_PX;
            const isScrollingUp = scrollTop < lastScrollTop.current;

            // As soon as user scrolls up, stop following stream output.
            if (isScrollingUp) {
                isUserScrolledUp.current = true;
            } else if (isAtBottom) {
                // Re-enable auto-follow only when user comes back to bottom.
                isUserScrolledUp.current = false;
            }

            lastScrollTop.current = scrollTop;
        };

        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY < 0) {
                isUserScrolledUp.current = true;
            }
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        container.addEventListener('wheel', handleWheel, { passive: true });
        return () => {
            container.removeEventListener('scroll', handleScroll);
            container.removeEventListener('wheel', handleWheel);
            if (pendingRaf.current !== null) {
                cancelAnimationFrame(pendingRaf.current);
                pendingRaf.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (containerRef.current && !isUserScrolledUp.current) {
            if (pendingRaf.current !== null) {
                cancelAnimationFrame(pendingRaf.current);
            }
            pendingRaf.current = requestAnimationFrame(() => {
                if (containerRef.current) {
                    containerRef.current.scrollTop = containerRef.current.scrollHeight;
                    lastScrollTop.current = containerRef.current.scrollTop;
                }
                pendingRaf.current = null;
            });
        }
    }, [dependency]);

    return containerRef;
}
