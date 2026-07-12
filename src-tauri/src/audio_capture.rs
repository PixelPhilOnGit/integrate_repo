use crate::audio_format::AudioConfig;
use crate::error::{AppError, AppResult};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

pub enum AudioSource {
    Microphone,
    SystemAudio,
}

pub struct AudioCapture {
    stream: Option<cpal::Stream>,
    config: AudioConfig,
    buffer: Arc<Mutex<Vec<u8>>>,
    is_recording: Arc<Mutex<bool>>,
}

impl AudioCapture {
    pub fn new() -> Self {
        Self {
            stream: None,
            config: AudioConfig::default(),
            buffer: Arc::new(Mutex::new(Vec::new())),
            is_recording: Arc::new(Mutex::new(false)),
        }
    }

    pub fn start_microphone(&mut self) -> AppResult<()> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| AppError::AudioCapture("No input device found".into()))?;

        let supported_config = device
            .default_input_config()
            .map_err(|e| AppError::AudioCapture(format!("Failed to get input config: {}", e)))?;

        let config: cpal::StreamConfig = cpal::StreamConfig {
            channels: 1,
            sample_rate: cpal::SampleRate(self.config.sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let buffer = Arc::clone(&self.buffer);
        let is_recording = Arc::clone(&self.is_recording);

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if *is_recording.lock().unwrap() {
                        // Convert f32 samples to i16 PCM
                        let i16_data: Vec<i16> = data
                            .iter()
                            .map(|&s| (s * i16::MAX as f32) as i16)
                            .collect();
                        let bytes = AudioConfig::samples_to_bytes(&i16_data);
                        if let Ok(mut buf) = buffer.lock() {
                            buf.extend_from_slice(&bytes);
                        }
                    }
                },
                |err| {
                    eprintln!("Audio capture error: {}", err);
                },
                None,
            )
            .map_err(|e| AppError::AudioCapture(format!("Failed to build input stream: {}", e)))?;

        stream.play().map_err(|e| {
            AppError::AudioCapture(format!("Failed to start stream: {}", e))
        })?;

        *self.is_recording.lock().unwrap() = true;
        self.stream = Some(stream);

        Ok(())
    }

    pub fn start_system_audio(&mut self) -> AppResult<()> {
        #[cfg(target_os = "macos")]
        {
            // On macOS, system audio capture requires AudioUnit loopback
            // This is a stub — full implementation requires AudioUnit setup
            Err(AppError::Other(
                "System audio capture requires additional setup on macOS. \
                 Please install a virtual audio driver like BlackHole or Soundflower."
                    .into(),
            ))
        }

        #[cfg(not(target_os = "macos"))]
        {
            Err(AppError::UnsupportedPlatform)
        }
    }

    pub fn stop(&mut self) -> AppResult<Vec<u8>> {
        *self.is_recording.lock().unwrap() = false;

        if let Some(stream) = self.stream.take() {
            drop(stream);
        }

        let data = std::mem::take(&mut *self.buffer.lock().unwrap());
        Ok(data)
    }

    pub fn is_recording(&self) -> bool {
        *self.is_recording.lock().unwrap()
    }

    pub fn get_available_microphones(&self) -> Vec<String> {
        let host = cpal::default_host();
        match host.input_devices() {
            Ok(devices) => devices
                .map(|d| d.name().unwrap_or_else(|_| "Unknown Device".into()))
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
