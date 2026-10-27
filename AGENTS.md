# Repository guidance

## Project and layout

Multi Calendar is a public, AGPL-3.0-only desktop calendar built with Tauri 2, Rust,
React, TypeScript, and Vite. macOS is the primary target; Windows and Linux
credential-store integrations still need verification on their respective systems.
Read `README.md` for setup, supported behavior, and known limitations.

- `src/components/`, `src/App.tsx`, and the CSS files implement the interface.
- `src/domain/` owns calendar types, date calculations, display helpers, and recurrence.
- `src/data/` owns repositories, fictional demo fixtures, preference storage, and sync.
- `src/store.ts` owns Zustand preferences; TanStack Query manages repository queries.
- `src-tauri/src/google/` owns native OAuth, credential storage, SQLite caching, sync,
  and Google event writes. `src-tauri/src/lib.rs` registers the native commands.
- Colocated `src/**/*.test.ts` files use Vitest; `tests/` uses Playwright with demo
  data or a mocked native bridge. Native tests use synthetic data and local services.
- `docs/` and `THIRD_PARTY_NOTICES.md` contain public assets and dependency notices.

## Setup and development

Use Node.js >=22.22.2, pnpm 10.28.2 as pinned in `package.json`, Rust >=1.90, and
the Tauri platform prerequisites. Use pnpm rather than introducing another package
manager or lockfile. If the installed pnpm version differs, use Corepack or invoke
`npx --yes pnpm@10.28.2` in place of `pnpm` without changing the project pin.

```sh
pnpm install --frozen-lockfile
pnpm dev                   # Browser demo at http://127.0.0.1:1420
pnpm tauri dev             # Native desktop app with Vite
pnpm dev:static:fresh       # Rebuild and launch the debug app with built assets
pnpm build                 # Frontend production assets
pnpm build:debug           # Debug native binary without bundling
pnpm tauri build           # Native production bundles
```

Browser mode uses independent fictional demo data and browser storage. Google OAuth
and API calls run only in the native desktop app. Do not use the desktop app's
existing personal accounts or cache as development fixtures.

## Implementation rules

- Follow the existing TypeScript strictness and Prettier configuration: single
  quotes, no semicolons, trailing commas, and a 100-column print width. Format Rust
  with `cargo fmt`. Keep changes focused and preserve unrelated work.
- Keep date logic in the domain helpers and use the existing Temporal polyfill.
  All-day values are date strings with exclusive ends; timed values are ISO instants
  with an IANA time zone. Preserve DST behavior and untouched timestamp precision.
- Keep demo and native repositories separate behind the existing repository
  interface. Update both sides of the Tauri bridge together when changing commands
  or serialized types. Do not expose tokens or raw Google resource metadata to React.
- Preserve complete, paginated UTC month-bucket replacement, account isolation,
  request limits, cancellation, backoff, and the distinction between missing coverage
  and an empty calendar. Search covers downloaded dates.
- Enforce write eligibility in Rust as well as the UI. Preserve guest/read-only
  restrictions, recurrence and exception checks, changed-field-only updates, ETag
  preconditions, stable create IDs, and recovery receipts for uncertain writes.
  Do not introduce automatic offline write replay or calendar-to-calendar moves.
- Keep access tokens in Rust memory and refresh tokens in secure OS storage. There
  is no plaintext token fallback. Preserve noninteractive macOS credential access;
  do not weaken Keychain rules, Tauri capabilities, or CSP to bypass a failure.
- Preserve keyboard access, accessible names, and dialog behavior when changing UI.
  Update the README when supported behavior or setup changes.

## Public-repository privacy

- Treat source, fixtures, documentation, screenshots, test artifacts, logs, commit
  messages, and PR descriptions as potentially public. Use fictional names and
  reserved example domains such as `example.com` or `example.test`; for example,
  `Demo User` and `demo@example.test`.
- Use repository-relative paths, `~`, or placeholders such as `<repo>` and `<user>`
  in public material. Do not copy personal filesystem paths, workstation-specific
  SSH aliases, private repository URLs, or identifying account/project details into
  the repository or public reports.
- Never commit OAuth client JSON, real client configuration, access/refresh tokens,
  private keys, personal calendar exports, local databases or SQLite sidecars.
  Encoding, hashing, partially masking, or renaming a secret does not make it safe
  to publish. Keep private files out of Git rather than committing disguised copies.
- Reproduce bugs with synthetic data and mocked services. Inspect screenshots and
  diagnostics before sharing them, replacing private names, emails, calendar/event
  IDs, event contents, addresses, meeting links, and credential values as needed.
  Report a sensitive finding by file and line without repeating its value.
- Live Google tests require an explicitly authorized task and allowed test accounts.
  Use clearly labeled disposable events and remove them afterward. Keep ignored live
  OS credential smoke tests opt-in; never inspect personal credential stores as part
  of routine verification.
- Preserve intentional public author/license attribution, upstream license notices,
  and stable application/credential-store identifiers. Do not anonymize these as an
  incidental cleanup: changing identifiers can strand existing data and credentials.

## Verification

Choose checks that exercise the changed behavior. For frontend changes, run the
type, lint, and formatting checks plus relevant Vitest tests. For UI interactions
or bridge changes, also run the affected Playwright suite. Native changes require
the native checks; bridge changes need coverage on both sides.

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec prettier --check AGENTS.md
pnpm test
pnpm exec playwright install chromium # If the browser is not already installed
pnpm test:e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

Use `pnpm exec vitest run <test-file>` or
`pnpm exec playwright test <test-file>` for focused verification. The current
`format:check` script does not include this guide, so check it explicitly.
Documentation-only changes need formatting, link, and privacy review rather than
native builds. Do not claim platform or live-account verification that was not run.
Before finishing, review the full diff, run `git diff --check`, check for private
data, and report the checks performed and any failures or limitations.

## Dependencies and licensing

Preserve the AGPL-3.0-only license, copyright notices, and SPDX headers. Keep
`pnpm-lock.yaml` and `src-tauri/Cargo.lock` consistent with dependency changes.
Update JavaScript notices when the production dependency tree changes. After Cargo
dependency changes, run `python3 scripts/update-native-notices.py` and review the
generated native inventory and license texts. Preserve the bundled notice resources
and the project's independent Google branding.
