import { ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode'
import { getBaseName, replaceHomeDirectory } from '../utils/pathUtils'

export class SSHFolderItem extends TreeItem {
  constructor(
    public readonly hostName: string,
    public readonly folder: string,
    isConnected: boolean = false,
    public readonly configFile?: string,
  ) {
    // Use folder name as label, full path as description
    const folderName = getBaseName(folder)
    const displayPath = replaceHomeDirectory(folder)

    super(folderName, TreeItemCollapsibleState.None)
    this.id = `${hostName}:${folder}`
    this.contextValue = isConnected ? 'folder-connected' : 'folder'

    // Use green color for connected folder
    if (isConnected) {
      this.iconPath = new ThemeIcon('folder', new ThemeColor('charts.green'))
      this.tooltip = `${hostName}:${displayPath} (Connected)`
    }
    else {
      this.iconPath = new ThemeIcon('folder')
      this.tooltip = `${hostName}:${displayPath}`
    }

    this.description = displayPath
  }
}
