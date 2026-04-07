import { invoke } from '@tauri-apps/api/core';
import type {
    KnowledgeDocument,
    KnowledgeIngestResult,
    KnowledgeSearchResult,
} from '../types';

export const knowledgeService = {
    async ingestFile(path: string): Promise<KnowledgeIngestResult> {
        return invoke('ingest_knowledge_file', { path });
    },

    async listDocuments(): Promise<KnowledgeDocument[]> {
        return invoke('list_knowledge_documents');
    },

    async listDocumentChunks(documentId: string): Promise<KnowledgeSearchResult[]> {
        return invoke('list_knowledge_document_chunks', { documentId });
    },

    async deleteDocument(documentId: string): Promise<void> {
        return invoke('delete_knowledge_document', { documentId });
    },

    async searchVector(
        query: string,
        options?: {
            limit?: number;
            documentId?: string | null;
            topThreeOnly?: boolean;
        }
    ): Promise<KnowledgeSearchResult[]> {
        return invoke('search_knowledge_vector', {
            query,
            limit: options?.limit ?? null,
            documentId: options?.documentId ?? null,
            topThreeOnly: options?.topThreeOnly ?? null,
        });
    },

    async searchGraph(
        query: string,
        options?: {
            limit?: number;
            documentId?: string | null;
            topThreeOnly?: boolean;
        }
    ): Promise<KnowledgeSearchResult[]> {
        return invoke('search_knowledge_graph', {
            query,
            limit: options?.limit ?? null,
            documentId: options?.documentId ?? null,
            topThreeOnly: options?.topThreeOnly ?? null,
        });
    },

    async search(
        query: string,
        options?: {
            limit?: number;
            documentId?: string | null;
            topThreeOnly?: boolean;
        }
    ): Promise<KnowledgeSearchResult[]> {
        return invoke('search_knowledge', {
            query,
            limit: options?.limit ?? null,
            documentId: options?.documentId ?? null,
            topThreeOnly: options?.topThreeOnly ?? null,
        });
    },
};
