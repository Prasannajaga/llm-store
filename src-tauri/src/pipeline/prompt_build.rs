use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use crate::models::KnowledgeSearchResult;

use super::types::{LayerOutcome, PipelineWarning, PipelineWarningCode};

pub const LAYER_NAME: &str = "prompt_build";

pub fn run(user_prompt: &str, chunks: &[KnowledgeSearchResult]) -> LayerOutcome<String> {
    let started = Instant::now();
    let safe_prompt = user_prompt.trim();

    let built = catch_unwind(AssertUnwindSafe(|| build_prompt(safe_prompt, chunks)));
    let elapsed = started.elapsed().as_millis() as u64;

    match built {
        Ok(prompt) => LayerOutcome::success(prompt, elapsed),
        Err(_) => LayerOutcome::fallback(
            minimal_template(safe_prompt),
            vec![PipelineWarning {
                code: PipelineWarningCode::PromptFallbackTemplate,
                layer: LAYER_NAME.to_string(),
                message: "Prompt assembly failed. Used minimal safe prompt template.".to_string(),
            }],
            elapsed,
        ),
    }
}

fn build_prompt(user_prompt: &str, chunks: &[KnowledgeSearchResult]) -> String {
    if user_prompt.is_empty() {
        return minimal_template(user_prompt);
    }

    if chunks.is_empty() {
        return minimal_template(user_prompt);
    }

    let context = chunks
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            format!(
                "[{}] {} (score {:.3})\n{}",
                index + 1,
                hit.file_name,
                hit.score,
                hit.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    [
        "Use the following knowledge context when it is relevant to the user question.",
        "If context is insufficient or unrelated, clearly say so and continue with best-effort reasoning.",
        "",
        "Knowledge Context:",
        &context,
        "",
        &format!("User Question: {}", user_prompt),
    ]
    .join("\n")
}

fn minimal_template(user_prompt: &str) -> String {
    let final_prompt = if user_prompt.is_empty() {
        "Please answer clearly and safely."
    } else {
        user_prompt
    };

    [
        "You are a helpful assistant.",
        "Answer clearly, and mention uncertainty when context is missing.",
        "",
        &format!("User Question: {}", final_prompt),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::run;

    #[test]
    fn empty_context_uses_minimal_template() {
        let outcome = run("How do I deploy this app?", &[]);
        let prompt = outcome.data.expect("prompt should exist");
        assert!(prompt.contains("User Question: How do I deploy this app?"));
        assert!(prompt.contains("You are a helpful assistant."));
    }
}
