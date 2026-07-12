use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Audio capture error: {0}")]
    AudioCapture(String),

    #[error("Speech recognition error: {0}")]
    SpeechRecognition(String),

    #[error("Speech synthesis error: {0}")]
    SpeechSynthesis(String),

    #[error("Shortcut registration error: {0}")]
    Shortcut(String),

    #[error("Tray error: {0}")]
    Tray(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Not supported on this platform")]
    UnsupportedPlatform,

    #[error("{0}")]
    Other(String),
}

pub type AppResult<T> = Result<T, AppError>;
