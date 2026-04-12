import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

describe('IconButton', () => {
    it('renders with required accessibility label and handles click', () => {
        const onClick = vi.fn();
        render(
            <IconButton
                icon={<X size={14} />}
                ariaLabel="Close item"
                onClick={onClick}
            />,
        );

        const button = screen.getByRole('button', { name: 'Close item' });
        fireEvent.click(button);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('does not call onClick when disabled', () => {
        const onClick = vi.fn();
        render(
            <IconButton
                icon={<X size={14} />}
                ariaLabel="Disabled action"
                onClick={onClick}
                disabled
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Disabled action' }));
        expect(onClick).not.toHaveBeenCalled();
    });

    it('applies active tone class when active', () => {
        render(
            <IconButton
                icon={<X size={14} />}
                ariaLabel="Active action"
                tone="brand"
                active
            />,
        );

        expect(screen.getByRole('button', { name: 'Active action' }).className).toContain('bg-indigo-500/30');
    });
});
