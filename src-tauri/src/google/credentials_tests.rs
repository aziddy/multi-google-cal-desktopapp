// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use std::{
    fs,
    sync::atomic::{AtomicUsize, Ordering},
};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "multi-calendar-credentials-test-{}",
            uuid::Uuid::new_v4()
        ));
        private_file::directory(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct ForbiddenOsStore(AtomicUsize);
impl SecretStore for ForbiddenOsStore {
    fn get(&self, _: &str) -> Result<Option<String>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("Unexpected OS credential read")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        panic!("Unexpected OS credential write")
    }
    fn delete(&self, _: &str) -> Result<()> {
        panic!("Unexpected OS credential delete")
    }
}

#[test]
fn default_local_store_survives_restart_without_any_os_calls() {
    let directory = Directory::new();
    let os = Arc::new(ForbiddenOsStore::default());
    for restarted in [false, true] {
        let local = Arc::new(FileSecrets::new(directory.0.clone()));
        let credentials = Credentials::with_stores(&directory.0, local, os.clone()).unwrap();
        assert_eq!(credentials.mode().unwrap(), CredentialStorage::LocalFile);
        if !restarted {
            assert_eq!(credentials.get("account-a").unwrap(), None);
            credentials.set("account-a", "synthetic-refresh-a").unwrap();
            credentials
                .replace("account-b", "synthetic-refresh-b")
                .unwrap();
        } else {
            assert_eq!(
                credentials.get("account-a").unwrap().as_deref(),
                Some("synthetic-refresh-a")
            );
            credentials.delete("account-a").unwrap();
            assert_eq!(credentials.get("account-a").unwrap(), None);
            assert_eq!(
                credentials.get("account-b").unwrap().as_deref(),
                Some("synthetic-refresh-b")
            );
        }
    }
    assert_eq!(os.0.load(Ordering::SeqCst), 0);
}

#[test]
fn malformed_tokens_are_never_overwritten_or_used_to_fall_back() {
    let directory = Directory::new();
    let path = directory.0.join(TOKEN_FILE);
    for malformed in [
        "broken",
        "[]",
        r#"{"account-a":null}"#,
        r#"{"account-a":""}"#,
    ] {
        fs::write(&path, malformed).unwrap();
        let credentials = Credentials::with_stores(
            &directory.0,
            Arc::new(FileSecrets::new(directory.0.clone())),
            Arc::new(ForbiddenOsStore::default()),
        )
        .unwrap();
        assert_eq!(
            credentials.get("account-a").unwrap_err().code,
            "SECURE_STORE"
        );
        assert!(credentials.set("account-a", "synthetic-new").is_err());
        assert!(credentials.replace("account-a", "synthetic-new").is_err());
        assert!(credentials.delete("account-a").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), malformed);
    }
}

#[test]
fn malformed_settings_do_not_silently_select_a_backend() {
    let directory = Directory::new();
    for malformed in ["broken", "{}", r#"{"storage":"unknown"}"#] {
        fs::write(directory.0.join(SETTINGS_FILE), malformed).unwrap();
        let result = Credentials::with_stores(
            &directory.0,
            Arc::new(ForbiddenOsStore::default()),
            Arc::new(ForbiddenOsStore::default()),
        );
        assert_eq!(result.err().unwrap().code, "CREDENTIAL_SETTINGS");
    }
}

#[test]
fn settings_persist_and_failed_saves_leave_the_active_selection_unchanged() {
    let directory = Directory::new();
    let credentials = Credentials::load(&directory.0).unwrap();
    credentials.select(CredentialStorage::OsStore).unwrap();
    assert_eq!(
        Credentials::load(&directory.0).unwrap().mode().unwrap(),
        CredentialStorage::OsStore
    );
    fs::remove_file(directory.0.join(SETTINGS_FILE)).unwrap();
    fs::create_dir(directory.0.join(SETTINGS_FILE)).unwrap();
    assert_eq!(
        credentials
            .select(CredentialStorage::LocalFile)
            .unwrap_err()
            .code,
        "CREDENTIAL_SETTINGS"
    );
    assert_eq!(credentials.mode().unwrap(), CredentialStorage::OsStore);
}

#[test]
fn separate_store_instances_preserve_concurrent_account_updates() {
    let directory = Directory::new();
    let threads: Vec<_> = (0..12)
        .map(|i| {
            let path = directory.0.clone();
            std::thread::spawn(move || {
                let store = FileSecrets::new(path);
                store
                    .set(&format!("account-{i}"), &format!("synthetic-{i}"))
                    .unwrap();
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let store = FileSecrets::new(directory.0.clone());
    for i in 0..12 {
        assert_eq!(
            store.get(&format!("account-{i}")).unwrap(),
            Some(format!("synthetic-{i}"))
        );
    }
}

#[test]
fn separate_processes_preserve_concurrent_account_updates() {
    use std::process::{Command, Stdio};
    let directory = Directory::new();
    let children: Vec<_> = (0..6)
        .map(|i| {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "google::credentials::tests::credential_writer_subprocess",
                ])
                .env("MULTI_CALENDAR_TEST_CREDENTIAL_DIRECTORY", &directory.0)
                .env("MULTI_CALENDAR_TEST_ACCOUNT", format!("account-{i}"))
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "Synthetic credential subprocess failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let store = FileSecrets::new(directory.0.clone());
    for i in 0..6 {
        assert_eq!(
            store.get(&format!("account-{i}")).unwrap().as_deref(),
            Some("synthetic-subprocess-refresh")
        );
    }
}

#[test]
#[ignore = "Synthetic subprocess fixture invoked by separate_processes_preserve_concurrent_account_updates"]
fn credential_writer_subprocess() {
    let directory = std::env::var_os("MULTI_CALENDAR_TEST_CREDENTIAL_DIRECTORY")
        .expect("Synthetic test directory required");
    let account =
        std::env::var("MULTI_CALENDAR_TEST_ACCOUNT").expect("Synthetic test account required");
    FileSecrets::new(directory.into())
        .set(&account, "synthetic-subprocess-refresh")
        .unwrap();
}

#[cfg(unix)]
#[test]
fn token_settings_lock_and_directory_permissions_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let directory = Directory::new();
    let credentials = Credentials::load(&directory.0).unwrap();
    credentials.set("account-a", "synthetic-refresh").unwrap();
    credentials.select(CredentialStorage::LocalFile).unwrap();
    assert_eq!(
        fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for name in [TOKEN_FILE, SETTINGS_FILE, "google-refresh-tokens.lock"] {
        assert_eq!(
            fs::metadata(directory.0.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    // A pre-existing permissive file is tightened before its contents are read.
    fs::set_permissions(
        directory.0.join(TOKEN_FILE),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    credentials.get("account-a").unwrap();
    assert_eq!(
        fs::metadata(directory.0.join(TOKEN_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn symlinked_token_files_are_rejected_without_modifying_the_target() {
    use std::os::unix::fs::symlink;
    let directory = Directory::new();
    let outside = Directory::new();
    let target = outside.0.join("synthetic.json");
    fs::write(&target, "do not replace").unwrap();
    symlink(&target, directory.0.join(TOKEN_FILE)).unwrap();
    let store = FileSecrets::new(directory.0.clone());
    assert!(store.get("account-a").is_err());
    assert!(store.set("account-a", "synthetic-refresh").is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "do not replace");
    assert!(private_file::write(&directory.0.join(TOKEN_FILE), b"replacement").is_err());
    assert!(fs::read_dir(&directory.0).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
}
