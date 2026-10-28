// SPDX-License-Identifier: AGPL-3.0-only
//! Private, atomic files shared by native credential settings and token storage.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::Path,
};

pub(super) fn directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err(io::Error::other(
            "Credential directory must be a real directory",
        ));
    }
    protect(path, true)
}

fn protect(path: &Path, directory: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    windows_permissions::protect(path, directory)?;
    Ok(())
}

pub(super) fn read(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => {
            protect(path, false)?;
            fs::read(path).map(Some)
        }
        Ok(_) => Err(io::Error::other("Credential file must be a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn open(path: &Path, create_new: bool) -> io::Result<File> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.is_symlink() {
            return Err(io::Error::other("Credential file must be a regular file"));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    protect(path, false)?;
    Ok(file)
}

pub(super) fn locked(directory_path: &Path, name: &str) -> io::Result<File> {
    directory(directory_path)?;
    let file = open(&directory_path.join(name), false)?;
    // Lock a separate inode: replacing the JSON file must not replace the lock.
    file.lock()?;
    Ok(file)
}

pub(super) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing credential directory"))?;
    directory(parent)?;
    // Refuse to replace symlinks or directories, including a malformed existing store.
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.is_symlink() {
            return Err(io::Error::other("Credential file must be a regular file"));
        }
    }
    let temporary = parent.join(format!(".google-credentials-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = open(&temporary, true)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        if let Ok(directory) = File::open(parent) {
            // Replacement has committed; do not report a failed switch after this point.
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(windows)]
#[path = "windows_permissions.rs"]
mod windows_permissions;
