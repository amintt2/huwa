//! On-disk usage helpers. librqbit writes each torrent under `<data_dir>/torrents/<name>/`;
//! the quota is enforced by `Engine::enforce_quota` (LRU eviction of idle torrents).

use std::path::Path;

/// Recursive size of a directory in bytes (0 when missing). Symlinks are not followed.
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_nested_files() {
        let dir = std::env::temp_dir().join(format!("huwa-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("x.bin"), [0u8; 100]).unwrap();
        std::fs::write(dir.join("a/y.bin"), [0u8; 20]).unwrap();
        std::fs::write(dir.join("a/b/z.bin"), [0u8; 3]).unwrap();
        assert_eq!(dir_size(&dir), 123);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(dir_size(&dir), 0);
    }
}
