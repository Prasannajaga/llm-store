import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeView } from './KnowledgeView';
import { knowledgeService } from '../../services/knowledgeService';

vi.mock('@tauri-apps/plugin-dialog', () => ({
    open: vi.fn(),
}));

vi.mock('../../services/knowledgeService', () => ({
    knowledgeService: {
        ingestFile: vi.fn(),
        listDocuments: vi.fn(),
        listDocumentChunks: vi.fn(),
        deleteDocument: vi.fn(),
        searchVector: vi.fn(),
        searchGraph: vi.fn(),
    },
}));

describe('KnowledgeView', () => {
    it('uses shared checkbox control for Top 3 only toggle', async () => {
        vi.mocked(knowledgeService.listDocuments).mockResolvedValue([
            {
                id: 'doc-1',
                file_name: 'readme.md',
                file_path: '/tmp/readme.md',
                chunk_count: 3,
                created_at: new Date().toISOString(),
            },
        ]);
        vi.mocked(knowledgeService.listDocumentChunks).mockResolvedValue([]);

        render(<KnowledgeView />);

        const checkbox = await screen.findByRole('checkbox', { name: 'Top 3 only' });
        expect(checkbox).toBeChecked();

        fireEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();
    });
});
