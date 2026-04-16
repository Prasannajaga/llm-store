use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::models::{AgentFsRoot, AgentPermissionOverride};
use crate::storage;

pub const LEGACY_PERMISSION_RULES_SETTING_KEY: &str = "agent.permissionRules.v1";
const PERMISSIONS_V2_MIGRATED_SETTING_KEY: &str = "agent.permissions.v2.migrated";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsIntent {
    Read,
    List,
    Write,
    Delete,
}

impl FsIntent {
    pub fn canonical_tool(self) -> &'static str {
        match self {
            Self::Read => "fs.read",
            Self::List => "fs.list",
            Self::Write => "fs.write",
            Self::Delete => "fs.delete",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionAction {
    Allow,
    Deny,
    Ask,
}

impl PermissionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "allow" => Some(Self::Allow),
            "deny" => Some(Self::Deny),
            "ask" => Some(Self::Ask),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FsPermissionContext {
    pub requested_path: String,
    pub root_candidate: Option<String>,
    pub outside_trusted_roots: bool,
}

#[derive(Debug, Clone)]
pub struct FsPermissionEvaluation {
    pub match_target: Option<String>,
    pub matched_pattern: Option<String>,
    pub matched_action: Option<PermissionAction>,
    pub default_action: PermissionAction,
    pub final_action: PermissionAction,
    pub context: FsPermissionContext,
}

#[derive(Debug, Clone)]
pub struct PlannerPermissionContext {
    pub workspace_root: String,
    pub trusted_roots: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PermissionOverrideRecord {
    pub id: String,
    pub tool: String,
    pub pattern: String,
    pub normalized_pattern: String,
    pub action: PermissionAction,
    pub created_at: String,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct PathResolver {
    workspace_root: PathBuf,
    home_dir: Option<PathBuf>,
}

impl Default for PathResolver {
    fn default() -> Self {
        Self::new(default_workspace_root())
    }
}

impl PathResolver {
    pub fn new(workspace_root: PathBuf) -> Self {
        let root = normalize_path_components(workspace_root);
        Self {
            workspace_root: root,
            home_dir: dirs::home_dir(),
        }
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn normalize_for_storage(&self, path: &str) -> Result<String, String> {
        let resolved = self.resolve_for_write(path)?;
        Ok(path_to_string(&resolved))
    }

    pub fn resolve_for_read_or_list(&self, path: &str) -> Result<PathBuf, String> {
        match self.resolve_existing(path) {
            Ok(path) => Ok(path),
            Err(_) => self.resolve_for_write(path),
        }
    }

    pub fn resolve_for_write(&self, path: &str) -> Result<PathBuf, String> {
        let normalized_input = self.normalize_input_path(path)?;
        canonicalize_with_missing_tail(&normalized_input)
    }

    pub fn resolve_existing(&self, path: &str) -> Result<PathBuf, String> {
        let normalized_input = self.normalize_input_path(path)?;
        normalized_input
            .canonicalize()
            .map_err(|err| format!("Could not resolve path '{}': {}", path, err))
    }

    fn normalize_input_path(&self, path: &str) -> Result<PathBuf, String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("Path cannot be empty".to_string());
        }

        let expanded = self.expand_home(trimmed);
        let raw = Path::new(&expanded);
        let resolved = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            self.workspace_root.join(raw)
        };
        Ok(normalize_path_components(resolved))
    }

    fn expand_home(&self, path: &str) -> String {
        if path == "~" {
            if let Some(home) = &self.home_dir {
                return home.to_string_lossy().to_string();
            }
        }

        if let Some(remainder) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
            if let Some(home) = &self.home_dir {
                return home.join(remainder).to_string_lossy().to_string();
            }
        }

        path.to_string()
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ScopeMatcher;

impl ScopeMatcher {
    pub fn contains(root: &Path, candidate: &Path) -> bool {
        let mut root_components = root.components();
        let mut candidate_components = candidate.components();

        loop {
            match root_components.next() {
                Some(root_component) => match candidate_components.next() {
                    Some(candidate_component)
                        if components_equal(root_component, candidate_component) => {}
                    _ => return false,
                },
                None => return true,
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct PermissionEngine {
    resolver: PathResolver,
    trusted_roots: Vec<AgentFsRoot>,
    overrides: Vec<PermissionOverrideRecord>,
}

impl PermissionEngine {
    pub fn empty(workspace_root: PathBuf) -> Self {
        Self {
            resolver: PathResolver::new(workspace_root),
            trusted_roots: Vec::new(),
            overrides: Vec::new(),
        }
    }

    pub async fn load(pool: &SqlitePool, workspace_root: PathBuf) -> Result<Self, String> {
        let trusted_roots = storage::list_agent_fs_roots(pool)
            .await
            .map_err(|err| err.to_string())?;
        let overrides = storage::list_agent_permission_overrides(pool)
            .await
            .map_err(|err| err.to_string())?
            .into_iter()
            .filter_map(override_model_to_record)
            .collect::<Vec<_>>();

        Ok(Self {
            resolver: PathResolver::new(workspace_root),
            trusted_roots,
            overrides,
        })
    }

    pub fn planner_context(&self) -> PlannerPermissionContext {
        PlannerPermissionContext {
            workspace_root: path_to_string(self.resolver.workspace_root()),
            trusted_roots: self
                .trusted_roots
                .iter()
                .map(|root| root.normalized_path.clone())
                .collect(),
        }
    }

    pub fn evaluate_fs(
        &self,
        intent: FsIntent,
        path: &str,
    ) -> Result<FsPermissionEvaluation, String> {
        let resolved = match intent {
            FsIntent::Read | FsIntent::List => self.resolver.resolve_for_read_or_list(path)?,
            FsIntent::Write | FsIntent::Delete => self.resolver.resolve_for_write(path)?,
        };
        let resolved_text = path_to_string(&resolved);
        let inside_trusted_root = self.is_inside_trusted_root(&resolved);
        let default_action = match intent {
            FsIntent::Read | FsIntent::List if inside_trusted_root => PermissionAction::Allow,
            FsIntent::Read | FsIntent::List => PermissionAction::Ask,
            FsIntent::Write | FsIntent::Delete => PermissionAction::Ask,
        };

        let mut matched_pattern = None;
        let mut matched_action = None;
        for rule in &self.overrides {
            if !override_matches_tool(&rule.tool, intent) {
                continue;
            }
            if override_matches_path(rule, &resolved) {
                matched_pattern = Some(rule.pattern.clone());
                matched_action = Some(rule.action);
            }
        }

        let final_action = matched_action.unwrap_or(default_action);
        let root_candidate =
            if matches!(intent, FsIntent::Read | FsIntent::List) && !inside_trusted_root {
                derive_root_candidate(intent, &resolved)
            } else {
                None
            };

        Ok(FsPermissionEvaluation {
            match_target: Some(resolved_text.clone()),
            matched_pattern,
            matched_action,
            default_action,
            final_action,
            context: FsPermissionContext {
                requested_path: resolved_text,
                root_candidate,
                outside_trusted_roots: !inside_trusted_root,
            },
        })
    }

    pub async fn grant_root(
        &mut self,
        pool: &SqlitePool,
        path: &str,
        source: &str,
    ) -> Result<AgentFsRoot, String> {
        grant_root(pool, &self.resolver, path, source)
            .await
            .map(|root| {
                if self
                    .trusted_roots
                    .iter()
                    .all(|item| item.normalized_path != root.normalized_path)
                {
                    self.trusted_roots.push(root.clone());
                }
                root
            })
    }

    pub async fn add_allow_override(
        &mut self,
        pool: &SqlitePool,
        intent: FsIntent,
        path: &str,
        metadata: Option<Value>,
    ) -> Result<Option<PermissionOverrideRecord>, String> {
        let tool = intent.canonical_tool();
        let normalized_pattern = self.resolver.normalize_for_storage(path)?;

        if let Some(existing) = storage::find_agent_permission_override(
            pool,
            tool,
            PermissionAction::Allow.as_str(),
            &normalized_pattern,
        )
        .await
        .map_err(|err| err.to_string())?
        .and_then(override_model_to_record)
        {
            if self.overrides.iter().all(|item| item.id != existing.id) {
                self.overrides.push(existing.clone());
            }
            return Ok(Some(existing));
        }

        let id = Uuid::new_v4().to_string();
        let metadata_text = metadata
            .as_ref()
            .map(Value::to_string)
            .filter(|value| !value.trim().is_empty());
        storage::insert_agent_permission_override(
            pool,
            &id,
            tool,
            &normalized_pattern,
            &normalized_pattern,
            PermissionAction::Allow.as_str(),
            metadata_text.as_deref(),
        )
        .await
        .map_err(|err| err.to_string())?;

        let created = storage::find_agent_permission_override(
            pool,
            tool,
            PermissionAction::Allow.as_str(),
            &normalized_pattern,
        )
        .await
        .map_err(|err| err.to_string())?
        .and_then(override_model_to_record);

        if let Some(created_rule) = created {
            self.overrides.push(created_rule.clone());
            return Ok(Some(created_rule));
        }

        Ok(None)
    }

    fn is_inside_trusted_root(&self, candidate: &Path) -> bool {
        self.trusted_roots.iter().any(|root| {
            let root_path = Path::new(&root.normalized_path);
            ScopeMatcher::contains(root_path, candidate)
        })
    }
}

pub async fn list_roots(pool: &SqlitePool) -> Result<Vec<AgentFsRoot>, String> {
    storage::list_agent_fs_roots(pool)
        .await
        .map_err(|err| err.to_string())
}

pub async fn revoke_root(pool: &SqlitePool, root_id: &str) -> Result<(), String> {
    storage::delete_agent_fs_root(pool, root_id)
        .await
        .map_err(|err| err.to_string())
}

pub async fn grant_root(
    pool: &SqlitePool,
    resolver: &PathResolver,
    path: &str,
    source: &str,
) -> Result<AgentFsRoot, String> {
    let normalized = resolver.normalize_for_storage(path)?;
    let normalized_path = PathBuf::from(&normalized);
    let root_path = if normalized_path.exists() {
        normalized_path
    } else {
        normalized_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(&normalized))
    };
    let canonical_root = if root_path.exists() {
        root_path
            .canonicalize()
            .map_err(|err| format!("Could not resolve root '{}': {}", root_path.display(), err))?
    } else {
        return Err(format!("Could not resolve root '{}'", root_path.display()));
    };
    let root_normalized = path_to_string(&canonical_root);

    if let Some(existing) = storage::find_agent_fs_root_by_normalized_path(pool, &root_normalized)
        .await
        .map_err(|err| err.to_string())?
    {
        return Ok(existing);
    }

    let id = Uuid::new_v4().to_string();
    storage::insert_agent_fs_root(pool, &id, &root_normalized, &root_normalized, source)
        .await
        .map_err(|err| err.to_string())?;

    storage::find_agent_fs_root_by_normalized_path(pool, &root_normalized)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Root grant was saved but could not be reloaded".to_string())
}

pub async fn ensure_migration(
    pool: &SqlitePool,
    settings: &HashMap<String, String>,
    resolver: &PathResolver,
) -> Result<(), String> {
    if is_migrated(settings.get(PERMISSIONS_V2_MIGRATED_SETTING_KEY)) {
        return Ok(());
    }

    let legacy_rules = parse_legacy_rules(settings);
    for rule in legacy_rules {
        migrate_legacy_rule(pool, resolver, &rule).await?;
    }

    storage::save_setting(pool, PERMISSIONS_V2_MIGRATED_SETTING_KEY, "true")
        .await
        .map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize, Clone)]
struct LegacyPermissionRule {
    tool: String,
    pattern: String,
    action: PermissionAction,
    #[serde(default)]
    metadata: Option<Value>,
}

fn parse_legacy_rules(settings: &HashMap<String, String>) -> Vec<LegacyPermissionRule> {
    let Some(raw) = settings.get(LEGACY_PERMISSION_RULES_SETTING_KEY) else {
        return Vec::new();
    };

    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|entry| serde_json::from_value::<LegacyPermissionRule>(entry.clone()).ok())
        .collect::<Vec<_>>()
}

async fn migrate_legacy_rule(
    pool: &SqlitePool,
    resolver: &PathResolver,
    rule: &LegacyPermissionRule,
) -> Result<(), String> {
    let Some(normalized_tool) = normalize_legacy_tool(&rule.tool) else {
        return Ok(());
    };
    if !is_fs_tool(&normalized_tool) {
        return Ok(());
    }

    let normalized_pattern = if rule.pattern.trim() == "*" {
        "*".to_string()
    } else {
        match resolver.normalize_for_storage(&rule.pattern) {
            Ok(path) => path,
            Err(_) => return Ok(()),
        }
    };

    if rule.action == PermissionAction::Allow
        && matches!(normalized_tool.as_str(), "*" | "fs.read" | "fs.list")
        && normalized_pattern != "*"
    {
        let root_candidate = derive_legacy_root_candidate(&normalized_tool, &normalized_pattern);
        let _ = grant_root(pool, resolver, &root_candidate, "legacy_rule_migration").await;
        return Ok(());
    }

    if let Some(existing) = storage::find_agent_permission_override(
        pool,
        &normalized_tool,
        rule.action.as_str(),
        &normalized_pattern,
    )
    .await
    .map_err(|err| err.to_string())?
    {
        let _ = existing;
        return Ok(());
    }

    let metadata = json!({
        "source": "legacy_rule_migration",
        "legacy": {
            "tool": rule.tool.clone(),
            "pattern": rule.pattern.clone(),
            "action": rule.action.as_str(),
            "metadata": rule.metadata.clone(),
        }
    });
    storage::insert_agent_permission_override(
        pool,
        &Uuid::new_v4().to_string(),
        &normalized_tool,
        &normalized_pattern,
        &normalized_pattern,
        rule.action.as_str(),
        Some(&metadata.to_string()),
    )
    .await
    .map_err(|err| err.to_string())
}

fn is_migrated(value: Option<&String>) -> bool {
    let Some(value) = value else {
        return false;
    };
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn derive_legacy_root_candidate(tool: &str, normalized_pattern: &str) -> String {
    if tool == "fs.read" {
        let pattern_path = PathBuf::from(normalized_pattern);
        if let Some(parent) = pattern_path.parent() {
            return path_to_string(parent);
        }
    }
    normalized_pattern.to_string()
}

fn is_fs_tool(tool: &str) -> bool {
    matches!(tool, "*" | "fs.read" | "fs.list" | "fs.write" | "fs.delete")
}

fn normalize_legacy_tool(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed == "*" {
        return Some("*".to_string());
    }
    let normalized = trimmed
        .to_ascii_lowercase()
        .replace(['_', '-'], ".")
        .replace(' ', "");
    let canonical = match normalized.as_str() {
        "fs.read" | "read" | "fsread" => "fs.read",
        "fs.list" | "list" | "fslist" | "ls" => "fs.list",
        "fs.write" | "write" | "fswrite" => "fs.write",
        "fs.delete" | "delete" | "fsdelete" | "rm" => "fs.delete",
        "shell.exec" | "shell" | "exec" | "shellexec" => "shell.exec",
        "knowledge.search" | "knowledge" | "search" | "knowledgesearch" => "knowledge.search",
        _ => return None,
    };
    Some(canonical.to_string())
}

fn override_model_to_record(model: AgentPermissionOverride) -> Option<PermissionOverrideRecord> {
    let action = PermissionAction::from_str(&model.action)?;
    let metadata = model
        .metadata
        .as_ref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    Some(PermissionOverrideRecord {
        id: model.id,
        tool: model.tool,
        pattern: model.pattern,
        normalized_pattern: model.normalized_pattern,
        action,
        created_at: model.created_at,
        metadata,
    })
}

fn override_matches_tool(tool: &str, intent: FsIntent) -> bool {
    tool == "*" || tool == intent.canonical_tool()
}

fn override_matches_path(rule: &PermissionOverrideRecord, candidate: &Path) -> bool {
    if rule.normalized_pattern == "*" {
        return true;
    }
    ScopeMatcher::contains(Path::new(&rule.normalized_pattern), candidate)
}

fn derive_root_candidate(intent: FsIntent, resolved: &Path) -> Option<String> {
    match intent {
        FsIntent::Read => resolved
            .parent()
            .map(path_to_string)
            .or_else(|| Some(path_to_string(resolved))),
        FsIntent::List => Some(path_to_string(resolved)),
        FsIntent::Write | FsIntent::Delete => None,
    }
}

fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|err| format!("Could not resolve path '{}': {}", path.display(), err));
    }

    let mut remaining = Vec::<OsString>::new();
    let mut cursor = path.to_path_buf();
    while !cursor.exists() {
        let name = cursor.file_name().ok_or_else(|| {
            format!(
                "Could not resolve path '{}': no existing ancestor found",
                path.display()
            )
        })?;
        remaining.push(name.to_os_string());
        cursor = cursor
            .parent()
            .ok_or_else(|| {
                format!(
                    "Could not resolve path '{}': no existing ancestor found",
                    path.display()
                )
            })?
            .to_path_buf();
    }

    let mut canonical = cursor
        .canonicalize()
        .map_err(|err| format!("Could not resolve path '{}': {}", cursor.display(), err))?;
    for part in remaining.into_iter().rev() {
        canonical.push(part);
    }
    Ok(normalize_path_components(canonical))
}

fn normalize_path_components(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::RootDir | Component::Prefix(_) => {
                normalized.push(component.as_os_str());
            }
            Component::Normal(part) => {
                normalized.push(part);
            }
        }
    }
    normalized
}

fn default_workspace_root() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn components_equal(left: Component<'_>, right: Component<'_>) -> bool {
    #[cfg(windows)]
    {
        left.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        default_workspace_root, FsIntent, PathResolver, PermissionAction, PermissionEngine,
        PermissionOverrideRecord, ScopeMatcher,
    };
    use crate::models::AgentFsRoot;
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn scope_matcher_is_component_aware() {
        assert!(ScopeMatcher::contains(
            Path::new("/home/a"),
            Path::new("/home/a")
        ));
        assert!(ScopeMatcher::contains(
            Path::new("/home/a"),
            Path::new("/home/a/src/main.rs")
        ));
        assert!(!ScopeMatcher::contains(
            Path::new("/home/a"),
            Path::new("/home/ab/file.txt")
        ));
    }

    #[test]
    fn resolver_handles_relative_paths_with_workspace_root() {
        let workspace_root = default_workspace_root();
        let resolver = PathResolver::new(workspace_root.clone());
        let resolved = resolver
            .resolve_for_write("./src/../src")
            .expect("path should resolve");
        assert_eq!(resolved, workspace_root.join("src"));
    }

    #[test]
    fn resolver_supports_non_existent_write_target() {
        let temp_root = std::env::temp_dir().join(format!("llm-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root).expect("temp root should be created");
        let resolver = PathResolver::new(temp_root.clone());
        let resolved = resolver
            .resolve_for_write("nested/new/file.txt")
            .expect("write target should resolve");
        assert_eq!(resolved, temp_root.join("nested/new/file.txt"));
        fs::remove_dir_all(&temp_root).expect("temp root cleanup should succeed");
    }

    #[test]
    fn permission_matrix_enforces_scoped_defaults() {
        let temp_root = std::env::temp_dir().join(format!("llm-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root).expect("temp root should be created");
        let trusted_root = temp_root.join("trusted");
        fs::create_dir_all(&trusted_root).expect("trusted root should exist");
        let file_path = trusted_root.join("a.txt");
        fs::write(&file_path, "ok").expect("fixture file should be created");
        let outsider = temp_root.join("outside.txt");
        fs::write(&outsider, "nope").expect("outside fixture should be created");

        let engine = PermissionEngine {
            resolver: PathResolver::new(temp_root.clone()),
            trusted_roots: vec![AgentFsRoot {
                id: "root-1".to_string(),
                path: trusted_root.to_string_lossy().to_string(),
                normalized_path: trusted_root.to_string_lossy().to_string(),
                source: "test".to_string(),
                created_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            overrides: Vec::new(),
        };

        let read_inside = engine
            .evaluate_fs(FsIntent::Read, &file_path.to_string_lossy())
            .expect("inside read should evaluate");
        assert_eq!(read_inside.final_action, PermissionAction::Allow);

        let read_outside = engine
            .evaluate_fs(FsIntent::Read, &outsider.to_string_lossy())
            .expect("outside read should evaluate");
        assert_eq!(read_outside.final_action, PermissionAction::Ask);
        assert!(read_outside.context.outside_trusted_roots);

        let write_inside = engine
            .evaluate_fs(FsIntent::Write, &file_path.to_string_lossy())
            .expect("inside write should evaluate");
        assert_eq!(write_inside.final_action, PermissionAction::Ask);

        fs::remove_dir_all(&temp_root).expect("temp root cleanup should succeed");
    }

    #[test]
    fn overrides_can_allow_writes_narrowly() {
        let temp_root = std::env::temp_dir().join(format!("llm-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root).expect("temp root should be created");
        let target_file = temp_root.join("notes.md");
        fs::write(&target_file, "hello").expect("fixture file should be created");

        let engine = PermissionEngine {
            resolver: PathResolver::new(temp_root.clone()),
            trusted_roots: Vec::new(),
            overrides: vec![PermissionOverrideRecord {
                id: "ovr-1".to_string(),
                tool: "fs.write".to_string(),
                pattern: target_file.to_string_lossy().to_string(),
                normalized_pattern: target_file.to_string_lossy().to_string(),
                action: PermissionAction::Allow,
                created_at: "2026-01-01T00:00:00Z".to_string(),
                metadata: None,
            }],
        };

        let eval = engine
            .evaluate_fs(FsIntent::Write, &target_file.to_string_lossy())
            .expect("write evaluation should succeed");
        assert_eq!(eval.final_action, PermissionAction::Allow);

        fs::remove_dir_all(&temp_root).expect("temp root cleanup should succeed");
    }

    #[cfg(unix)]
    #[test]
    fn resolver_enforces_canonical_symlink_target() {
        use std::os::unix::fs::symlink;

        let temp_root = std::env::temp_dir().join(format!("llm-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp_root).expect("temp root should be created");
        let real_target = temp_root.join("real");
        fs::create_dir_all(&real_target).expect("real target should exist");

        let link = temp_root.join("link");
        symlink(&real_target, &link).expect("symlink should be created");
        let resolver = PathResolver::new(temp_root.clone());

        let resolved = resolver
            .resolve_existing("link")
            .expect("symlink should be canonicalized");
        assert_eq!(
            resolved,
            real_target.canonicalize().expect("real target exists")
        );

        fs::remove_dir_all(&temp_root).expect("temp root cleanup should succeed");
    }
}
