// RYNGO: AI subsystem — embedded LLM via llama.cpp
//
// This crate provides:
// - Model manager: download Gemma 3n GGUF from HuggingFace to ~/.ryngo/models/
// - LLM inference: load model, generate text, summarize, chat
//
// All inference runs on background threads, never blocking the GUI.

pub mod agent_prompt;
pub mod llm;
pub mod models;
pub mod stt;
pub mod tools;

pub use llm::{Llm, LlmConfig, LlmHandle};
pub use models::{GemmaVariant, ensure_model, is_model_downloaded, model_path, models_dir};
pub use models::{WhisperVariant, ensure_whisper_model, is_whisper_downloaded, whisper_model_path};
pub use stt::{SttEngine, SttHandle};

/// Ensure the model is downloaded (blocking wrapper).
/// Creates its own tokio runtime. Safe to call from any background thread.
/// Returns the path to the GGUF file on disk.
pub fn ensure_model_blocking(variant: GemmaVariant) -> anyhow::Result<std::path::PathBuf> {
    let rt = tokio::runtime::Runtime::new()
        .map_err(|e| anyhow::anyhow!("failed to create tokio runtime for model download: {}", e))?;
    rt.block_on(ensure_model(variant, Some(Box::new(|downloaded, total| {
        if let Some(total) = total {
            let pct = (downloaded as f64 / total as f64) * 100.0;
            let downloaded_mb = downloaded as f64 / (1024.0 * 1024.0);
            let total_mb = total as f64 / (1024.0 * 1024.0);
            log::info!(
                "Downloading Gemma 3n: {:.0} MB / {:.0} MB ({:.1}%)",
                downloaded_mb, total_mb, pct,
            );
        } else {
            let downloaded_mb = downloaded as f64 / (1024.0 * 1024.0);
            log::info!("Downloading Gemma 3n: {:.0} MB", downloaded_mb);
        }
    }))))
}

/// Initialize the AI subsystem: ensure model is downloaded, then load it.
/// Designed to be called from a background async task at startup.
///
/// Returns an LlmHandle that can be shared across the application.
pub async fn init(variant: GemmaVariant) -> anyhow::Result<LlmHandle> {
    let handle = LlmHandle::new();

    // Ensure the model is downloaded
    let model_path = ensure_model(variant, Some(Box::new(|downloaded, total| {
        if let Some(total) = total {
            let pct = (downloaded as f64 / total as f64) * 100.0;
            let downloaded_mb = downloaded as f64 / (1024.0 * 1024.0);
            let total_mb = total as f64 / (1024.0 * 1024.0);
            log::info!(
                "Downloading model: {:.0} MB / {:.0} MB ({:.1}%)",
                downloaded_mb,
                total_mb,
                pct,
            );
        } else {
            let downloaded_mb = downloaded as f64 / (1024.0 * 1024.0);
            log::info!("Downloading model: {:.0} MB", downloaded_mb);
        }
    })))
    .await?;

    // Load the model on a blocking thread (this takes a few seconds)
    log::info!("Loading Gemma 3n into GPU memory...");
    let config = LlmConfig::default();
    let path = model_path.clone();

    let llm = tokio::task::spawn_blocking(move || Llm::load(&path, config))
        .await
        .map_err(|e| anyhow::anyhow!("model loading task panicked: {}", e))??;

    handle.set(llm).await;
    log::info!("Gemma 3n is ready for inference");

    Ok(handle)
}
