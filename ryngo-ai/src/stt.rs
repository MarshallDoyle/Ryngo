// RYNGO: Speech-to-text engine — audio capture via cpal + transcription via whisper-rs.
//
// SttEngine holds the Whisper model context and handles audio capture from the
// default microphone. SttHandle is a thread-safe wrapper (same pattern as LlmHandle)
// that can be stored as a global static.

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Core STT engine: owns the Whisper model and manages audio capture.
pub struct SttEngine {
    whisper_ctx: WhisperContext,
    device: cpal::Device,
    stream_config: cpal::StreamConfig,
    recording: Arc<AtomicBool>,
    audio_buffer: Arc<Mutex<Vec<f32>>>,
    stream: Mutex<Option<cpal::Stream>>,
    input_sample_rate: u32,
    input_channels: u16,
}

// SAFETY: cpal::Stream is Send but not Sync. We protect it behind a Mutex and
// only access it from one thread at a time (start_recording / stop_and_transcribe).
unsafe impl Send for SttEngine {}
unsafe impl Sync for SttEngine {}

impl SttEngine {
    /// Create a new STT engine by loading a Whisper GGML model file.
    /// Also probes the default audio input device for its native sample rate.
    pub fn new(model_path: &Path) -> Result<Self> {
        // Load Whisper model (Metal-accelerated on macOS via whisper.cpp)
        let whisper_ctx = WhisperContext::new_with_params(
            model_path
                .to_str()
                .context("model path is not valid UTF-8")?,
            WhisperContextParameters::default(),
        )
        .map_err(|e| anyhow::anyhow!("failed to load Whisper model: {}", e))?;

        // Get default audio input device
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .context("no default audio input device found")?;

        let supported = device
            .default_input_config()
            .context("failed to get default input config")?;

        let input_sample_rate = supported.sample_rate().0;
        let input_channels = supported.channels();

        log::info!(
            "STT audio device: {:?} ({}Hz, {} channels)",
            device.name().unwrap_or_default(),
            input_sample_rate,
            input_channels,
        );

        let stream_config = cpal::StreamConfig {
            channels: input_channels,
            sample_rate: cpal::SampleRate(input_sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        Ok(Self {
            whisper_ctx,
            device,
            stream_config,
            recording: Arc::new(AtomicBool::new(false)),
            audio_buffer: Arc::new(Mutex::new(Vec::new())),
            stream: Mutex::new(None),
            input_sample_rate,
            input_channels,
        })
    }

    /// Start recording audio from the microphone.
    /// Clears any previous audio data and begins accumulating f32 samples.
    pub fn start_recording(&self) {
        // Clear previous audio
        if let Ok(mut buf) = self.audio_buffer.lock() {
            buf.clear();
        }

        self.recording.store(true, Ordering::SeqCst);

        let buffer = Arc::clone(&self.audio_buffer);
        let recording = Arc::clone(&self.recording);

        let stream = self.device.build_input_stream(
            &self.stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if recording.load(Ordering::SeqCst) {
                    if let Ok(mut buf) = buffer.lock() {
                        buf.extend_from_slice(data);
                    }
                }
            },
            move |err| {
                log::error!("STT audio input stream error: {}", err);
            },
            None, // no timeout
        );

        match stream {
            Ok(s) => {
                if let Err(e) = s.play() {
                    log::error!("Failed to start audio stream: {}", e);
                    return;
                }
                if let Ok(mut slot) = self.stream.lock() {
                    *slot = Some(s);
                }
                log::info!("STT: recording started");
            }
            Err(e) => {
                log::error!("Failed to build audio input stream: {}", e);
                self.recording.store(false, Ordering::SeqCst);
            }
        }
    }

    /// Stop recording and transcribe the captured audio.
    /// Returns the transcribed text, or an error if transcription fails.
    pub fn stop_and_transcribe(&self) -> Result<String> {
        // Stop recording
        self.recording.store(false, Ordering::SeqCst);

        // Drop the stream to stop capture
        if let Ok(mut slot) = self.stream.lock() {
            *slot = None;
        }

        // Drain the audio buffer
        let raw_audio = {
            let mut buf = self
                .audio_buffer
                .lock()
                .map_err(|_| anyhow::anyhow!("audio buffer mutex poisoned"))?;
            std::mem::take(&mut *buf)
        };

        if raw_audio.is_empty() {
            return Ok(String::new());
        }

        log::info!(
            "STT: captured {} samples ({:.1}s at {}Hz)",
            raw_audio.len(),
            raw_audio.len() as f64 / (self.input_sample_rate as f64 * self.input_channels as f64),
            self.input_sample_rate,
        );

        // Convert to mono if needed
        let mono = if self.input_channels > 1 {
            stereo_to_mono(&raw_audio, self.input_channels)
        } else {
            raw_audio
        };

        // Resample to 16kHz (Whisper's required sample rate)
        let audio_16k = if self.input_sample_rate != 16000 {
            resample_linear(&mono, self.input_sample_rate, 16000)
        } else {
            mono
        };

        log::info!(
            "STT: resampled to {} samples ({:.1}s at 16kHz)",
            audio_16k.len(),
            audio_16k.len() as f64 / 16000.0,
        );

        // Transcribe with Whisper
        let mut state = self
            .whisper_ctx
            .create_state()
            .map_err(|e| anyhow::anyhow!("failed to create Whisper state: {}", e))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

        // Configure for low-latency command transcription
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_single_segment(true);
        params.set_no_context(true);

        state
            .full(params, &audio_16k)
            .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {}", e))?;

        // Collect all segments into a single string
        let num_segments = state
            .full_n_segments()
            .map_err(|e| anyhow::anyhow!("failed to get segment count: {}", e))?;

        let mut result = String::new();
        for i in 0..num_segments {
            if let Ok(text) = state.full_get_segment_text(i) {
                result.push_str(&text);
            }
        }

        let trimmed = result.trim().to_string();
        log::info!("STT transcription: {:?}", trimmed);

        Ok(trimmed)
    }
}

/// Thread-safe handle for the STT engine (same pattern as LlmHandle).
/// Wraps an Option<SttEngine> behind a std::sync::Mutex so it can be
/// stored as a global static and accessed from key handlers.
pub struct SttHandle {
    inner: Arc<Mutex<Option<SttEngine>>>,
}

impl SttHandle {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// Store a loaded SttEngine. Called once during startup.
    pub fn set(&self, engine: SttEngine) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = Some(engine);
        }
    }

    /// Check whether the STT engine has been loaded.
    pub fn is_loaded(&self) -> bool {
        self.inner
            .lock()
            .map(|slot| slot.is_some())
            .unwrap_or(false)
    }

    /// Start recording from the microphone.
    /// Returns false if the engine is not loaded yet.
    pub fn start_recording(&self) -> bool {
        if let Ok(slot) = self.inner.lock() {
            if let Some(engine) = slot.as_ref() {
                engine.start_recording();
                return true;
            }
        }
        false
    }

    /// Stop recording and transcribe. Returns the transcribed text.
    pub fn stop_and_transcribe(&self) -> Result<String> {
        let slot = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("STT mutex poisoned"))?;
        match slot.as_ref() {
            Some(engine) => engine.stop_and_transcribe(),
            None => Err(anyhow::anyhow!("STT engine not loaded")),
        }
    }
}

/// Convert multi-channel audio to mono by averaging channels.
fn stereo_to_mono(input: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels as usize;
    input
        .chunks(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// Resample audio from src_rate to dst_rate using linear interpolation.
/// Simple and fast — good enough for speech (no high-frequency content).
fn resample_linear(input: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || input.is_empty() {
        return input.to_vec();
    }

    let ratio = src_rate as f64 / dst_rate as f64;
    let output_len = (input.len() as f64 / ratio) as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;

        let sample = if idx + 1 < input.len() {
            input[idx] * (1.0 - frac as f32) + input[idx + 1] * frac as f32
        } else if idx < input.len() {
            input[idx]
        } else {
            0.0
        };

        output.push(sample);
    }

    output
}
