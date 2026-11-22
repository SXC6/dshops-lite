#![forbid(unsafe_code)]
use cap_std::{ambient_authority, fs::Dir};
use contract::*;
pub use ops_protocol as contract;
use serde_json::Value;

pub fn dispatch(request: Request) -> Result<Value> {
    if request.scope.is_empty()
        || request.scope.len() > 256
        || !std::path::Path::new(&request.root).is_absolute()
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "An absolute workspace root and a bounded scope identity are required",
        ));
    }
    let root = std::fs::canonicalize(&request.root)?;
    let mut request = Request {
        root: root
            .to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 root"))?
            .into(),
        ..request
    };
    let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
    use cap_fs_ext::MetadataExt;
    let metadata = dir.dir_metadata()?;
    request.root_identity = format!("{}:{}", metadata.dev(), metadata.ino());
    execute(&request)
}
fn execute(request: &Request) -> Result<Value> {
    // File reads/searches do not create or consult the durable audit store.
    // This is important for read-only sessions and keeps observation separate
    // from mutation audit records.
    if matches!(
        request.tool.as_str(),
        "inspect_local_file"
            | "read_files"
            | "glob"
            | "grep"
            | "replace"
            | "write_file"
            | "edit_file"
            | "diff"
            | "stat"
            | "copy"
            | "move"
            | "remove"
    ) {
        return if matches!(request.tool.as_str(), "glob" | "grep" | "replace") {
            ops_search::dispatch(request)
        } else {
            ops_files::dispatch(request)
        };
    }
    Err(Failure::new("INVALID_ARGUMENT", "Unknown capability"))
}
