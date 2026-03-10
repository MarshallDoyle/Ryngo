// RYNGO: LLM inference wrapper around llama-cpp-2 for Gemma 3n

use anyhow::{Context, Result};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel, Special};
use llama_cpp_2::sampling::LlamaSampler;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Configuration for the LLM
pub struct LlmConfig {
    /// Number of GPU layers to offload (1000 = all)
    pub n_gpu_layers: u32,
    /// Context window size in tokens
    pub n_ctx: u32,
    /// Maximum tokens to generate per request
    pub max_tokens: i32,
    /// Temperature for sampling (0.0 = greedy)
    pub temperature: f32,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            n_gpu_layers: 1000,
            n_ctx: 4096,
            max_tokens: 512,
            temperature: 0.7,
        }
    }
}

/// The loaded LLM, ready for inference.
/// Wraps llama-cpp-2 backend, model, and context.
pub struct Llm {
    backend: LlamaBackend,
    model: LlamaModel,
    config: LlmConfig,
}

impl Llm {
    /// Load a GGUF model from disk.
    /// This is a blocking operation — call from a background thread.
    pub fn load(model_path: &Path, config: LlmConfig) -> Result<Self> {
        log::info!("Initializing llama.cpp backend...");
        let backend = LlamaBackend::init().context("failed to initialize llama.cpp backend")?;

        log::info!("Loading model from {}...", model_path.display());
        let model_params = LlamaModelParams::default()
            .with_n_gpu_layers(config.n_gpu_layers);

        let model = LlamaModel::load_from_file(&backend, model_path, &model_params)
            .with_context(|| format!("failed to load model from {}", model_path.display()))?;

        log::info!("Model loaded successfully");

        Ok(Self {
            backend,
            model,
            config,
        })
    }

    /// Generate a text completion for the given prompt.
    /// This is a blocking operation — call from a background thread.
    pub fn generate(&self, prompt: &str) -> Result<String> {
        // Create a fresh context for this generation
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(
                NonZeroU32::new(self.config.n_ctx).unwrap_or(NonZeroU32::new(4096).unwrap()),
            ));

        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .context("failed to create inference context")?;

        // Tokenize the prompt
        let tokens = self
            .model
            .str_to_token(prompt, AddBos::Always)
            .context("failed to tokenize prompt")?;

        if tokens.is_empty() {
            return Ok(String::new());
        }

        // Feed prompt tokens into a batch
        let n_prompt = tokens.len();
        let mut batch = LlamaBatch::new(
            (self.config.n_ctx as usize).max(n_prompt + self.config.max_tokens as usize),
            1,
        );

        let last_index = (n_prompt - 1) as i32;
        for (i, token) in (0_i32..).zip(tokens.into_iter()) {
            let is_last = i == last_index;
            batch.add(token, i, &[0], is_last)?;
        }

        // Decode the prompt (prefill)
        ctx.decode(&mut batch)
            .context("llama_decode failed during prompt processing")?;

        // Set up sampler
        let mut sampler = if self.config.temperature < 0.01 {
            LlamaSampler::chain_simple([
                LlamaSampler::greedy(),
            ])
        } else {
            LlamaSampler::chain_simple([
                LlamaSampler::temp(self.config.temperature),
                LlamaSampler::dist(1234),
            ])
        };

        // Generate tokens
        let mut output = String::new();
        let mut n_cur = batch.n_tokens();

        for _ in 0..self.config.max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);

            // Check for end of generation
            if self.model.is_eog_token(token) {
                break;
            }

            // Convert token to text
            let piece = self
                .model
                .token_to_str(token, Special::Plaintext)
                .map_err(|e| anyhow::anyhow!("token_to_str failed: {}", e))?;
            output.push_str(&piece);

            // Prepare next batch
            batch.clear();
            batch.add(token, n_cur, &[0], true)?;

            ctx.decode(&mut batch)
                .context("llama_decode failed during generation")?;

            n_cur += 1;
        }

        Ok(output)
    }

    /// Generate a text completion with streaming output.
    /// Calls `on_token` for each generated token piece.
    /// Return `false` from the callback to stop generation early.
    /// This is a blocking operation — call from a background thread.
    pub fn generate_streaming(
        &self,
        prompt: &str,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<()> {
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(
                NonZeroU32::new(self.config.n_ctx).unwrap_or(NonZeroU32::new(4096).unwrap()),
            ));

        let mut ctx = self
            .model
            .new_context(&self.backend, ctx_params)
            .context("failed to create inference context")?;

        let tokens = self
            .model
            .str_to_token(prompt, AddBos::Always)
            .context("failed to tokenize prompt")?;

        if tokens.is_empty() {
            return Ok(());
        }

        let n_prompt = tokens.len();
        let mut batch = LlamaBatch::new(
            (self.config.n_ctx as usize).max(n_prompt + self.config.max_tokens as usize),
            1,
        );

        let last_index = (n_prompt - 1) as i32;
        for (i, token) in (0_i32..).zip(tokens.into_iter()) {
            let is_last = i == last_index;
            batch.add(token, i, &[0], is_last)?;
        }

        ctx.decode(&mut batch)
            .context("llama_decode failed during prompt processing")?;

        let mut sampler = if self.config.temperature < 0.01 {
            LlamaSampler::chain_simple([LlamaSampler::greedy()])
        } else {
            LlamaSampler::chain_simple([
                LlamaSampler::temp(self.config.temperature),
                LlamaSampler::dist(1234),
            ])
        };

        let mut n_cur = batch.n_tokens();

        for _ in 0..self.config.max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);

            if self.model.is_eog_token(token) {
                break;
            }

            let piece = self
                .model
                .token_to_str(token, Special::Plaintext)
                .map_err(|e| anyhow::anyhow!("token_to_str failed: {}", e))?;

            if !on_token(&piece) {
                break; // caller requested stop
            }

            batch.clear();
            batch.add(token, n_cur, &[0], true)?;

            ctx.decode(&mut batch)
                .context("llama_decode failed during generation")?;

            n_cur += 1;
        }

        Ok(())
    }

    /// Generate a text completion for a raw prompt (no chat template wrapping).
    /// Use this for the agent loop where the caller builds the full context.
    /// This is a blocking operation — call from a background thread.
    pub fn generate_raw(&self, full_prompt: &str) -> Result<String> {
        // Identical to generate() — the prompt is passed as-is.
        // The difference is semantic: callers know this won't wrap in chat template.
        self.generate(full_prompt)
    }

    /// Generate a raw completion with streaming output.
    /// Same as generate_streaming but emphasizes that the prompt is pre-formatted.
    pub fn generate_streaming_raw(
        &self,
        full_prompt: &str,
        on_token: &mut dyn FnMut(&str) -> bool,
    ) -> Result<()> {
        self.generate_streaming(full_prompt, on_token)
    }

    /// Summarize text using the LLM.
    pub fn summarize(&self, text: &str) -> Result<String> {
        let prompt = format!(
            "<start_of_turn>user\nSummarize the following terminal output in 1-2 concise sentences:\n\n{}\n<end_of_turn>\n<start_of_turn>model\n",
            text
        );
        self.generate(&prompt)
    }

    /// Ask the model a question.
    pub fn chat(&self, user_message: &str) -> Result<String> {
        let prompt = format!(
            "<start_of_turn>user\n{}\n<end_of_turn>\n<start_of_turn>model\n",
            user_message
        );
        self.generate(&prompt)
    }

    /// Translate a natural language request into a shell command.
    /// The model is instructed to output ONLY the command, nothing else.
    pub fn natural_language_to_command(&self, request: &str, cwd: &str) -> Result<String> {
        let prompt = format!(
            "<start_of_turn>user\n\
             Convert this to a single shell command. Output ONLY the command, nothing else.\n\
             Current directory: {}\n\
             Request: {}\n\
             <end_of_turn>\n\
             <start_of_turn>model\n",
            cwd, request
        );
        let result = self.generate(&prompt)?;
        // Trim any leading/trailing whitespace or backticks the model might add
        let trimmed = result.trim();
        let trimmed = trimmed.strip_prefix("```").unwrap_or(trimmed);
        let trimmed = trimmed.strip_suffix("```").unwrap_or(trimmed);
        let trimmed = trimmed.strip_prefix("bash\n").unwrap_or(trimmed);
        let trimmed = trimmed.strip_prefix("sh\n").unwrap_or(trimmed);
        Ok(trimmed.trim().to_string())
    }
}

/// Thread-safe handle to the LLM, shared across the application.
#[derive(Clone)]
pub struct LlmHandle {
    inner: Arc<Mutex<Option<Llm>>>,
}

impl LlmHandle {
    /// Create an empty handle (model not loaded yet)
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the loaded LLM
    pub async fn set(&self, llm: Llm) {
        let mut guard = self.inner.lock().await;
        *guard = Some(llm);
    }

    /// Check if the model is loaded
    pub async fn is_loaded(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    /// Run a generation on a background thread.
    /// Returns None if the model isn't loaded yet.
    pub async fn generate(&self, prompt: String) -> Result<Option<String>> {
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || {
            // We need to block on the async lock from a sync context
            let rt = tokio::runtime::Handle::current();
            let guard = rt.block_on(inner.lock());
            match guard.as_ref() {
                Some(llm) => llm.generate(&prompt).map(Some),
                None => Ok(None),
            }
        })
        .await
        .context("LLM task panicked")??;

        Ok(result)
    }

    /// Summarize text on a background thread.
    pub async fn summarize(&self, text: String) -> Result<Option<String>> {
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Handle::current();
            let guard = rt.block_on(inner.lock());
            match guard.as_ref() {
                Some(llm) => llm.summarize(&text).map(Some),
                None => Ok(None),
            }
        })
        .await
        .context("LLM task panicked")??;

        Ok(result)
    }

    /// Chat with the model on a background thread.
    pub async fn chat(&self, message: String) -> Result<Option<String>> {
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Handle::current();
            let guard = rt.block_on(inner.lock());
            match guard.as_ref() {
                Some(llm) => llm.chat(&message).map(Some),
                None => Ok(None),
            }
        })
        .await
        .context("LLM task panicked")??;

        Ok(result)
    }

    /// Stream chat responses token by token through a channel.
    /// Each generated token is sent through `tx`. Returns when generation completes.
    pub async fn chat_streaming(
        &self,
        message: String,
        tx: std::sync::mpsc::Sender<String>,
    ) -> Result<()> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Handle::current();
            let guard = rt.block_on(inner.lock());
            match guard.as_ref() {
                Some(llm) => {
                    let prompt = format!(
                        "<start_of_turn>user\n{}\n<end_of_turn>\n<start_of_turn>model\n",
                        message
                    );
                    llm.generate_streaming(&prompt, &mut |token| {
                        tx.send(token.to_string()).is_ok()
                    })
                }
                None => anyhow::bail!("Model not loaded"),
            }
        })
        .await
        .context("LLM streaming task panicked")?
    }

    /// Stream a raw (pre-formatted) prompt through the LLM.
    /// Used by the agent loop where the caller builds the full context string.
    pub async fn generate_raw_streaming(
        &self,
        prompt: String,
        tx: std::sync::mpsc::Sender<String>,
    ) -> Result<()> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Handle::current();
            let guard = rt.block_on(inner.lock());
            match guard.as_ref() {
                Some(llm) => {
                    llm.generate_streaming_raw(&prompt, &mut |token| {
                        tx.send(token.to_string()).is_ok()
                    })
                }
                None => anyhow::bail!("Model not loaded"),
            }
        })
        .await
        .context("LLM raw streaming task panicked")?
    }

    /// Generate a raw (pre-formatted) prompt on a background thread.
    /// Returns the full response text.
    pub async fn generate_raw(&self, prompt: String) -> Result<Option<String>> {
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Handle::current();
            let guard = rt.block_on(inner.lock());
            match guard.as_ref() {
                Some(llm) => llm.generate_raw(&prompt).map(Some),
                None => Ok(None),
            }
        })
        .await
        .context("LLM task panicked")??;

        Ok(result)
    }

    /// Translate natural language to a shell command on a background thread.
    pub async fn natural_language_to_command(
        &self,
        request: String,
        cwd: String,
    ) -> Result<Option<String>> {
        let inner = self.inner.clone();
        let result = tokio::task::spawn_blocking(move || {
            let rt = tokio::runtime::Handle::current();
            let guard = rt.block_on(inner.lock());
            match guard.as_ref() {
                Some(llm) => llm.natural_language_to_command(&request, &cwd).map(Some),
                None => Ok(None),
            }
        })
        .await
        .context("LLM task panicked")??;

        Ok(result)
    }
}
