# SSH Config All-In-One

[![Visual Studio Marketplace](https://flat.badgen.net/vs-marketplace/i/HNRobert.vscode-ssh-config-all-in-one?icon=visualstudio)](https://marketplace.visualstudio.com/items?itemName=HNRobert.vscode-ssh-config-all-in-one)
[![GitHub](https://flat.badgen.net/github/release/hnrobert/vscode-ssh-config-all-in-one?icon=github)](https://github.com/hnrobert/vscode-ssh-config-all-in-one)
[![Apache License](https://flat.badgen.net/badge/license/Apache-2.0/blue)](LICENSE)
[![Open Issues](https://flat.badgen.net/github/open-issues/hnrobert/vscode-ssh-config-all-in-one?icon=github)](https://github.com/hnrobert/vscode-ssh-config-all-in-one/issues)
[![Closed Issues](https://flat.badgen.net/github/closed-issues/hnrobert/vscode-ssh-config-all-in-one?icon=github)](https://github.com/hnrobert/vscode-ssh-config-all-in-one/issues?q=is%3Aissue+is%3Aclosed)

<p align="center"><img src="docs/images/icon.png" alt="logo" width="128" /></p>

> Enhanced SSH Config Language Server extension for Visual Studio Code. Provides autocompletion, syntax highlighting, formatting, go to include file definitions, hover support, and quick connection actions for SSH config directives.

![overall-demo](docs/images/overall-demo.png)

## Features

- **SSH Host Explorer**: A dedicated activity bar panel that lists all your SSH hosts organized by config file, with inline actions to connect, edit, search, and manage hosts.
  - ![open-in-config-demo](docs/images/open-in-config-demo.png)
- **Recent Folders**: The explorer shows recently connected remote folders under each host. Folders are loaded from VS Code's connection history and persist across sessions. Right-click any folder to permanently remove it from the list.
- **Copy SSH Commands**: Right-click any host in the explorer to copy connection info to the clipboard:
  - **Copy Host Alias** — copies the host alias for use with `ssh <alias>`
  - **Copy SSH Command** — builds and copies the full command from the config (e.g. `ssh user@hostname -p 2222 -i ~/.ssh/key`)
    ![copy-ssh-command-demo](docs/images/copy-ssh-command-demo.png)
- **Quick Connect CodeLens**: Provides "Connect in Current Window..." and "Connect in New Window..." inline buttons above each `Host` declaration. Seamlessly connects to the server using the official `ms-vscode-remote.remote-ssh` extension.
  - ![quick-connect-code-lens-demo](docs/images/quick-connect-code-lens-demo.png)
- **SSH Config Auto-Detection**: Files whose name contains "config" are automatically detected as SSH Config when their content matches SSH Config patterns (e.g. `Host`, `HostName`, `IdentityFile` directives). Can be disabled via `sshConfigAllInOne.detection.enabled`.
- **Fuzzy Host Search**: The search command supports relevance-ranked matching with extended syntax:

  | Input                        | Behavior                                                    |
  |------------------------------|-------------------------------------------------------------|
  | `prod`                       | fuzzy match — finds `prod-api`, `production`, `my-prod-box` |
  | `prod jump`                  | AND — host must match both tokens                           |
  | `"prod-api"` or `'prod-api'` | exact phrase match                                          |
  | `^prod`                      | prefix — alias starts with `prod`                           |
  | `.example.com$`              | suffix — hostname ends with `.example.com`                  |
  | `!bastion`                   | exclude hosts matching `bastion`                            |
  | `prod \| staging`            | OR — matches either                                         |

  Switch back to simple substring matching via `sshConfigAllInOne.search.mode: simple`.
- **Universal Formatter**: Formats your SSH config regardless of where it's opened (local, remote workspace, or even unsaved untitled files).
- **Autocompletion**: Provides rich suggestions as you type in an SSH config file.
- **Syntax Highlighting**: Enhanced and refined syntax grammar.
- **Hover Support**: Hover over any keyword to see a brief description of its function.
- **Go To Definition**: Supports clicking through `Include` statements.
- **Customizable Formatting**: Automatically indent directives under `Host` and `Match` blocks. Controlled via the `sshConfigAllInOne.format.indentSize` setting.

## Compatibility

Having other SSH config extensions enabled at the same time leads to duplicate completions, hovers, and highlighting:

- [Remote - SSH: Editing Configuration Files](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh-edit) — Microsoft's official extension, registers the same `ssh_config` language and keyword completions.
- [SSH Config Enhanced](https://marketplace.visualstudio.com/items?itemName=jamief.vscode-ssh-config-enhanced) — the upstream project this extension is based on, registers the same completions, hover, links, and formatting providers.

This extension fully replaces both. Disable them in the Extensions view to avoid the conflict.

## Formatting Example

Before:

```properties
Host example
HostName ssh.example.com
User admin
Port 22
IdentityFile ~/.ssh/mykey
```

After (using default 2 spaces):

```properties
Host example
  HostName ssh.example.com
  User admin
  Port 22
  IdentityFile ~/.ssh/mykey
```

## Settings

- `sshConfigAllInOne.format.indentSize`: The number of spaces used for indentation when formatting `Host` and `Match` blocks. (Default: `2`)
- `sshConfigAllInOne.config.additionalFiles`: Additional SSH config file paths to show in the explorer. Supports `~` for home directory.
- `sshConfigAllInOne.config.excludeDefaultFiles`: Default SSH config file paths to exclude from the explorer.
- `sshConfigAllInOne.detection.enabled`: Automatically detect files as SSH Config when the filename contains "config" and the content matches SSH Config patterns. (Default: `true`)
- `sshConfigAllInOne.include.mode`: How to handle hosts from files discovered via `Include` directives — `merge` (add to parent), `separate` (show as own entry), or `none`. (Default: `separate`)
- `sshConfigAllInOne.include.maxDepth`: How many levels of `Include` directives to follow — `0`, `1`, or `unlimited`. (Default: `unlimited`)
- `sshConfigAllInOne.search.mode`: Search mode for the host explorer — `fuzzy` (multi-token, quoted phrases, prefix/suffix/exclude operators, relevance ranking) or `simple` (original substring match). (Default: `fuzzy`)
- `sshConfigAllInOne.search.onAccept`: What happens when you select a host from the search results — `revealInExplorer` (reveal in the panel), `openConfig` (open the config file at the host definition), or `both`. (Default: `revealInExplorer`)
- `sshConfigAllInOne.copyKey.windowsUserType`: When copying a public key to a Windows host, how to treat the target account — `ask` (prompt each time), `regular` (always copy to `~/.ssh/authorized_keys`), or `admin` (always treat as administrator and choose the destination). Administrators read keys from `C:\ProgramData\ssh\administrators_authorized_keys` by default, not the user home. (Default: `ask`)

## Tips

It is recommended to move the `SSH Config All In One` panel from the separate `SSH Config All In One` view into the `Remote Explorer` container for easier access alongside your file explorer and remote connections. To do this, click, hold and drag the `SSH Config All In One` icon in the activity bar and drop it into the `Remote Explorer` panel. This may save you a slot in the activity bar and provide a more seamless experience when managing your SSH hosts and connections.

![move-panel-demo](docs/images/move-panel-demo.png)

## Acknowledgements

This project is deeply based on the fantastic work by [jamief](https://github.com/jamief) on [vscode-ssh-config-enhanced](https://github.com/jamief/vscode-ssh-config-enhanced). Thanks for providing the original repository and all of its underlying core language features.
