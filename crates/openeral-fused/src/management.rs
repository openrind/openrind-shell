use crate::error::{Error, Result};
use crate::fs::FilesystemCore;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

pub async fn serve(core: Arc<FilesystemCore>, socket_path: PathBuf) -> Result<()> {
    if let Err(error) = tokio::fs::remove_file(&socket_path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.into());
        }
    }
    let listener = UnixListener::bind(&socket_path)?;
    tokio::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).await?;
    loop {
        let (stream, _) = listener.accept().await?;
        let core = Arc::clone(&core);
        tokio::spawn(async move {
            if let Err(error) = handle_client(core, stream).await {
                tracing::debug!(error = %error, "management client failed");
            }
        });
    }
}

async fn handle_client(core: Arc<FilesystemCore>, stream: UnixStream) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut command = String::new();
    if reader.read_line(&mut command).await? > 128 {
        return Err(Error::Invalid("management command is too long".into()));
    }
    let response = match command.trim() {
        "health" => core.health_json(),
        "flush-all" => match core.flush_all_async().await {
            Ok(()) => serde_json::json!({ "ok": true }),
            Err(error) => serde_json::json!({ "ok": false, "error": error.to_string() }),
        },
        _ => serde_json::json!({ "ok": false, "error": "unknown command" }),
    };
    writer.write_all(&serde_json::to_vec(&response)?).await?;
    writer.write_all(b"\n").await?;
    writer.shutdown().await?;
    Ok(())
}

pub async fn client(socket_path: &Path, command: &str) -> Result<serde_json::Value> {
    let mut stream = UnixStream::connect(socket_path).await?;
    stream.write_all(command.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.shutdown().await?;
    let mut reader = BufReader::new(stream);
    let mut response = Vec::new();
    reader.read_until(b'\n', &mut response).await?;
    if response.len() > 1024 * 1024 {
        return Err(Error::Invalid("management response is too large".into()));
    }
    Ok(serde_json::from_slice(&response)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeState;

    #[tokio::test]
    async fn health_exposes_content_free_counters_over_the_management_socket() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = RuntimeState::new("test".into(), directory.path().into());
        let core = FilesystemCore::new(tokio::runtime::Handle::current(), runtime);
        let (server, mut stream) = UnixStream::pair().unwrap();
        let server = tokio::spawn(handle_client(core, server));
        stream.write_all(b"health\n").await.unwrap();
        stream.shutdown().await.unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).await.unwrap();
        let health: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(health["state"], "initializing");
        assert_eq!(health["diagnostics"]["version"], 1);
        assert_eq!(health["diagnostics"]["requestsCompleted"], 0);
        server.await.unwrap().unwrap();
    }
}
