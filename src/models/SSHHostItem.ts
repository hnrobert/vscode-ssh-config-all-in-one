import { ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode'

export class SSHHostItem extends TreeItem {
  constructor(
    public readonly hostName: string,
    public readonly description: string | undefined,
    public readonly configFile: string,
    public readonly lineNumber: number | undefined,
    hasRecentFolders: boolean,
    isConnected: boolean = false,
    isCollapsed: boolean = false,
    nonce?: number,
  ) {
    // Determine collapsible state based on whether it has folders and collapse state
    let state: TreeItemCollapsibleState
    if (!hasRecentFolders) {
      state = TreeItemCollapsibleState.None
    }
    else if (isCollapsed) {
      state = TreeItemCollapsibleState.Collapsed
    }
    else {
      state = TreeItemCollapsibleState.Expanded
    }

    super(hostName, state)
    this.id = nonce != null ? `${configFile}:${hostName}::${nonce}` : `${configFile}:${hostName}`
    this.contextValue = isConnected ? 'host-connected' : 'host'

    // Use 'vm-active' icon with green color for connected hosts
    if (isConnected) {
      this.iconPath = new ThemeIcon('vm-active', new ThemeColor('charts.green'))
      this.tooltip = `SSH Host: ${hostName} (Connected)`
    }
    else {
      this.iconPath = new ThemeIcon('vm')
      this.tooltip = `SSH Host: ${hostName}`
    }

    this.description = description
  }
}
