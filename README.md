# Multi Calendar

All your calendars, one clear view.

An open-source desktop calendar built with **Tauri 2, Rust, React, TypeScript, and Vite**. Connect multiple Google accounts using your own Desktop OAuth client, view downloaded events offline, and edit eligible events in either Multi Calendar or Google Calendar.

macOS is the primary desktop target. Windows and Linux credential-store integrations are included, but need testing on those operating systems. Browser development uses independent fictional demo data.

![Multi Calendar week view with fictional demo data](docs/preview.png)

## Get started

Install **Node.js 22.22.2 or later**, **pnpm 10**, **Rust 1.90 or later**, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). On macOS, install Xcode Command Line Tools.

```sh
corepack enable
pnpm install
pnpm tauri dev
```

Open Settings, import a Google Desktop OAuth client JSON, then choose **Connect another Google account**. Sign-in opens your system browser. The app uses authorization code flow with PKCE S256, random state, and a temporary random-port listener bound only to `127.0.0.1`. Sign-in can be cancelled and expires after five minutes.

If you already saved a client at `~/.config/multi-calendar/google-desktop-client.json`, **Use saved client** imports it. This path is optional; the file picker accepts a downloaded client from any location. Each self-builder supplies their own client. Disconnect every account before replacing the client configuration.

### Google Cloud setup

1. Create or select a [Google Cloud project](https://console.cloud.google.com/).
2. Enable **Google Calendar API** in APIs & Services.
3. Configure Google Auth Platform branding with an app name, support email, and contact email. For personal development, choose **External** audience and leave publishing status at **Testing**.
4. Add every Google account you intend to connect under **Audience → Test users**, including Workspace accounts. Workspace administrators may also restrict third-party OAuth access.
5. In **Data Access**, add these scopes:

   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events`

6. Create an OAuth client with application type **Desktop app**, download its JSON, and import it in Settings. A Web client is not accepted. Desktop loopback redirects do not require manually registering a fixed localhost port.
7. Allow both Calendar permissions during sign-in. Google may show an unverified-app notice for your own testing project.

With External apps in Testing, refresh tokens for these Calendar scopes normally expire after **seven days**. Reconnect when prompted. Moving to production and distributing a shared client can require Google verification, branding URLs, and additional policy work. See [Google's OAuth testing documentation](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

Never commit client JSON, refresh/access tokens, personal calendar exports, or local databases. An installed application's client secret cannot be kept confidential by distributing it with an app; it does not replace PKCE or secure token storage.

### Browser demo

```sh
pnpm dev
```

Open `http://127.0.0.1:1420`. Browser preview uses local demo calendars and browser storage. Google OAuth and API requests run exclusively in Rust in the desktop app.

## Calendar behavior

- Day, Week, Month (all 42 cells), and 30-day Schedule views download complete UTC month buckets covering the visible dates. All pages are fetched before a bucket is replaced transactionally; copies are deduplicated by account, calendar, and event.
- Visible calendars refresh every 60 seconds while foregrounded and when focus returns. Use the refresh button for an immediate refresh, including calendar metadata. There is no speculative date prefetch or bounded-query `syncToken` use.
- Requests are limited to four globally and two per account, with coalescing and backoff. One account's failure does not clear another account's data. The status banner distinguishes missing coverage and failed refreshes from an empty calendar.
- Search covers **downloaded dates** across visible calendars. It does not query all of Google Calendar. Cached events remain available offline; writes require a connection and are never queued for automatic offline replay.
- Names, calendar colors, time zones, and permissions come from Google. Calendar visibility is an app-local preference. All-day dates keep their original date boundaries; timed view boundaries use the selected display zone.

### Editing and recurrence

The app permits edits only when it can verify that the calendar is writable and the event is an ordinary, guest-free event organized by that calendar. Guest-bearing meetings, attendee copies, private/redacted/locked resources, and special Google event types are read-only. **Open in Google Calendar** is available in event details. Rust rechecks eligibility before every write.

New events can choose a writable calendar. Existing Google events keep their calendar. Updates send only explicit changed fields; clearing a description or location sends a null. Unchanged descriptions, reminders, conference data, attachments, and other Google metadata are preserved natively. Drag and resize send timing changes for a single occurrence.

Common recurrence controls support daily, weekly with selected weekdays, monthly by date, and yearly by month/date, with intervals and never/count/until endings. Google skips nonexistent monthly/yearly dates rather than clamping them. Timed recurrence preserves an IANA time zone; all-day ends are exclusive.

Select **This occurrence** or **Whole series** in a recurring event's details. Whole-series editing loads the parent's original anchor. Before a whole-series action, the app fetches the complete, paginated, unexpanded family and checks its eligibility. Guest-bearing or unverifiable families remain read-only. Existing exceptions prevent whole-series timing/rule changes; eligible metadata changes and deletion remain available. Complex imported rules are preserved and their schedule controls are disabled.

Updates and deletes use `If-Match` with the expected ETag. If another client changed the event, close the editor and refresh before trying again. Creation attempts use stable Google-compatible IDs. If a response is uncertain, the app persists a recovery receipt and checks Google before a retry. Settings can reconcile previous writes or retry their original attempt after a restart. A confirmed remote write whose cache update failed is reported separately; refreshing does not create another copy.

Calendar-to-calendar moves, RSVP management, offline write queues, and “this and following” are deferred.

## Storage and disconnect

**Local file is the default credential storage on every desktop platform.** Refresh tokens are saved unencrypted in `google-refresh-tokens.json` in the native application-data directory, with access restricted to your operating-system user. The directory and files use `0700` and `0600` permissions on Unix; Windows uses a current-user access-control list. Native file locking and atomic replacement protect updates from concurrent app instances. Local mode never reads, writes, or deletes system credential-store entries. Both `pnpm tauri dev` and the static dev builds share these files and remain signed in across restarts.

Choose **Settings → Google accounts → Credential storage → System credential store** to use **macOS Keychain**, **Windows credential storage**, or **Linux Secret Service** instead. Changing storage waits for active Google operations to finish, then applies without restarting and clears in-memory credentials. Tokens are not copied between stores, and credentials in the inactive store are left untouched. Accounts with no token in the selected store need **Reconnect**; cached calendars, events, and pending write receipts are preserved. Existing installations default to local storage and require one reconnection per account; their old system credentials are never migrated automatically.

Access tokens remain in Rust memory. Tokens are never returned to React, logged, or stored in SQLite/frontend storage. Storage failures never fall back to another backend or overwrite a damaged token file. For local-file errors, check permissions and disk space, restore or remove a damaged token file, and use **Retry credential access** or **Reconnect** as appropriate. When using the Linux system credential store, a running session D-Bus and unlocked Secret Service implementation such as GNOME Keyring are required; builds may require the platform's D-Bus development packages.

When the macOS system credential store is selected, credential operations explicitly prohibit authentication UI. A locked Keychain or an access rule tied to a previous ad-hoc build pauses the account instead of opening password dialogs. After unlocking the login Keychain in Keychain Access, use **Retry credential access** in Settings. If a rebuilt app cannot access an old credential, **Reconnect** through Google replaces only that account’s app-owned entry using the current build’s default Keychain access rules. It does not widen access to other apps or change global Keychain security settings. During a run the refresh token is cached only in native memory, and failed refreshes share an account-level backoff. Stable Developer ID signing avoids per-build identity changes. Never enter your macOS password into the calendar app or a chat.

The native application-data directory holds:

- `google-client.json`: the imported Desktop client configuration.
- `google-credential-settings.json`: the selected native credential-storage backend.
- `google-refresh-tokens.json` and `google-refresh-tokens.lock`: local refresh tokens and their cross-process lock, used only in local-file mode.
- `google-cache.sqlite3` and its SQLite sidecars: account/calendar metadata, downloaded event resources, coverage, and mutation recovery receipts. This cache contains personal calendar data and is **not encrypted**; protect your device/user account accordingly.
- `preferences.json`: theme, display zone, navigation, and local calendar visibility.
- `calendar-demo.json`: the older independent demo store, preserved separately.

On macOS the directory is `~/Library/Application Support/com.aziddy.multicalendar/`; other platforms use Tauri's application-data directory. Disconnect cancels account work and removes credentials from the selected store along with the account's metadata, cached events, and receipts. Credentials previously saved in an inactive store are left untouched. It does not delete Google events or revoke the Google Cloud project's grant. To revoke the grant explicitly, use your [Google Account connections](https://myaccount.google.com/connections).

## Build and verify

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm tauri build
```

Unit/native tests cover date boundaries, DST, UTC+14, changed-field preservation, recurrence, OAuth state/PKCE/cancellation, credential failures, token refresh, pagination, transactional replacement, account isolation, disconnect races, conflicts, and uncertain-write recovery. Browser tests use demo data or a mocked native bridge; they do not contact Google or create real events.

For live verification, use your own client and two explicitly allowed test accounts. Create clearly labeled disposable events, verify create/update/delete and recurring occurrence/series actions, edit a test event in Google Calendar, refresh the desktop app, and remove the test events afterward. Also check cached viewing after a restart and loss of connectivity. Never use someone else's meetings as test data.

```sh
# Build and run built assets without a Vite server
pnpm dev:static:fresh
# Launch an existing debug build
pnpm dev:static
# Build a debug native binary without bundling
pnpm build:debug
```

Production bundles are written to `src-tauri/target/release/bundle/`. Build and test installers on their target OS. Signing, notarization, automatic updates, and public binary distribution are not configured.

## License

Copyright © 2026 Alex Zidros. Licensed under **GNU AGPL version 3 only** (`AGPL-3.0-only`); see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This app is independently developed and is not affiliated with or endorsed by Google. Google Calendar is a trademark of Google LLC. No Google logos or proprietary product artwork are bundled.
