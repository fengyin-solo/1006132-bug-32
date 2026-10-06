import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 落库：写失败时重试一次，仍失败就抛给调用方；缓存保持旧值，不沿用写了一半的状态。
function persist(state: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const payload = JSON.stringify(state)
  try {
    window.localStorage.setItem(STORAGE_KEY, payload)
  } catch {
    window.localStorage.setItem(STORAGE_KEY, payload)
  }
}

/**
 * 一次提交多个模块的改动：先整体落库，落库成功才换缓存。
 * 任何一个键写不进去都会抛错，缓存不动，等于一并回滚。
 */
export function saveModules(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  persist(next)
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveModules({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
