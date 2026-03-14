import { invoke } from '@tauri-apps/api/core';
import type { Feedback, FeedbackRating } from '../types';

export const feedbackService = {
    async saveFeedback(
        messageId: string,
        rating: FeedbackRating,
        prompt: string,
        response: string
    ): Promise<void> {
        return invoke('save_feedback', { messageId, rating, prompt, response });
    },

    async getFeedback(messageId: string): Promise<Feedback | null> {
        return invoke('get_feedback', { messageId });
    },

    async listAllFeedback(ratingFilter?: FeedbackRating): Promise<Feedback[]> {
        return invoke('list_all_feedback', {
            ratingFilter: ratingFilter ?? null,
        });
    },
};
