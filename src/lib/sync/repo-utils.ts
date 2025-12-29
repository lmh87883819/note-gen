import { RepoNames } from './github.types'
import { Store } from '@tauri-apps/plugin-store'

/**
 * 获取图床仓库名称（仅支持GitHub）
 * @returns GitHub图床仓库名称
 */
export async function getImageRepoName(): Promise<string> {
  const store = await Store.load('store.json')
  const customRepoName = (await store.get<string>('githubCustomImageRepo')) || ''
  return customRepoName.trim() || RepoNames.image
}
