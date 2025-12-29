import { getAllMarks, getMarks, Mark, updateMark } from '@/db/marks'
import { Store } from '@tauri-apps/plugin-store';
import { create } from 'zustand'

export interface MarkQueue {
  queueId: string
  tagId: number
  type: Mark["type"]
  progress: string
  startTime: number
}

interface MarkState {
  trashState: boolean
  setTrashState: (flag: boolean) => void

  marks: Mark[]
  updateMark: (mark: Mark) => Promise<void>
  setMarks: (marks: Mark[]) => void
  fetchMarks: () => Promise<void>
  fetchAllTrashMarks: () => Promise<void>

  allMarks: Mark[]
  fetchAllMarks: () => Promise<void>

  queues: MarkQueue[]
  addQueue: (mark: MarkQueue) => void
  setQueue: (queueId: string, mark: Partial<MarkQueue>) => void
  removeQueue: (queueId: string) => void

  // 多选状态
  selectedMarkIds: Set<number>
  setSelectedMarkIds: (ids: Set<number>) => void
  toggleMarkSelection: (id: number) => void
  clearSelection: () => void
  selectAll: () => void
  isMultiSelectMode: boolean
  setMultiSelectMode: (mode: boolean) => void
}

const useMarkStore = create<MarkState>((set, get) => ({
  trashState: false,
  setTrashState: (flag) => {
    set({ trashState: flag })
  },

  marks: [],
  updateMark: async (mark) => {
    set((state) => {
      return {
        marks: state.marks.map(item => {
          if (item.id === mark.id) {
            return {
              ...item,
              ...mark
            }
          }
          return item
        })
      }
    })
    await updateMark(mark)
  },
  setMarks: (marks) => {
    set({ marks })
  },
  fetchMarks: async () => {
    const store = await Store.load('store.json');
    const currentTagId = await store.get<number>('currentTagId')
    if (!currentTagId) {
      return
    }
    const res = await getMarks(currentTagId)
    const decodeRes = res.map(item => {
      return {
        ...item,
        content: item.content || ''
      }
    }).filter((item) => item.deleted === 0)
    set({ marks: decodeRes })
  },
  fetchAllTrashMarks: async () => {
    const res = await getAllMarks()
    const decodeRes = res.map(item => {
      return {
        ...item,
        content: item.content || ''
      }
    }).filter((item) => item.deleted === 1)
    set({ marks: decodeRes })
  },

  allMarks: [],
  fetchAllMarks: async () => {
    const res = await getAllMarks()
    const decodeRes = res.map(item => {
      return {
        ...item,
        content: item.content || ''
      }
    }).filter((item) => item.deleted === 0)
    set({ allMarks: decodeRes })
  },

  queues: [],
  addQueue: (mark) => {
    set((state) => {
      return {
        queues: [mark, ...state.queues]
      }
    })
  },
  setQueue: (queueId, mark) => {
    set((state) => {
      return {
        queues: state.queues.map(item => {
          if (item.queueId === queueId) {
            return {
              ...item,
              ...mark
            }
          }
          return item
        })
      }
    })
  },
  removeQueue: (queueId) => {
    set((state) => {
      return {
        queues: state.queues.filter(item => item.queueId !== queueId)
      }
    })
  },

  // 多选状态
  selectedMarkIds: new Set<number>(),
  setSelectedMarkIds: (ids) => {
    set({ selectedMarkIds: ids })
  },
  toggleMarkSelection: (id) => {
    set((state) => {
      const newSelectedIds = new Set(state.selectedMarkIds)
      if (newSelectedIds.has(id)) {
        newSelectedIds.delete(id)
      } else {
        newSelectedIds.add(id)
      }
      return { selectedMarkIds: newSelectedIds }
    })
  },
  clearSelection: () => {
    set({ selectedMarkIds: new Set<number>(), isMultiSelectMode: false })
  },
  selectAll: () => {
    const { marks } = get()
    const allIds = new Set(marks.map(mark => mark.id))
    set({ selectedMarkIds: allIds, isMultiSelectMode: true })
  },
  isMultiSelectMode: false,
  setMultiSelectMode: (mode) => {
    set({ isMultiSelectMode: mode })
    if (!mode) {
      set({ selectedMarkIds: new Set<number>() })
    }
  },
}))

export default useMarkStore
