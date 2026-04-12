import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ToggleSwitch } from './ToggleSwitch';

function ToggleSwitchHarness({ disabled = false }: { disabled?: boolean }) {
    const [checked, setChecked] = useState(false);
    return (
        <ToggleSwitch
            checked={checked}
            onCheckedChange={setChecked}
            ariaLabel="Thinking mode"
            disabled={disabled}
        />
    );
}

describe('ToggleSwitch', () => {
    it('toggles checked state on click', () => {
        render(<ToggleSwitchHarness />);

        const switchButton = screen.getByRole('switch', { name: 'Thinking mode' });
        expect(switchButton).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(switchButton);
        expect(switchButton).toHaveAttribute('aria-checked', 'true');
    });

    it('does not toggle when disabled', () => {
        const onCheckedChange = vi.fn();
        render(
            <ToggleSwitch
                checked={false}
                onCheckedChange={onCheckedChange}
                ariaLabel="Disabled switch"
                disabled
            />,
        );

        fireEvent.click(screen.getByRole('switch', { name: 'Disabled switch' }));
        expect(onCheckedChange).not.toHaveBeenCalled();
    });
});
