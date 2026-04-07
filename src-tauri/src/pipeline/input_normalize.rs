use std::collections::HashSet;
use std::time::Instant;

use super::types::{LayerOutcome, NormalizedInput, PipelineError, PipelineErrorCode};
use super::types::{PipelineRequest, PipelineWarning, PipelineWarningCode};

pub const LAYER_NAME: &str = "input_normalize";
const MAX_PROMPT_CHARS: usize = 32_000;

pub fn run(request: &PipelineRequest) -> Result<LayerOutcome<NormalizedInput>, PipelineError> {
    let started = Instant::now();

    let trimmed = request.prompt.trim();
    if trimmed.is_empty() {
        return Err(PipelineError::new(
            PipelineErrorCode::InvalidInput,
            LAYER_NAME,
            "Message is empty. Please type a prompt and try again.",
            "Prompt was empty after trimming whitespace",
            request.request_id.clone(),
        ));
    }

    let normalized_prompt: String = trimmed.chars().take(MAX_PROMPT_CHARS).collect();
    if normalized_prompt.trim().is_empty() {
        return Err(PipelineError::new(
            PipelineErrorCode::InvalidInput,
            LAYER_NAME,
            "Message could not be processed. Please try a different prompt.",
            "Prompt became empty after max-char normalization",
            request.request_id.clone(),
        ));
    }

    let mut warnings = Vec::new();
    let normalized_docs = normalize_doc_ids(request.selected_doc_ids.as_ref(), &mut warnings);

    let elapsed = started.elapsed().as_millis() as u64;
    let mut outcome = LayerOutcome::success(
        NormalizedInput {
            prompt: normalized_prompt,
            selected_doc_ids: normalized_docs,
        },
        elapsed,
    );
    outcome.warnings = warnings;
    Ok(outcome)
}

fn normalize_doc_ids(
    selected_doc_ids: Option<&Vec<String>>,
    warnings: &mut Vec<PipelineWarning>,
) -> Option<Vec<String>> {
    let Some(doc_ids) = selected_doc_ids else {
        return None;
    };

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut had_invalid = false;

    for id in doc_ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            had_invalid = true;
            continue;
        }

        if seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    }

    if had_invalid {
        warnings.push(PipelineWarning {
            code: PipelineWarningCode::ParsingSkipped,
            layer: LAYER_NAME.to_string(),
            message: "Some selected knowledge identifiers were invalid and were skipped"
                .to_string(),
        });
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::pipeline::types::PipelineRequest;

    #[test]
    fn rejects_empty_prompt() {
        let request = PipelineRequest {
            chat_id: "chat-1".to_string(),
            prompt: "   ".to_string(),
            selected_doc_ids: None,
            request_id: "req-1".to_string(),
        };

        let result = run(&request);
        assert!(result.is_err());
    }

    #[test]
    fn normalizes_and_deduplicates_doc_ids() {
        let request = PipelineRequest {
            chat_id: "chat-1".to_string(),
            prompt: "  hello  ".to_string(),
            selected_doc_ids: Some(vec![
                " doc-a ".to_string(),
                "".to_string(),
                "doc-a".to_string(),
                "doc-b".to_string(),
            ]),
            request_id: "req-1".to_string(),
        };

        let outcome = run(&request).expect("input normalization should succeed");
        let data = outcome.data.expect("normalized input should exist");

        assert_eq!(data.prompt, "hello");
        assert_eq!(
            data.selected_doc_ids,
            Some(vec!["doc-a".to_string(), "doc-b".to_string()])
        );
        assert!(!outcome.warnings.is_empty());
    }
}
