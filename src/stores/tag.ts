import { Tag, delTag, getTags } from '@/db/tags'
import { Store } from '@tauri-apps/plugin-store'
import { create } from 'zustand'

interface TagState {
  currentTagId: number
  setCurrentTagId: (id: number) => Promise<void>
  initTags: () => Promise<void>

  currentTag?: Tag
  getCurrentTag: () => void

  tags: Tag[]
  fetchTags: () => Promise<void>

  deleteTag: (id: number) => Promise<void>
}

const useTagStore = create<TagState>((set, get) => ({
  // 当前选择的 tag
  currentTagId: 1,
  setCurrentTagId: async(currentTagId: number) => {
    set({ currentTagId })
    const store = await Store.load('store.json');
    await store.set('currentTagId', currentTagId)
  },
  initTags: async () => {
    const store = await Store.load('store.json');
    const currentTagId = await store.get<number>('currentTagId')
    if (currentTagId) set({ currentTagId })
    get().getCurrentTag()
  },

  currentTag: undefined,
  getCurrentTag: () => {
    const tags = get().tags
    const getcurrentTagId = get().currentTagId
    const currentTag = tags.find((tag) => tag.id === getcurrentTagId)
    if (currentTag) {
      set({ currentTag })
    }
  },

  // 所有 tag
  tags: [],
  fetchTags: async () => {
    const tags = await getTags()
    set({ tags })
  },

  deleteTag: async (id: number) => {
    await delTag(id)
    await get().fetchTags()
    await get().setCurrentTagId(get().tags[0].id)
  },
}))

export default useTagStore
