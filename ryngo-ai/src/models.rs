// RYNGO: Model manager — checks for Gemma 3n GGUF, downloads from HuggingFace if missing

use anyhow::{Context, Result};
use futures_util::StreamExt;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

/// Which Whisper model to use for speech-to-text
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhisperVariant {
    /// ggml-base.en.bin, ~150 MB — fastest, good for short commands
    BaseEn,
    /// ggml-small.en.bin, ~500 MB — recommended balance of speed and accuracy
    SmallEn,
}

impl WhisperVariant {
    pub fn filename(&self) -> &'static str {
        match self {
            WhisperVariant::BaseEn => "ggml-base.en.bin",
            WhisperVariant::SmallEn => "ggml-small.en.bin",
        }
    }

    pub fn download_url(&self) -> &'static str {
        match self {
            WhisperVariant::BaseEn => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
            WhisperVariant::SmallEn => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            WhisperVariant::BaseEn => "Whisper base.en (~150 MB)",
            WhisperVariant::SmallEn => "Whisper small.en (~500 MB)",
        }
    }
}

/// Which Gemma 3n variant to use
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GemmaVariant {
    /// ~4.2 GB Q4_K_M — better quality, needs 16GB RAM
    E4B,
    /// ~2.8 GB Q4_K_M — fits on 8GB machines
    E2B,
}

impl GemmaVariant {
    pub fn filename(&self) -> &'static str {
        match self {
            GemmaVariant::E4B => "google_gemma-3n-E4B-it-Q4_K_M.gguf",
            GemmaVariant::E2B => "google_gemma-3n-E2B-it-Q4_K_M.gguf",
        }
    }

    pub fn download_url(&self) -> &'static str {
        match self {
            GemmaVariant::E4B => "https://huggingface.co/bartowski/google_gemma-3n-E4B-it-GGUF/resolve/main/google_gemma-3n-E4B-it-Q4_K_M.gguf",
            GemmaVariant::E2B => "https://huggingface.co/bartowski/google_gemma-3n-E2B-it-GGUF/resolve/main/google_gemma-3n-E2B-it-Q4_K_M.gguf",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            GemmaVariant::E4B => "Gemma 3n E4B (Q4_K_M, ~4.2 GB)",
            GemmaVariant::E2B => "Gemma 3n E2B (Q4_K_M, ~2.8 GB)",
        }
    }
}

/// Returns the path to ~/.ryngo/models/
pub fn models_dir() -> Result<PathBuf> {
    let home = dirs_next::home_dir().context("cannot determine home directory")?;
    Ok(home.join(".ryngo").join("models"))
}

/// Returns the full path where a model file should live
pub fn model_path(variant: GemmaVariant) -> Result<PathBuf> {
    Ok(models_dir()?.join(variant.filename()))
}

/// Check if the model file exists and has nonzero size
pub fn is_model_downloaded(variant: GemmaVariant) -> Result<bool> {
    let path = model_path(variant)?;
    if path.exists() {
        let meta = std::fs::metadata(&path)?;
        Ok(meta.len() > 0)
    } else {
        Ok(false)
    }
}

/// Progress callback: (bytes_downloaded, total_bytes_option)
pub type ProgressCallback = Box<dyn Fn(u64, Option<u64>) + Send>;

/// Download the model from HuggingFace to ~/.ryngo/models/
/// Calls `on_progress` periodically with (downloaded, total) byte counts.
pub async fn download_model(
    variant: GemmaVariant,
    on_progress: Option<ProgressCallback>,
) -> Result<PathBuf> {
    let dest = model_path(variant)?;

    // Create the directory if needed
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.with_context(|| {
            format!("failed to create models directory: {}", parent.display())
        })?;
    }

    let url = variant.download_url();
    log::info!(
        "Downloading {} from {}",
        variant.display_name(),
        url
    );

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to start download from {}", url))?;

    if !response.status().is_success() {
        anyhow::bail!(
            "download failed with HTTP {}: {}",
            response.status(),
            url
        );
    }

    let total_size = response.content_length();
    if let Some(total) = total_size {
        log::info!(
            "Model size: {:.1} GB",
            total as f64 / (1024.0 * 1024.0 * 1024.0)
        );
    }

    // Write to a temp file first, then rename (atomic-ish)
    let tmp_dest = dest.with_extension("gguf.part");
    let mut file = tokio::fs::File::create(&tmp_dest)
        .await
        .with_context(|| format!("failed to create {}", tmp_dest.display()))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("error reading download stream")?;
        file.write_all(&chunk)
            .await
            .context("error writing model file")?;
        downloaded += chunk.len() as u64;

        if let Some(ref cb) = on_progress {
            cb(downloaded, total_size);
        }
    }

    file.flush().await?;
    drop(file);

    // Rename .part → .gguf
    tokio::fs::rename(&tmp_dest, &dest)
        .await
        .with_context(|| {
            format!(
                "failed to rename {} → {}",
                tmp_dest.display(),
                dest.display()
            )
        })?;

    log::info!(
        "Download complete: {} ({:.1} GB)",
        dest.display(),
        downloaded as f64 / (1024.0 * 1024.0 * 1024.0)
    );

    Ok(dest)
}

/// Ensure the model is available. Downloads if not present.
/// Returns the path to the GGUF file.
pub async fn ensure_model(
    variant: GemmaVariant,
    on_progress: Option<ProgressCallback>,
) -> Result<PathBuf> {
    if is_model_downloaded(variant)? {
        let path = model_path(variant)?;
        log::info!("Model already downloaded: {}", path.display());
        return Ok(path);
    }

    log::info!(
        "Model not found locally, downloading {}...",
        variant.display_name()
    );
    download_model(variant, on_progress).await
}

// ---------------------------------------------------------------------------
// RYNGO: Whisper model download helpers
// ---------------------------------------------------------------------------

/// Returns the full path where a Whisper model file should live
pub fn whisper_model_path(variant: WhisperVariant) -> Result<PathBuf> {
    Ok(models_dir()?.join(variant.filename()))
}

/// Check if the Whisper model file exists and has nonzero size
pub fn is_whisper_downloaded(variant: WhisperVariant) -> Result<bool> {
    let path = whisper_model_path(variant)?;
    if path.exists() {
        let meta = std::fs::metadata(&path)?;
        Ok(meta.len() > 0)
    } else {
        Ok(false)
    }
}

/// Download a Whisper model from HuggingFace to ~/.ryngo/models/
pub async fn download_whisper_model(
    variant: WhisperVariant,
    on_progress: Option<ProgressCallback>,
) -> Result<PathBuf> {
    let dest = whisper_model_path(variant)?;

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.with_context(|| {
            format!("failed to create models directory: {}", parent.display())
        })?;
    }

    let url = variant.download_url();
    log::info!("Downloading {} from {}", variant.display_name(), url);

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("failed to start download from {}", url))?;

    if !response.status().is_success() {
        anyhow::bail!(
            "download failed with HTTP {}: {}",
            response.status(),
            url
        );
    }

    let total_size = response.content_length();
    if let Some(total) = total_size {
        log::info!(
            "Whisper model size: {:.0} MB",
            total as f64 / (1024.0 * 1024.0)
        );
    }

    let tmp_dest = dest.with_extension("bin.part");
    let mut file = tokio::fs::File::create(&tmp_dest)
        .await
        .with_context(|| format!("failed to create {}", tmp_dest.display()))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("error reading download stream")?;
        file.write_all(&chunk)
            .await
            .context("error writing model file")?;
        downloaded += chunk.len() as u64;

        if let Some(ref cb) = on_progress {
            cb(downloaded, total_size);
        }
    }

    file.flush().await?;
    drop(file);

    tokio::fs::rename(&tmp_dest, &dest)
        .await
        .with_context(|| {
            format!(
                "failed to rename {} → {}",
                tmp_dest.display(),
                dest.display()
            )
        })?;

    log::info!(
        "Whisper download complete: {} ({:.0} MB)",
        dest.display(),
        downloaded as f64 / (1024.0 * 1024.0)
    );

    Ok(dest)
}

/// Ensure the Whisper model is available. Downloads if not present.
pub async fn ensure_whisper_model(
    variant: WhisperVariant,
    on_progress: Option<ProgressCallback>,
) -> Result<PathBuf> {
    if is_whisper_downloaded(variant)? {
        let path = whisper_model_path(variant)?;
        log::info!("Whisper model already downloaded: {}", path.display());
        return Ok(path);
    }

    log::info!(
        "Whisper model not found locally, downloading {}...",
        variant.display_name()
    );
    download_whisper_model(variant, on_progress).await
}
