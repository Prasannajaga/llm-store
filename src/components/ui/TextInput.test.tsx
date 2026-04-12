import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { TextInput } from './TextInput';
import { AutosizeTextInput } from './AutosizeTextInput';

function TextInputHarness() {
    const [value, setValue] = useState('');
    return (
        <TextInput
            aria-label="Search field"
            leftAdornment={<Search data-testid="left-adornment" size={14} />}
            value={value}
            onChange={(event) => setValue(event.target.value)}
        />
    );
}

function AutosizeHarness() {
    const [value, setValue] = useState('');
    return (
        <AutosizeTextInput
            aria-label="Composer input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            variant="embedded"
        />
    );
}

describe('TextInput', () => {
    it('renders adornment and updates value', () => {
        render(<TextInputHarness />);

        const input = screen.getByRole('textbox', { name: 'Search field' });
        expect(screen.getByTestId('left-adornment')).toBeInTheDocument();
        fireEvent.change(input, { target: { value: 'hello' } });
        expect((input as HTMLInputElement).value).toBe('hello');
    });

    it('supports disabled state', () => {
        render(<TextInput aria-label="Disabled input" disabled value="" onChange={() => {}} />);
        expect(screen.getByRole('textbox', { name: 'Disabled input' })).toBeDisabled();
    });
});

describe('AutosizeTextInput', () => {
    it('renders textarea and updates value', () => {
        render(<AutosizeHarness />);

        const textarea = screen.getByRole('textbox', { name: 'Composer input' }) as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'test message' } });
        expect(textarea.value).toBe('test message');
    });
});
