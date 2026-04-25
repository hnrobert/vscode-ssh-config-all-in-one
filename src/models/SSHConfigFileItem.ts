import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode'

export class SSHConfigFileItem extends TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly label: string,
    public readonly hostCount: number,
  ) {
    super(label, hostCount > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None)
    this.contextValue = 'config-file'
    this.iconPath = new ThemeIcon('file-code')
    this.tooltip = filePath
    this.description = `${hostCount} hosts`
  }
}
