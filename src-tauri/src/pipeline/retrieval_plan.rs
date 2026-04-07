use std::collections::HashMap;
use std::time::Instant;

use sqlx::SqlitePool;

use crate::storage;

use super::types::{
    LayerOutcome, NormalizedInput, PipelineWarning, PipelineWarningCode, RetrievalMode,
    RetrievalPlan, DEFAULT_CONTEXT_LIMIT,
};

pub const LAYER_NAME: &str = "retrieval_plan";
const RETRIEVAL_MODE_KEY: &str = "pipeline.retrieval_mode";

pub async fn run(
    pool: &SqlitePool,
    normalized: &NormalizedInput,
    request_id: &str,
) -> LayerOutcome<RetrievalPlan> {
    let started = Instant::now();

    let mut warnings = Vec::new();
    let retrieval_mode = match load_settings_map(pool).await {
        Ok(settings) => parse_retrieval_mode(settings.get(RETRIEVAL_MODE_KEY), &mut warnings),
        Err(err) => {
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::RetrievalPlanFallback,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "Failed to load retrieval mode setting. Falling back to vector mode. ({})",
                    err
                ),
            });
            RetrievalMode::Vector
        }
    };

    let plan = RetrievalPlan {
        mode: retrieval_mode,
        limit: DEFAULT_CONTEXT_LIMIT,
        document_ids: normalized.selected_doc_ids.clone(),
    };

    let elapsed = started.elapsed().as_millis() as u64;
    if warnings.is_empty() {
        LayerOutcome::success(plan, elapsed)
    } else {
        tracing::warn!(
            request_id = %request_id,
            layer = LAYER_NAME,
            warning_count = warnings.len(),
            "Retrieval plan used fallback"
        );
        LayerOutcome::fallback(plan, warnings, elapsed)
    }
}

fn parse_retrieval_mode(
    configured_mode: Option<&String>,
    warnings: &mut Vec<PipelineWarning>,
) -> RetrievalMode {
    let Some(mode) = configured_mode else {
        return RetrievalMode::Vector;
    };

    match mode.trim().to_ascii_lowercase().as_str() {
        "vector" => RetrievalMode::Vector,
        "graph" => RetrievalMode::Graph,
        _ => {
            warnings.push(PipelineWarning {
                code: PipelineWarningCode::RetrievalPlanFallback,
                layer: LAYER_NAME.to_string(),
                message: format!(
                    "Unknown retrieval mode '{}' configured. Falling back to vector mode.",
                    mode
                ),
            });
            RetrievalMode::Vector
        }
    }
}

async fn load_settings_map(pool: &SqlitePool) -> Result<HashMap<String, String>, String> {
    let entries = storage::load_all_settings(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(entries
        .into_iter()
        .map(|entry| (entry.key, entry.value))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::parse_retrieval_mode;
    use crate::pipeline::types::{PipelineWarning, PipelineWarningCode, RetrievalMode};

    #[test]
    fn invalid_retrieval_mode_falls_back_to_vector() {
        let mut warnings: Vec<PipelineWarning> = Vec::new();
        let configured = Some("hybrid".to_string());

        let mode = parse_retrieval_mode(configured.as_ref(), &mut warnings);
        assert_eq!(mode, RetrievalMode::Vector);
        assert!(!warnings.is_empty());
        assert_eq!(warnings[0].code, PipelineWarningCode::RetrievalPlanFallback);
    }
}
