# Linux / Ubuntu

SessionKit's CLI and installer are portable Unix code. Rust CI now includes
Ubuntu; release automation builds a Linux x86_64 archive on Ubuntu 22.04, in
addition to the existing macOS archives. Linux archives are glibc builds, not
static musl binaries; Ubuntu 22.04+ is the intended binary installation baseline.
A newly added release target does not retroactively add assets to older releases.

## Build and install

Use a current stable Rust toolchain (some parser dependencies require recent
Rust). On Ubuntu:

```sh
sudo apt-get update
sudo apt-get install build-essential git curl
# Install/update Rust with rustup from https://rustup.rs if needed.
git clone https://github.com/janegbert/sessionkit.git
cd sessionkit
cargo install --path . --locked
export PATH="$HOME/.cargo/bin:$PATH"
sessionkit --help
sessionkit setup
```

Install Claude Code separately and restart it after setup. Plugin features still
require Claude Code function-hook support; a working Rust CLI does not guarantee
that an older Claude installation supports those hooks.

`sessionkit usage` needs no API key, but needs existing Claude Code transcripts
in `~/.claude/projects`. If none exist, it reports that rather than producing a
usage report. Setup preserves unrelated settings and can be removed with
`sessionkit setup --remove`.

## Credentials

For a desktop Ubuntu installation:

```sh
sudo apt-get install libsecret-tools
sessionkit auth login
sessionkit auth status
```

Login prompts without echo and uses `secret-tool` to store the TypeSafe key in
Linux Secret Service. A running Secret Service and an unlocked desktop keyring
are required (for example GNOME Keyring). There is no plaintext-file fallback;
the secret is piped to the helper, not included in process arguments.
`sessionkit auth logout` removes the stored key but does not unset environment
variables or remove 1Password items.

For headless Ubuntu, containers or CI, supply `TYPESAFE_API_KEY` through your
shell/CI secret manager. It takes precedence over a stored key. An explicitly
configured `SESSIONKIT_OP_REFERENCE=op://vault/item/field` can also use the
1Password CLI. Do not expect desktop-keyring login to work on a headless server.
Other decision providers currently use environment credentials; see
[decision providers](decision-providers.md).

## Platform-specific features

- `sessionkit next`'s automatic shell handoff requires zsh, even on Linux. Bash
  users can use `sessionkit start` directly; setup does not modify `.bashrc`.
- The optional jcode clipboard fallback uses `wl-copy` on Wayland or `xclip` on
  X11 (`wl-clipboard` / `xclip` Ubuntu packages). An unavailable clipboard no
  longer prevents launching the session.
- macOS continues to use Keychain and `pbcopy`.

## Diagnostics and verification

When reporting an Ubuntu failure, include the Ubuntu version, install method,
`sessionkit --help` result, failing command/error and Claude Code version. Never
include API keys or full confidential transcripts. The reported failure from a
user's friend has not yet been reproduced because those details are missing.

```sh
cargo test --locked
cargo build --locked
python3 eval/platform_smoke.py target/debug/sessionkit
```

The smoke test uses a temporary HOME and synthetic transcript, installs twice
(to check idempotence), removes the integration and checks unrelated settings
survive. It does not modify your real Claude installation or contact providers.
Desktop keyring behavior and real Claude function hooks require separate live
checks; CLI smoke tests alone do not verify them.
