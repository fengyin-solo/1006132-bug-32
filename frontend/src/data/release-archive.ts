// 出厂留档：历史已出厂的管片按当时执行的口径留档，单独一个 storage key，
// 与业务数据分开，重算口径时只追加、不覆盖，重复执行也只落一条。
const ARCHIVE_KEY = 'shield-tunnel-construction:segment-release-archive'

export type ReleaseArchiveEntry = {
  segmentId: number
  管片编号: string
  standard: string // 出厂时执行的口径
  archivedAt: string // 留档时间（ISO）
}

export type ReleaseArchive = {
  marker: string | null // 当前生效的口径标识，用于判断要不要重算存量
  standardLabel: string | null // 当前生效口径的说明文字
  entries: ReleaseArchiveEntry[]
}

function emptyArchive(): ReleaseArchive {
  return { marker: null, standardLabel: null, entries: [] }
}

function readArchive(): ReleaseArchive {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyArchive()
  }
  const raw = window.localStorage.getItem(ARCHIVE_KEY)
  if (!raw) {
    return emptyArchive()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReleaseArchive>
    return {
      marker: parsed.marker ?? null,
      standardLabel: parsed.standardLabel ?? null,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    }
  } catch {
    return emptyArchive()
  }
}

let cache: ReleaseArchive | null = null

export function loadReleaseArchive(): ReleaseArchive {
  if (cache === null) {
    cache = readArchive()
  }
  return cache
}

export function saveReleaseArchive(archive: ReleaseArchive): void {
  cache = archive
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive))
  }
}

export function isReleaseArchived(segmentId: number): boolean {
  return loadReleaseArchive().entries.some((entry) => entry.segmentId === segmentId)
}
