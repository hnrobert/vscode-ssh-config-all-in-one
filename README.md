# SSH Config All-In-One

> Enhanced SSH Config Language Server extension for Visual Studio Code. Provides autocompletion, syntax highlighting, formatting, go to include file definitions, hover support, and **quick connection actions** for SSH config directives.

## Features

- **Quick Connect CodeLens (New!)**: Provides "Connect in Current Window..." and "Connect in New Window..." inline buttons above each `Host` declaration. Seamlessly connects to the server using the official `ms-vscode-remote.remote-ssh` extension.
- **Universal Formatter**: Formats your SSH config regardless of where it's opened (local, remote workspace, or even unsaved untitled files).
- **Autocompletion**: Provides rich suggestions as you type in an SSH config file.
- **Syntax Highlighting**: Enhanced and refined syntax grammar.
- **Hover Support**: Hover over any keyword to see a brief description of its function.
- **Go To Definition**: Supports clicking through `Include` statements.
- **Customizable Formatting**: Automatically indent directives under `Host` and `Match` blocks. Controlled via the `vscode-ssh-config-all-in-one.format.indentSize` setting.

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

- `vscode-ssh-config-all-in-one.format.indentSize`: The number of spaces used for indentation when formatting `Host` and `Match` blocks. (Default: `2`)

## Acknowledgements

This project is deeply based on the fantastic work by [jamief](https://github.com/jamief) on [vscode-ssh-config-enhanced](https://github.com/jamief/vscode-ssh-config-enhanced). Thanks for providing the original repository and all of its underlying core language features.
