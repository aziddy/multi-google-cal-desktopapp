// SPDX-License-Identifier: AGPL-3.0-only
//! Restrict credential files and inheritable directory permissions to the current user.
use std::{io, mem::size_of, os::windows::ffi::OsStrExt, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: this handle is owned and was returned by OpenProcessToken.
        unsafe { CloseHandle(self.0) };
    }
}
struct Allocation(HLOCAL);
impl Drop for Allocation {
    fn drop(&mut self) {
        // SAFETY: the conversion APIs allocate buffers with LocalAlloc.
        unsafe { LocalFree(self.0) };
    }
}

pub(super) fn protect(path: &Path, directory: bool) -> io::Result<()> {
    // SAFETY: output pointers refer to live storage; all allocated buffers and the
    // process token remain alive until the ACL has been applied, then are released.
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Token(token);
        let mut length = 0;
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut length);
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        // usize storage supplies alignment for TOKEN_USER and the trailing SID.
        let mut user = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(
            token.0,
            TokenUser,
            user.as_mut_ptr().cast(),
            length,
            &mut length,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let sid = (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid;
        let mut sid_text = ptr::null_mut();
        if ConvertSidToStringSidW(sid, &mut sid_text) == 0 {
            return Err(io::Error::last_os_error());
        }
        let _sid_text = Allocation(sid_text.cast());
        let mut count = 0;
        while *sid_text.add(count) != 0 {
            count += 1;
        }
        let sid_string = String::from_utf16(std::slice::from_raw_parts(sid_text, count))
            .map_err(|_| io::Error::other("Invalid current-user SID"))?;
        let inheritance = if directory { "OICI" } else { "" };
        let sddl: Vec<u16> = format!("D:P(A;{inheritance};FA;;;{sid_string})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let _descriptor = Allocation(descriptor);
        let (mut present, mut defaulted) = (0, 0);
        let mut dacl = ptr::null_mut();
        if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0
            || present == 0
            || dacl.is_null()
        {
            return Err(io::Error::other(
                "Could not construct private credential permissions",
            ));
        }
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let error = SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null(),
        );
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        Ok(())
    }
}
