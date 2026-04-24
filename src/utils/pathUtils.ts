export function replaceHomeDirectory(path: string): string {
  // Replace home directory with ~ for better readability
  // Linux/macOS: /home/username/... or /Users/username/...
  // Windows: /c:/Users/username/... or C:\Users\username\...

  // Handle URL-encoded paths
  const decodedPath = decodeURIComponent(path)

  // Linux: /home/username/...
  const linuxMatch = /^\/home\/[^/]+\/(.*)$/.exec(decodedPath)
  if (linuxMatch) {
    return `~/${linuxMatch[1]}`
  }

  // macOS: /Users/username/...
  const macMatch = /^\/Users\/[^/]+\/(.*)$/.exec(decodedPath)
  if (macMatch) {
    return `~/${macMatch[1]}`
  }

  // Windows: /c:/Users/username/... or C:\Users\username\...
  const winMatch = /^\/[a-z]:\/Users\/[^/]+\/(.*)$/i.exec(decodedPath)
  if (winMatch) {
    return `~/${winMatch[1]}`
  }

  // If just home directory
  if (decodedPath === '/home' || decodedPath === '/Users' || /^\/[a-z]:\/Users$/i.test(decodedPath)) {
    return '~'
  }

  // If path is just /home/username or /Users/username
  if (/^\/home\/[^/]+$/.test(decodedPath) || /^\/Users\/[^/]+$/.test(decodedPath)) {
    return '~'
  }

  return decodedPath
}

export function getBaseName(path: string): string {
  // Get the last part of the path as the folder name
  const decodedPath = decodeURIComponent(path)
  const parts = decodedPath.split('/').filter(p => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}
