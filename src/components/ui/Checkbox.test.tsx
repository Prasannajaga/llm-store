import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Checkbox } from './Checkbox';

function CheckboxHarness({ disabled = false }: { disabled?: boolean }) {
    const [checked, setChecked] = useState(true);
    return (
        <Checkbox
            checked={checked}
            onCheckedChange={setChecked}
            label="Top 3 only"
            ariaLabel="Top 3 only"
            disabled={disabled}
        />
    );
}

describe('Checkbox', () => {
    it('toggles checked state when clicked', () => {
        render(<CheckboxHarness />);
        const checkbox = screen.getByRole('checkbox', { name: 'Top 3 only' });
        expect(checkbox).toBeChecked();
        fireEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();
    });

    it('does not toggle when disabled', () => {
        const onCheckedChange = vi.fn();
        render(
            <Checkbox
                checked={true}
                onCheckedChange={onCheckedChange}
                ariaLabel="Disabled checkbox"
                disabled
            />,
        );

        fireEvent.click(screen.getByRole('checkbox', { name: 'Disabled checkbox' }));
        expect(onCheckedChange).not.toHaveBeenCalled();
    });
});
