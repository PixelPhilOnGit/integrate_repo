/// Audio format conversion utilities.
///
/// Standard format: 16kHz, mono, 16-bit signed integer PCM.

pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sample_rate: 16000,
            channels: 1,
            bits_per_sample: 16,
        }
    }
}

impl AudioConfig {
    pub fn new(sample_rate: u32, channels: u16, bits_per_sample: u16) -> Self {
        Self {
            sample_rate,
            channels,
            bits_per_sample,
        }
    }

    pub fn bytes_per_sample(&self) -> usize {
        (self.bits_per_sample / 8) as usize
    }

    pub fn frame_size_bytes(&self) -> usize {
        self.channels as usize * self.bytes_per_sample()
    }

    /// Convert stereo PCM to mono by averaging channels
    pub fn stereo_to_mono(stereo_data: &[i16]) -> Vec<i16> {
        stereo_data
            .chunks_exact(2)
            .map(|chunk| {
                let sum = chunk[0] as i32 + chunk[1] as i32;
                (sum / 2) as i16
            })
            .collect()
    }

    /// Resample audio using simple linear interpolation.
    /// For production use, consider a proper resampling library.
    pub fn resample(input: &[i16], from_rate: u32, to_rate: u32) -> Vec<i16> {
        if from_rate == to_rate {
            return input.to_vec();
        }

        let ratio = from_rate as f64 / to_rate as f64;
        let output_len = (input.len() as f64 / ratio).round() as usize;
        let mut output = Vec::with_capacity(output_len);

        for i in 0..output_len {
            let src_idx = (i as f64 * ratio) as usize;
            if src_idx < input.len() {
                output.push(input[src_idx]);
            }
        }

        output
    }

    /// Convert raw bytes to Vec<i16>
    pub fn bytes_to_samples(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
            .collect()
    }

    /// Convert Vec<i16> to raw bytes
    pub fn samples_to_bytes(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect()
    }

    /// Convert input audio to the standard format (16kHz, mono, 16-bit PCM)
    pub fn normalize(
        data: &[u8],
        src_config: &AudioConfig,
    ) -> Vec<u8> {
        let mut samples = Self::bytes_to_samples(data);

        // Convert to mono if stereo
        if src_config.channels == 2 {
            samples = Self::stereo_to_mono(&samples);
        }

        // Resample to 16kHz
        if src_config.sample_rate != 16000 {
            samples = Self::resample(&samples, src_config.sample_rate, 16000);
        }

        Self::samples_to_bytes(&samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AudioConfig::default();
        assert_eq!(config.sample_rate, 16000);
        assert_eq!(config.channels, 1);
        assert_eq!(config.bits_per_sample, 16);
    }

    #[test]
    fn test_stereo_to_mono() {
        let stereo: Vec<i16> = vec![100, 200, 300, 400];
        let mono = AudioConfig::stereo_to_mono(&stereo);
        assert_eq!(mono.len(), 2);
        assert_eq!(mono[0], 150);
        assert_eq!(mono[1], 350);
    }

    #[test]
    fn test_bytes_to_samples_roundtrip() {
        let original: Vec<i16> = vec![0, 1000, -1000, 32767, -32768];
        let bytes = AudioConfig::samples_to_bytes(&original);
        let restored = AudioConfig::bytes_to_samples(&bytes);
        assert_eq!(original, restored);
    }

    #[test]
    fn test_resample_identity() {
        let input: Vec<i16> = vec![1, 2, 3, 4, 5];
        let output = AudioConfig::resample(&input, 16000, 16000);
        assert_eq!(input, output);
    }

    #[test]
    fn test_normalize_stereo_to_mono_16k() {
        let config = AudioConfig::new(16000, 2, 16);
        let samples: Vec<i16> = vec![100, 200, 300, 400];
        let bytes = AudioConfig::samples_to_bytes(&samples);
        let normalized = AudioConfig::normalize(&bytes, &config);
        let result = AudioConfig::bytes_to_samples(&normalized);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], 150);
        assert_eq!(result[1], 350);
    }
}
