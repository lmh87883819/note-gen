import { readDir, BaseDirectory, DirEntry } from "@tauri-apps/plugin-fs";
import { getFilePathOptions, getWorkspacePath } from "./workspace";
import { join } from "@tauri-apps/api/path";

export interface MarkdownFile {
  name: string;
  path: string;
  relativePath: string;
}

export interface WorkspaceFile {
  name: string
  path: string
  relativePath: string
}

// 收集文件夹下的所有 Markdown 文件
export async function collectMarkdownFiles(folderPath: string): Promise<Array<{path: string, name: string}>> {
  const files: Array<{path: string, name: string}> = [];
  
  const processDirectory = async (dirPath: string) => {
    try {
      const workspace = await getWorkspacePath();
      const pathOptions = await getFilePathOptions(dirPath);
      
      let entries;
      if (workspace.isCustom) {
        entries = await readDir(pathOptions.path);
      } else {
        entries = await readDir(pathOptions.path, { baseDir: pathOptions.baseDir });
      }
      
      for (const entry of entries) {
        const entryPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        
        // 过滤隐藏文件夹
        if (entry.name.startsWith('.')) {
          continue;
        }
        
        if (entry.isDirectory) {
          // 递归处理子目录
          await processDirectory(entryPath);
        } else if (entry.name.endsWith('.md')) {
          // 添加 Markdown 文件
          files.push({
            path: entryPath,
            name: entry.name
          });
        }
      }
    } catch (error) {
      console.error(`读取目录 ${dirPath} 失败:`, error);
    }
  };
  
  await processDirectory(folderPath);
  return files;
}

/**
 * 获取工作区中所有Markdown文件（平铺所有文件夹）
 */
export async function getAllMarkdownFiles(): Promise<MarkdownFile[]> {
  const workspace = await getWorkspacePath();
  const files: MarkdownFile[] = [];
  
  // 递归处理目录的辅助函数
  async function processDirectory(dirPath: string, useCustomPath: boolean, relativePath: string = ""): Promise<void> {
    let entries: DirEntry[];
    
    if (useCustomPath) {
      entries = await readDir(dirPath);
    } else {
      entries = await readDir(dirPath, { baseDir: BaseDirectory.AppData });
    }
    
    for (const entry of entries) {
      // 跳过隐藏文件和文件夹
      if (entry.name === '.DS_Store' || entry.name.startsWith('.')) continue;
      
      const currentRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      
      if (entry.isDirectory) {
        // 递归处理子目录
        const childPath = await join(dirPath, entry.name);
        await processDirectory(childPath, useCustomPath, currentRelativePath);
      } else if (entry.name.endsWith('.md')) {
        // 添加Markdown文件
        const fullPath = useCustomPath 
          ? await join(dirPath, entry.name)
          : currentRelativePath;
        
        files.push({
          name: entry.name,
          path: fullPath,
          relativePath: currentRelativePath
        });
      }
    }
  }
  
  // 开始处理根目录
  const rootPath = workspace.isCustom ? workspace.path : 'article';
  await processDirectory(rootPath, workspace.isCustom);
  
  return files;
}

/**
 * 获取工作区中所有文件（包含图片/任意后缀）
 */
export async function getAllWorkspaceFiles(): Promise<WorkspaceFile[]> {
  const workspace = await getWorkspacePath()
  const files: WorkspaceFile[] = []

  async function processDirectory(dirPath: string, useCustomPath: boolean, relativePath: string = ""): Promise<void> {
    let entries: DirEntry[]

    if (useCustomPath) {
      entries = await readDir(dirPath)
    } else {
      entries = await readDir(dirPath, { baseDir: BaseDirectory.AppData })
    }

    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name.startsWith('.')) continue

      const currentRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name

      if (entry.isDirectory) {
        const childPath = await join(dirPath, entry.name)
        await processDirectory(childPath, useCustomPath, currentRelativePath)
      } else {
        const fullPath = useCustomPath
          ? await join(dirPath, entry.name)
          : currentRelativePath

        files.push({
          name: entry.name,
          path: fullPath,
          relativePath: currentRelativePath,
        })
      }
    }
  }

  const rootPath = workspace.isCustom ? workspace.path : 'article'
  await processDirectory(rootPath, workspace.isCustom)

  return files
}
