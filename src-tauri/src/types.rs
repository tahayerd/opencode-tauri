use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TitlebarTheme {
    pub mode: String,
    #[serde(default)]
    pub scheme: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ServerReady {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FatalRendererError {
    pub error: String,
    pub url: String,
    #[serde(default)]
    pub version: Option<String>,
    pub platform: String,
    #[serde(default)]
    pub os: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NativeBundle {
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}
