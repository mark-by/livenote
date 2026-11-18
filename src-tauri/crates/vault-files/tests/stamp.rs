use std::fs::{self, File, FileTimes};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use vault_files::VaultFiles;

#[test]
fn stamp_matches_node_bigint_stats_at_nanosecond_precision()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange: Node читает метку файла с известной дробной частью времени.
    let root = tempfile::tempdir()?;
    let name = "Note.md";
    let path = root.path().join(name);
    fs::write(&path, b"abc")?;
    let modified = UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789);
    File::open(&path)?.set_times(FileTimes::new().set_modified(modified))?;
    let node = Command::new("node")
        .args([
            "-e",
            "const s = require('node:fs').lstatSync(process.argv[1], { bigint: true }); process.stdout.write([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].join(':'));",
            "--",
        ])
        .arg(&path)
        .output()?;
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let expected = String::from_utf8(node.stdout)?;
    let vault = VaultFiles::open(root.path())?;

    // Act: Rust читает метку по пути и вместе с содержимым.
    let stamp = vault.stamp(name)?;
    let file = vault.read(name)?;

    // Assert: оба пути возвращают все шесть полей в формате Node.
    assert_eq!(stamp, expected);
    assert_eq!(file.stamp, expected);
    Ok(())
}
