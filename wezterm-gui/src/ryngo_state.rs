// RYNGO: Global AI state shared between the model-check thread and the GUI rendering thread.
// The GUI reads this to populate the bottom status bar with mic status, model state, and context %.

use lazy_static::lazy_static;
use std::sync::Mutex;
use std::time::Instant;

lazy_static! {
    pub static ref RYNGO_STATE: Mutex<RyngoState> = Mutex::new(RyngoState::default());
    // RYNGO: Global LLM handle for Gemma 3n inference. Separate from RYNGO_STATE because
    // LlmHandle uses a tokio async Mutex internally, while RYNGO_STATE uses std sync Mutex
    // for fast GUI reads.
    pub static ref LLM_HANDLE: ryngo_ai::LlmHandle = ryngo_ai::LlmHandle::new();
    // RYNGO: Global STT handle for Whisper speech-to-text. Uses std sync Mutex internally
    // since audio callbacks and key handlers are synchronous.
    pub static ref STT_HANDLE: ryngo_ai::SttHandle = ryngo_ai::SttHandle::new();
}

pub struct RyngoState {
    /// Whether the microphone is currently recording (push-to-talk active)
    pub mic_active: bool,
    /// Whether the Gemma 3n model file exists on disk (downloaded or verified)
    pub model_loaded: bool,
    /// Whether a model download is currently in progress
    pub model_downloading: bool,
    /// Whether the model is currently being loaded into GPU memory (after download)
    pub model_loading: bool,
    /// Whether the model passed the health check and is ready for inference
    pub model_healthy: bool,
    /// Download progress percentage (0-100)
    pub download_pct: u8,
    /// Bytes downloaded so far
    pub download_bytes: u64,
    /// Total bytes to download (if known)
    pub download_total_bytes: Option<u64>,
    /// When the download started (for ETA calculation)
    pub download_started: Option<Instant>,
    /// Number of context tokens currently used
    pub context_used: u32,
    /// Total context window size (e.g. 4096 for Gemma 3n)
    pub context_total: u32,
    /// Whether LLM chat mode is active (toggled via Shift+Cmd+L)
    pub llm_mode_active: bool,
}

impl Default for RyngoState {
    fn default() -> Self {
        Self {
            mic_active: false,
            model_loaded: false,
            model_downloading: false,
            model_loading: false,
            model_healthy: false,
            download_pct: 0,
            download_bytes: 0,
            download_total_bytes: None,
            download_started: None,
            context_used: 0,
            context_total: 0,
            llm_mode_active: false,
        }
    }
}

impl RyngoState {
    /// Calculate estimated time remaining for the download in seconds.
    /// Returns None if not enough data to estimate.
    pub fn download_eta_secs(&self) -> Option<u64> {
        let started = self.download_started?;
        let total = self.download_total_bytes?;
        if self.download_bytes == 0 || total == 0 {
            return None;
        }
        let elapsed = started.elapsed().as_secs_f64();
        if elapsed < 1.0 {
            return None;
        }
        let bytes_per_sec = self.download_bytes as f64 / elapsed;
        if bytes_per_sec < 1.0 {
            return None;
        }
        let remaining_bytes = total.saturating_sub(self.download_bytes);
        Some((remaining_bytes as f64 / bytes_per_sec) as u64)
    }

    /// Format the ETA as a human-readable string like "2m 30s" or "45s"
    pub fn download_eta_string(&self) -> String {
        match self.download_eta_secs() {
            Some(secs) if secs >= 3600 => {
                format!("{}h {}m", secs / 3600, (secs % 3600) / 60)
            }
            Some(secs) if secs >= 60 => {
                format!("{}m {}s", secs / 60, secs % 60)
            }
            Some(secs) => format!("{}s", secs),
            None => "calculating...".to_string(),
        }
    }
}
