use crate::error::AppError;
use crate::storage::{self, AppState};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::State;

/// Arguments forwarded from the frontend settings to llama-server CLI.
#[derive(Debug, Deserialize, Clone)]
pub struct LlamaServerArgs {
    pub executable_path: String,
    pub port: u16,
    pub context_size: u32,
    pub gpu_layers: i32,
    pub threads: u32,
    pub batch_size: u32,
}

pub struct ModelState {
    pub process: Mutex<Option<RunningModelProcess>>,
    pub models_dir: std::path::PathBuf,
    pub next_run_id: AtomicU64,
}

pub struct RunningModelProcess {
    pub child: Child,
    pub run_id: u64,
    pub command_line: String,
    pub model_name: String,
    pub port: u16,
}

impl ModelState {
    pub fn new(models_dir: std::path::PathBuf) -> Self {
        Self {
            process: Mutex::new(None),
            models_dir,
            next_run_id: AtomicU64::new(1),
        }
    }
}

/// Scans the configured models directory for .gguf files
fn scan_local_models(models_dir: &std::path::Path) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(models_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.eq_ignore_ascii_case("gguf") {
                        if let Some(name) = path.file_name() {
                            found.push(name.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    found.sort();
    found
}

fn resolve_model_path(models_dir: &Path, model_name: &str) -> PathBuf {
    let path = Path::new(model_name);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        models_dir.join(path)
    }
}

fn quote_cmd_arg(arg: &str) -> String {
    if arg
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '+'))
    {
        return arg.to_string();
    }

    let escaped = arg.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn build_llama_server_command_line(
    executable_path: &str,
    model_path: &Path,
    port: u16,
    context_size: u32,
    gpu_layers: i32,
    threads: u32,
    batch_size: u32,
) -> String {
    [
        quote_cmd_arg(executable_path),
        "-m".to_string(),
        quote_cmd_arg(&model_path.display().to_string()),
        "--port".to_string(),
        port.to_string(),
        "-c".to_string(),
        context_size.to_string(),
        "-ngl".to_string(),
        gpu_layers.to_string(),
        "-t".to_string(),
        threads.to_string(),
        "-b".to_string(),
        batch_size.to_string(),
    ]
    .join(" ")
}

fn clip_for_log(value: &str, max_chars: usize) -> String {
    if value.len() <= max_chars {
        return value.to_string();
    }
    let mut out = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

fn probe_llama_devices(executable_path: &str) -> Result<String, AppError> {
    let output = Command::new(executable_path)
        .arg("--list-devices")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| {
            AppError::Inference(format!(
                "Failed to execute '{}' --list-devices: {}",
                executable_path, err
            ))
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = if stderr.trim().is_empty() {
        stdout.to_string()
    } else if stdout.trim().is_empty() {
        stderr.to_string()
    } else {
        format!("{}\n{}", stderr.trim_end(), stdout)
    };

    if output.status.success() {
        Ok(combined)
    } else {
        Err(AppError::Inference(format!(
            "'{} --list-devices' failed with status {}. Output: {}",
            executable_path,
            output.status,
            clip_for_log(combined.trim(), 600),
        )))
    }
}

fn is_run_superseded(state: &ModelState, run_id: u64) -> bool {
    let Ok(lock) = state.process.lock() else {
        return true;
    };
    match lock.as_ref() {
        Some(running) => running.run_id != run_id,
        None => true,
    }
}

fn kill_child_process(child: &mut Child, reason: &str) {
    match child.kill() {
        Ok(()) => {}
        Err(err) => {
            tracing::warn!(error = %err, reason, "Failed to send kill signal to llama-server child process");
        }
    }
    match child.wait() {
        Ok(status) => {
            tracing::info!(exit_status = %status, reason, "llama-server child process exited");
        }
        Err(err) => {
            tracing::warn!(error = %err, reason, "Failed while waiting for llama-server child exit");
        }
    }
}

fn stop_active_run_if_matches(state: &ModelState, run_id: u64, reason: &str) {
    let Ok(mut guard) = state.process.lock() else {
        return;
    };
    let Some(mut running) = guard.take() else {
        return;
    };
    if running.run_id != run_id {
        *guard = Some(running);
        return;
    }
    tracing::info!(
        run_id = running.run_id,
        model_name = %running.model_name,
        port = running.port,
        command = %running.command_line,
        reason,
        "Stopping active llama-server run"
    );
    kill_child_process(&mut running.child, reason);
}

#[cfg(unix)]
fn maybe_extract_port_arg(args_text: &str) -> Option<u16> {
    if let Some(eq_idx) = args_text.find("--port=") {
        let tail = &args_text[(eq_idx + "--port=".len())..];
        let token = tail.split_whitespace().next()?;
        return token.parse::<u16>().ok();
    }

    let needle = "--port ";
    let idx = args_text.find(needle)?;
    let tail = &args_text[(idx + needle.len())..];
    let token = tail.split_whitespace().next()?;
    token.parse::<u16>().ok()
}

#[cfg(unix)]
fn extract_executable_hint(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return "llama-server".to_string();
    }
    Path::new(trimmed)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

#[cfg(unix)]
fn cleanup_stale_llama_processes(executable_path: &str, port: u16, protected_pid: Option<u32>) {
    let exec_hint = extract_executable_hint(executable_path);
    let ps_output = match Command::new("ps").args(["-eo", "pid=,args="]).output() {
        Ok(output) => output,
        Err(err) => {
            tracing::warn!(error = %err, "Unable to inspect process table for stale llama-server processes");
            return;
        }
    };
    let listing = String::from_utf8_lossy(&ps_output.stdout);
    let mut stale_pids: Vec<u32> = Vec::new();

    for line in listing.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let Some(pid_token) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_token.parse::<u32>() else {
            continue;
        };
        if protected_pid == Some(pid) {
            continue;
        }

        let args_text = parts.collect::<Vec<_>>().join(" ");
        if args_text.is_empty() {
            continue;
        }
        if !args_text.contains("llama-server") {
            continue;
        }
        if !args_text.contains(&exec_hint) && !args_text.contains(executable_path) {
            continue;
        }
        if maybe_extract_port_arg(&args_text) != Some(port) {
            continue;
        }

        stale_pids.push(pid);
    }

    stale_pids.sort_unstable();
    stale_pids.dedup();

    for pid in stale_pids {
        tracing::warn!(
            pid,
            port,
            executable_path = %executable_path,
            "Found stale llama-server process. Killing to enforce unique run."
        );
        match Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
        {
            Ok(status) => {
                tracing::info!(pid, status = %status, "Issued kill -KILL for stale llama-server process");
            }
            Err(err) => {
                tracing::warn!(pid, error = %err, "Failed to kill stale llama-server process");
            }
        }
    }
}

#[cfg(not(unix))]
fn cleanup_stale_llama_processes(_executable_path: &str, _port: u16, _protected_pid: Option<u32>) {}

#[tauri::command]
pub async fn list_models(
    model_state: State<'_, ModelState>,
    app_state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    // 1. Scan local models/ directory
    let local = scan_local_models(&model_state.models_dir);

    // 2. Query registered (browsed) models from DB
    let registered = storage::list_registered_models(&app_state.db).await?;

    // 3. Merge + deduplicate using a HashSet for O(1) lookups (was O(n²) with Vec::contains)
    let mut seen: std::collections::HashSet<String> = local.iter().cloned().collect();
    let mut all = local;
    for path in registered {
        if seen.insert(path.clone()) {
            all.push(path);
        }
    }

    Ok(all)
}

#[tauri::command]
pub async fn register_model(path: String, app_state: State<'_, AppState>) -> Result<(), AppError> {
    let display_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());

    let id = uuid::Uuid::new_v4().to_string();
    storage::register_model(&app_state.db, &id, &path, &display_name).await?;
    tracing::info!("Registered model: {} ({})", display_name, path);
    Ok(())
}

#[tauri::command]
pub async fn remove_model(path: String, app_state: State<'_, AppState>) -> Result<(), AppError> {
    if !Path::new(&path).is_absolute() {
        return Err(AppError::Inference(
            "Only registered external model paths can be removed.".to_string(),
        ));
    }
    storage::remove_registered_model(&app_state.db, &path).await?;
    tracing::info!("Removed registered model: {}", path);
    Ok(())
}

#[tauri::command]
pub async fn load_model(
    model_name: String,
    args: Option<LlamaServerArgs>,
    state: State<'_, ModelState>,
) -> Result<(), AppError> {
    let hardware_threads = std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(4)
        .max(1);

    // Resolve effective server args with sensible defaults
    let effective_executable_path = args
        .as_ref()
        .map_or("llama-server".to_string(), |a| a.executable_path.clone());
    let effective_port = args.as_ref().map_or(8080u16, |a| a.port);
    let effective_ctx = args
        .as_ref()
        .map_or(2048u32, |a| a.context_size)
        .clamp(512, 32768);
    let effective_ngl = args.as_ref().map_or(0i32, |a| a.gpu_layers.max(-1));
    let requested_threads = args.as_ref().map_or(4u32, |a| a.threads).max(1);
    let effective_threads = requested_threads.min(hardware_threads);
    let requested_batch = args.as_ref().map_or(512u32, |a| a.batch_size).max(32);
    let effective_batch = requested_batch.min(effective_ctx);
    let requested_ctx = args.as_ref().map_or(2048u32, |a| a.context_size);
    let requested_ngl = args.as_ref().map_or(0i32, |a| a.gpu_layers);

    if effective_ngl > 0 {
        let probe_output = probe_llama_devices(&effective_executable_path)?;
        let probe_lower = probe_output.to_ascii_lowercase();
        let has_cuda_error = probe_lower.contains("failed to initialize cuda");
        let has_gpu_device = ["cuda", "vulkan", "metal", "hip", "sycl"]
            .iter()
            .any(|needle| probe_lower.contains(needle));

        tracing::warn!(
            executable_path = %effective_executable_path,
            requested_gpu_layers = requested_ngl,
            effective_gpu_layers = effective_ngl,
            probe_output = %clip_for_log(probe_output.trim(), 1200),
            "LLAMA_DEVICE_PROBE"
        );

        if has_cuda_error {
            return Err(AppError::Inference(format!(
                "GPU offload requested (gpu_layers={}) but llama-server failed to initialize CUDA. Run '{} --list-devices' and fix CUDA runtime/driver visibility first.",
                effective_ngl, effective_executable_path
            )));
        }

        if !has_gpu_device {
            return Err(AppError::Inference(format!(
                "GPU offload requested (gpu_layers={}) but llama-server did not report any GPU device in '--list-devices'. Output: {}",
                effective_ngl,
                clip_for_log(probe_output.trim(), 400),
            )));
        }
    }

    tracing::info!(
        "Loading model: {} (port={}, ctx={}, ngl={}, threads={}, batch={})",
        model_name,
        effective_port,
        effective_ctx,
        effective_ngl,
        effective_threads,
        effective_batch
    );
    tracing::info!(
        requested_threads,
        hardware_threads,
        requested_batch,
        "Applied llama runtime argument sanitization"
    );

    let model_path = resolve_model_path(&state.models_dir, &model_name);
    if !model_path.exists() {
        return Err(AppError::NotFound(format!(
            "Model file not found at {}",
            model_path.display()
        )));
    }

    let command_line = build_llama_server_command_line(
        &effective_executable_path,
        &model_path,
        effective_port,
        effective_ctx,
        effective_ngl,
        effective_threads,
        effective_batch,
    );
    let run_id = state.next_run_id.fetch_add(1, Ordering::Relaxed);

    if let Some(raw) = args.as_ref() {
        tracing::info!(
            run_id,
            requested_executable_path = %raw.executable_path,
            requested_port = raw.port,
            requested_context_size = raw.context_size,
            requested_gpu_layers = raw.gpu_layers,
            requested_threads = raw.threads,
            requested_batch_size = raw.batch_size,
            "Requested llama-server args from frontend"
        );
    } else {
        tracing::info!(
            run_id,
            "No explicit llama-server args provided by frontend. Using defaults."
        );
    }

    tracing::info!(
        run_id,
        model_name = %model_name,
        executable_path = %effective_executable_path,
        model_path = %model_path.display(),
        port = effective_port,
        context_size = effective_ctx,
        gpu_layers = effective_ngl,
        threads = effective_threads,
        batch_size = effective_batch,
        command = %command_line,
        "Effective llama-server launch parameters"
    );
    tracing::warn!(
        run_id,
        model_name = %model_name,
        requested_executable_path = %args
            .as_ref()
            .map_or("llama-server", |raw| raw.executable_path.as_str()),
        requested_port = args.as_ref().map_or(8080u16, |raw| raw.port),
        requested_context_size = requested_ctx,
        requested_gpu_layers = requested_ngl,
        requested_threads,
        requested_batch_size = requested_batch,
        effective_executable_path = %effective_executable_path,
        effective_port = effective_port,
        effective_context_size = effective_ctx,
        effective_gpu_layers = effective_ngl,
        effective_threads,
        effective_batch_size = effective_batch,
        command = %command_line,
        "LLAMA_SPAWN_ARGS"
    );
    if requested_ctx != effective_ctx
        || requested_ngl != effective_ngl
        || requested_threads != effective_threads
        || requested_batch != effective_batch
    {
        tracing::warn!(
            run_id,
            requested_context_size = requested_ctx,
            effective_context_size = effective_ctx,
            requested_gpu_layers = requested_ngl,
            effective_gpu_layers = effective_ngl,
            requested_threads,
            effective_threads,
            requested_batch_size = requested_batch,
            effective_batch_size = effective_batch,
            hardware_threads,
            "LLAMA_SPAWN_ARGS_SANITIZED"
        );
    }

    {
        let mut process_guard = state.process.lock().unwrap();

        // Kill existing proc if any
        if let Some(mut running) = process_guard.take() {
            tracing::info!(
                previous_run_id = running.run_id,
                previous_model = %running.model_name,
                previous_port = running.port,
                previous_command = %running.command_line,
                "Killing existing model process before loading a new one"
            );
            kill_child_process(&mut running.child, "replace-active-run");
        }
        drop(process_guard);
        cleanup_stale_llama_processes(&effective_executable_path, effective_port, None);

        let child = std::process::Command::new(&effective_executable_path)
            .arg("-m")
            .arg(&model_path)
            .arg("--port")
            .arg(effective_port.to_string())
            .arg("-c")
            .arg(effective_ctx.to_string())
            .arg("-ngl")
            .arg(effective_ngl.to_string())
            .arg("-t")
            .arg(effective_threads.to_string())
            .arg("-b")
            .arg(effective_batch.to_string())
            // Keep llama-server output out of the app terminal to avoid noisy CLI logs.
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                AppError::Inference(format!(
                    "Failed to spawn {}: {}",
                    effective_executable_path, e
                ))
            })?;
        let pid = child.id();

        tracing::info!(
            run_id,
            pid,
            model_name = %model_name,
            port = effective_port,
            command = %command_line,
            "Spawned llama-server process"
        );

        let mut process_guard = state.process.lock().unwrap();
        *process_guard = Some(RunningModelProcess {
            child,
            run_id,
            command_line: command_line.clone(),
            model_name: model_name.clone(),
            port: effective_port,
        });
    }

    // Wait for the model server to become healthy
    let health_url = format!("http://127.0.0.1:{}/health", effective_port);
    let client = reqwest::Client::new();
    let mut retries = 0;

    loop {
        if is_run_superseded(&state, run_id) {
            tracing::info!(
                run_id,
                model_name = %model_name,
                "Load request was superseded by a newer model run"
            );
            return Ok(());
        }

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        retries += 1;

        // Wait up to 60 seconds (120 retries)
        if retries > 120 {
            stop_active_run_if_matches(&state, run_id, "health-timeout");
            return Err(AppError::Inference(format!(
                "Model server took too long to start (run_id={}, command={})",
                run_id, command_line
            )));
        }

        match client.get(&health_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!(
                    run_id,
                    model_name = %model_name,
                    port = effective_port,
                    "Server is healthy and ready"
                );
                break;
            }
            _ => {
                // If it's failing to connect, check if the process died
                let mut is_dead = false;
                if let Ok(mut lock) = state.process.lock() {
                    if let Some(running) = lock.as_mut() {
                        if running.run_id == run_id {
                            if let Ok(Some(status)) = running.child.try_wait() {
                                tracing::error!(
                                    run_id,
                                    model_name = %running.model_name,
                                    command = %running.command_line,
                                    "Server process exited unexpectedly: {}",
                                    status
                                );
                                is_dead = true;
                            }
                        } else {
                            return Ok(());
                        }
                    } else {
                        return Ok(());
                    }
                } else {
                    return Ok(());
                }
                if is_dead {
                    stop_active_run_if_matches(&state, run_id, "child-exited-during-health-check");
                    return Err(AppError::Inference(
                        "Model server process exited unexpectedly".to_string(),
                    ));
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{build_llama_server_command_line, resolve_model_path};
    use std::path::Path;

    #[test]
    fn resolve_model_path_joins_relative_name_to_models_dir() {
        let models_dir = Path::new("/tmp/models");
        let resolved = resolve_model_path(models_dir, "tiny.gguf");
        assert_eq!(resolved, models_dir.join("tiny.gguf"));
    }

    #[test]
    fn resolve_model_path_keeps_absolute_path() {
        let models_dir = Path::new("/tmp/models");
        #[cfg(unix)]
        let absolute = "/opt/models/tiny.gguf";
        #[cfg(windows)]
        let absolute = r"C:\models\tiny.gguf";
        let resolved = resolve_model_path(models_dir, absolute);
        assert_eq!(resolved, Path::new(absolute));
    }

    #[test]
    fn command_line_contains_all_runtime_args() {
        let command = build_llama_server_command_line(
            "llama-server",
            Path::new("/tmp/models/alpha.gguf"),
            8080,
            4096,
            99,
            8,
            512,
        );
        assert!(command.contains("llama-server"));
        assert!(command.contains("-m /tmp/models/alpha.gguf"));
        assert!(command.contains("--port 8080"));
        assert!(command.contains("-c 4096"));
        assert!(command.contains("-ngl 99"));
        assert!(command.contains("-t 8"));
        assert!(command.contains("-b 512"));
    }
}

#[tauri::command]
pub async fn unload_model(state: State<'_, ModelState>) -> Result<(), AppError> {
    tracing::info!("Unloading model");

    let mut process_guard = state.process.lock().unwrap();
    if let Some(mut running) = process_guard.take() {
        tracing::info!(
            run_id = running.run_id,
            model_name = %running.model_name,
            port = running.port,
            command = %running.command_line,
            "Killing running model process"
        );
        kill_child_process(&mut running.child, "manual-unload");
    }

    Ok(())
}
