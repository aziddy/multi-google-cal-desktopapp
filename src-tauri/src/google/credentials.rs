// SPDX-License-Identifier: AGPL-3.0-only
use super::{
    auth::{OsSecrets, SecretStore},
    lock,
    model::{Error, Result},
    private_file,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub(super) const TOKEN_FILE: &str = "google-refresh-tokens.json";
const SETTINGS_FILE: &str = "google-credential-settings.json";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStorage {
    #[default]
    LocalFile,
    OsStore,
}

pub(super) fn local_error() -> Error {
    Error::new("SECURE_STORE", "The local Google token file could not be read or saved. Check file permissions and available disk space, then choose Retry credential access in Settings. A damaged token file must be restored or removed before reconnecting.")
}

fn settings_error() -> Error {
    Error::new("CREDENTIAL_SETTINGS", "Credential storage settings could not be read or saved. Check the application-data folder's permissions and available disk space. Restore or remove a damaged google-credential-settings.json file, then restart the app.")
}

pub(super) struct FileSecrets {
    directory: PathBuf,
}
impl FileSecrets {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    fn transaction<T>(
        &self,
        update: bool,
        operation: impl FnOnce(&mut BTreeMap<String, String>) -> T,
    ) -> Result<T> {
        let _file = private_file::locked(&self.directory, "google-refresh-tokens.lock")
            .map_err(|_| local_error())?;
        let path = self.directory.join(TOKEN_FILE);
        let raw = private_file::read(&path).map_err(|_| local_error())?;
        let mut values: BTreeMap<String, String> = match raw {
            Some(raw) => serde_json::from_slice(&raw).map_err(|_| local_error())?,
            None => BTreeMap::new(),
        };
        if values
            .iter()
            .any(|(account, token)| account.is_empty() || token.is_empty())
        {
            return Err(local_error());
        }
        let result = operation(&mut values);
        if update {
            let bytes = serde_json::to_vec(&values).map_err(|_| local_error())?;
            private_file::write(&path, &bytes).map_err(|_| local_error())?;
        }
        Ok(result)
    }
}
impl SecretStore for FileSecrets {
    fn get(&self, sub: &str) -> Result<Option<String>> {
        self.transaction(false, |values| values.get(sub).cloned())
    }
    fn set(&self, sub: &str, token: &str) -> Result<()> {
        if sub.is_empty() || token.is_empty() {
            return Err(local_error());
        }
        self.transaction(true, |values| {
            values.insert(sub.into(), token.into());
        })
    }
    fn delete(&self, sub: &str) -> Result<()> {
        self.transaction(true, |values| {
            values.remove(sub);
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    storage: CredentialStorage,
}

pub(super) struct Credentials {
    directory: PathBuf,
    mode: Mutex<CredentialStorage>,
    local: Arc<dyn SecretStore>,
    os: Arc<dyn SecretStore>,
}
impl Credentials {
    pub fn load(directory: &Path) -> Result<Self> {
        Self::with_stores(
            directory,
            Arc::new(FileSecrets::new(directory.into())),
            Arc::new(OsSecrets),
        )
    }
    pub fn with_stores(
        directory: &Path,
        local: Arc<dyn SecretStore>,
        os: Arc<dyn SecretStore>,
    ) -> Result<Self> {
        let mode = match private_file::read(&directory.join(SETTINGS_FILE))
            .map_err(|_| settings_error())?
        {
            Some(raw) => {
                serde_json::from_slice::<Settings>(&raw)
                    .map_err(|_| settings_error())?
                    .storage
            }
            None => CredentialStorage::default(),
        };
        Ok(Self {
            directory: directory.into(),
            mode: Mutex::new(mode),
            local,
            os,
        })
    }
    pub fn mode(&self) -> Result<CredentialStorage> {
        Ok(*lock(&self.mode)?)
    }
    pub fn select(&self, mode: CredentialStorage) -> Result<()> {
        let mut selected = lock(&self.mode)?;
        let bytes =
            serde_json::to_vec(&Settings { storage: mode }).map_err(|_| settings_error())?;
        private_file::write(&self.directory.join(SETTINGS_FILE), &bytes)
            .map_err(|_| settings_error())?;
        *selected = mode;
        Ok(())
    }
    pub fn error(&self) -> Error {
        match self.mode() {
            Ok(CredentialStorage::LocalFile) => local_error(),
            _ => super::auth::secure_error(),
        }
    }
    fn store(&self) -> Result<&dyn SecretStore> {
        Ok(match self.mode()? {
            CredentialStorage::LocalFile => self.local.as_ref(),
            CredentialStorage::OsStore => self.os.as_ref(),
        })
    }
}
impl SecretStore for Credentials {
    fn get(&self, sub: &str) -> Result<Option<String>> {
        self.store()?.get(sub)
    }
    fn set(&self, sub: &str, token: &str) -> Result<()> {
        self.store()?.set(sub, token)
    }
    fn delete(&self, sub: &str) -> Result<()> {
        self.store()?.delete(sub)
    }
    fn replace(&self, sub: &str, token: &str) -> Result<()> {
        self.store()?.replace(sub, token)
    }
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
mod tests;
