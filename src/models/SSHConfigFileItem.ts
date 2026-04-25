import { ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode'

export class SSHConfigFileItem extends TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly label: string,
    public readonly hostCount: number,
    isCollapsed: boolean = false,
  ) {
    let state: TreeItemCollapsibleState
    if (hostCount === 0) {
      state = TreeItemCollapsibleState.None
    }
    else if (isCollapsed) {
      state = TreeItemCollapsibleState.Collapsed
    }
    else {
      state = TreeItemCollapsibleState.Expanded
    }

    super(label, state)
    this.contextValue = 'config-file'
    this.iconPath = new ThemeIcon('file-code')
    this.tooltip = filePath
    this.description = `${hostCount} hosts`
  }
}
