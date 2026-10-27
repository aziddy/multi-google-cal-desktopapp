// SPDX-License-Identifier: AGPL-3.0-only
//! Noninteractive login-Keychain access. Neither background refresh nor an
//! explicit account action may trap the user in a macOS password prompt loop.
use super::{
    auth::{OsSecrets, SecretStore, SERVICE},
    model::{Error, Result},
};
use core_foundation::{
    base::TCFType,
    string::{CFString, CFStringRef},
};
use security_framework::{
    base::Error as KeychainError,
    os::macos::keychain::SecKeychain,
    passwords::{self, PasswordOptions},
};
use security_framework_sys::item::kSecUseAuthenticationUI;
use std::sync::Mutex;

// The Security.framework symbol is public on macOS 10.10+, but is not exported
// by security-framework-sys 2.17. It instructs SecItem calls to fail rather than
// display authentication UI. It does not grant access or change an item's ACL.
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecUseAuthenticationUIFail: CFStringRef;
}

static KEYCHAIN_CALL: Mutex<()> = Mutex::new(());
fn denied() -> Error {
    Error::new("SECURE_STORE","macOS could not access this build’s Google credential without authentication. Reconnect this account in Settings to replace its app-owned credential. If your login Keychain is locked, unlock it in Keychain Access first.")
}

#[allow(deprecated)] // PasswordOptions has no public builder for this Security.framework flag.
fn options(service: &str, account: &str) -> Result<PasswordOptions> {
    if account.is_empty() || service.is_empty() {
        return Err(denied());
    }
    let mut options = PasswordOptions::new_generic_password(service, account);
    // SAFETY: both are immutable, system-owned CFString constants with process lifetime.
    unsafe {
        options.query.push((
            CFString::wrap_under_get_rule(kSecUseAuthenticationUI),
            CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).into_CFType(),
        ));
    }
    Ok(options)
}
fn quiet<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let _call = KEYCHAIN_CALL.lock().map_err(|_| denied())?;
    // Also suppress legacy Keychain UI used internally on file-based keychains.
    // This flag is scoped to this process. Restore its prior value on return.
    let previous = SecKeychain::user_interaction_allowed().map_err(|_| denied())?;
    let _no_ui = if previous {
        Some(SecKeychain::disable_user_interaction().map_err(|_| denied())?)
    } else {
        None
    };
    operation()
}
fn missing(error: KeychainError) -> Result<()> {
    if error.code() == -25300 {
        Ok(())
    } else {
        Err(denied())
    }
}
fn get(service: &str, sub: &str) -> Result<Option<String>> {
    quiet(
        || match passwords::generic_password(options(service, sub)?) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| denied()),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(_) => Err(denied()),
        },
    )
}
fn set(service: &str, sub: &str, token: &str) -> Result<()> {
    quiet(|| {
        passwords::set_generic_password_options(token.as_bytes(), options(service, sub)?)
            .map_err(|_| denied())
    })
}
fn delete(service: &str, sub: &str) -> Result<()> {
    // SecItemDelete does not read/decrypt the password, unlike keyring's legacy
    // find-then-delete implementation. Match only this app's exact service/account.
    quiet(|| {
        passwords::delete_generic_password_options(options(service, sub)?)
            .or_else(|error| {
                if error.code() == -25300 {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|_| denied())
    })
}
impl SecretStore for OsSecrets {
    fn get(&self, sub: &str) -> Result<Option<String>> {
        get(SERVICE, sub)
    }
    fn set(&self, sub: &str, token: &str) -> Result<()> {
        set(SERVICE, sub, token)
    }
    fn delete(&self, sub: &str) -> Result<()> {
        delete(SERVICE, sub)
    }
    fn replace(&self, sub: &str, token: &str) -> Result<()> {
        quiet(|| {
            // Called only after explicit Google consent returns a fresh refresh
            // token. Recreate the exact owned item so its default ACL belongs to
            // this signed build; never widen trust or modify other Keychain items.
            if let Err(error) = passwords::delete_generic_password_options(options(SERVICE, sub)?) {
                missing(error)?;
            }
            passwords::set_generic_password_options(token.as_bytes(), options(SERVICE, sub)?)
                .map_err(|_| denied())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_query_fails_instead_of_displaying_authentication_ui() {
        #[allow(deprecated)]
        let query = options("synthetic-service", "synthetic-account")
            .unwrap()
            .query;
        let found = query.iter().any(|(key, value)| {
            // SAFETY: options() inserted this CFString under the authentication key.
            key.to_string()
                == unsafe { CFString::wrap_under_get_rule(kSecUseAuthenticationUI) }.to_string()
                && value.downcast::<CFString>().is_some_and(|value| {
                    value == unsafe { CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail) }
                })
        });
        assert!(found);
        assert!(options("service", "").is_err());
    }
    #[test]
    #[ignore = "Explicit live OS smoke test; uses only a disposable synthetic credential"]
    fn macos_noninteractive_round_trip() {
        let account = uuid::Uuid::new_v4().to_string();
        let service = "com.aziddy.multicalendar.synthetic-keychain-test";
        assert_eq!(get(service, &account).unwrap(), None);
        set(service, &account, "synthetic-value").unwrap();
        assert!(get(service, &account).unwrap().is_some());
        set(service, &account, "updated-synthetic-value").unwrap();
        delete(service, &account).unwrap();
        assert_eq!(get(service, &account).unwrap(), None);
    }
}
