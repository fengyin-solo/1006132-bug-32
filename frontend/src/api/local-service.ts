import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, replaceAllRows, resetRows, saveRows, snapshotRows } from '@/data/local-store'
import {
  isReleaseArchived,
  loadReleaseArchive,
  saveReleaseArchive,
} from '@/data/release-archive'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  RELEASE_STANDARD,
  evaluateRelease,
  releaseStandardLabel,
  releaseStandardMarker,
  type ReleaseState,
} from '@/domain/segment-release'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 办理出厂走统一判定：达不到交付清单口径就挡回去，不许直接改状态。
  if (key === 'segmentprod' && action === '办理出厂') {
    const verdict = evaluateRelease(rows[index])
    if (verdict.state !== '已出厂') {
      return { ok: false, message: `未达到出厂标准：${verdict.reasons.join('、')}` }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/* ---------- 管片出厂：统一判定与统一取数 ---------- */

// 还没到出厂环节的状态，不参与出厂统计。
const PRE_RELEASE_STATUSES = new Set(['待浇筑', '养护中'])

// 管片的出厂结论：生产台账、导出、交付清单、试验检测都从这里取结论。
// 历史已出厂且已留档的保持已出厂；其余按统一口径现场判定。
export function releaseStateOf(row: EntryRow, archived?: ReadonlySet<number>): ReleaseState | null {
  const status = String(row.status)
  if (PRE_RELEASE_STATUSES.has(status)) {
    return null
  }
  const isArchived = archived
    ? archived.has(Number(row.id))
    : isReleaseArchived(Number(row.id))
  if (status === '已出厂' && isArchived) {
    return '已出厂'
  }
  return evaluateRelease(row).state
}

export type ReleaseSummary = {
  pendingRelease: number
  released: number
}

// 待出厂/已出厂台数的唯一算法：两处页面要对的数都出自这里。
export function summarizeRelease(
  rows: EntryRow[] = listRows('segmentprod'),
  archived?: ReadonlySet<number>,
): ReleaseSummary {
  let pendingRelease = 0
  let released = 0
  for (const row of rows) {
    const state = releaseStateOf(row, archived)
    if (state === '待出厂') {
      pendingRelease += 1
    } else if (state === '已出厂') {
      released += 1
    }
  }
  return { pendingRelease, released }
}

// 生产台账用的行：状态列直接给统一判定后的结论，页面不再自己算。
export function canonicalSegmentRows(): EntryRow[] {
  return listRows('segmentprod').map((row) => {
    const state = releaseStateOf(row)
    return state ? { ...row, status: state, pending: state !== '已出厂' } : row
  })
}

export function listCanonicalSegments(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(canonicalSegmentRows(), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export type DeliveryRow = EntryRow & { 出厂判定: string; 判定说明: string }

// 进度节点页的交付清单：与生产台账同一份取数，只是多带一列判定说明。
export function listSegmentDelivery(): DeliveryRow[] {
  return listRows('segmentprod').map((row) => {
    const state = releaseStateOf(row)
    if (state === null) {
      return { ...row, 出厂判定: String(row.status), 判定说明: '未到出厂环节' }
    }
    const verdict = evaluateRelease(row)
    return {
      ...row,
      出厂判定: state,
      判定说明: state === '已出厂' ? RELEASE_STANDARD : verdict.reasons.join('、'),
    }
  })
}

// 已经出厂的管片不许再改钢筋笼批号，越权提交在这里被挡回去。
export function updateSegmentRebarBatch(id: number, batch: string): ActionResult {
  const trimmed = batch.trim()
  if (trimmed === '') {
    return { ok: false, message: '钢筋笼批号不能为空' }
  }
  const rows = listRows('segmentprod')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的管片` }
  }
  if (releaseStateOf(rows[index]) === '已出厂') {
    return { ok: false, message: '管片已出厂，钢筋笼批号不允许再修改' }
  }
  if (String(rows[index]['钢筋笼批号'] ?? '') === trimmed) {
    return { ok: false, message: '钢筋笼批号没有变化，不用重复提交' }
  }
  const next = [...rows]
  next[index] = { ...rows[index], 钢筋笼批号: trimmed }
  saveRows('segmentprod', next)
  return { ok: true, message: `钢筋笼批号已更新为「${trimmed}」` }
}

/* ---------- 口径变更后的存量重算 ---------- */

export type ReleaseRecalcResult = {
  recalculated: number // 按新标准改判的台数
  archived: number // 本次留档的历史已出厂台数
  pendingRelease: number
  released: number
}

const TESTING_CONCLUSION_CODE = 'TEST-RELEASE'

function compareProductionDate(a: EntryRow, b: EntryRow): number {
  const da = String(a['生产日期'] ?? '') || '9999'
  const db = String(b['生产日期'] ?? '') || '9999'
  if (da !== db) {
    return da < db ? -1 : 1
  }
  return Number(a.id) - Number(b.id)
}

// 结论回写试验检测委托清单：按委托编号幂等 upsert，重复执行也只落一条。
function upsertTestingConclusion(
  rows: EntryRow[],
  summary: ReleaseSummary,
  date: string,
): EntryRow[] {
  const conclusion = `待出厂${summary.pendingRelease}台、已出厂${summary.released}台（${RELEASE_STANDARD}）`
  const index = rows.findIndex((row) => String(row['委托编号']) === TESTING_CONCLUSION_CODE)
  if (index >= 0) {
    const next = [...rows]
    next[index] = {
      ...rows[index],
      检测结果: conclusion,
      送样日期: date,
      status: '已出报告',
      pending: false,
    }
    return next
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  return [
    ...rows,
    {
      id,
      status: '已出报告',
      pending: false,
      abnormal: false,
      委托编号: TESTING_CONCLUSION_CODE,
      试样类型: '管片',
      检测项目: '出厂判定复核',
      送样日期: date,
      检测结果: conclusion,
      报告编号: `RPT-${TESTING_CONCLUSION_CODE}`,
      检测机构: '场内试验室',
      委托状态: '已出报告',
    },
  ]
}

// 统一口径后的存量重算：按生产日期把存量管片重新过一遍。
// 历史已出厂的按当时标准留档、状态不动；其余按新标准重算；
// 结论回写试验检测委托清单。三步在一个事务里，任何一步落库失败就一并回滚。
export function recalculateSegmentRelease(): ReleaseRecalcResult {
  const snapshot = snapshotRows()
  const archiveSnapshot = loadReleaseArchive()
  try {
    const previousLabel = archiveSnapshot.standardLabel ?? '旧口径（未留档）'
    const archive = { ...archiveSnapshot, entries: [...archiveSnapshot.entries] }
    const archivedIds = new Set(archive.entries.map((entry) => entry.segmentId))
    const now = new Date().toISOString()
    let recalculated = 0
    let archived = 0
    const nextSegments = [...listRows('segmentprod')].sort(compareProductionDate).map((row) => {
      const status = String(row.status)
      if (status === '已出厂') {
        if (!archivedIds.has(Number(row.id))) {
          archive.entries.push({
            segmentId: Number(row.id),
            管片编号: String(row['管片编号'] ?? row.id),
            standard: previousLabel,
            archivedAt: now,
          })
          archivedIds.add(Number(row.id))
          archived += 1
        }
        return row
      }
      if (PRE_RELEASE_STATUSES.has(status)) {
        return row
      }
      const verdict = evaluateRelease(row)
      if (verdict.state === status) {
        return row
      }
      recalculated += 1
      return { ...row, status: verdict.state, pending: verdict.state !== '已出厂' }
    })
    const summary = summarizeRelease(nextSegments, archivedIds)
    const nextTesting = upsertTestingConclusion(listRows('testing'), summary, now.slice(0, 10))
    archive.marker = releaseStandardMarker()
    archive.standardLabel = releaseStandardLabel()
    saveRows('segmentprod', nextSegments)
    saveRows('testing', nextTesting)
    saveReleaseArchive(archive)
    return { recalculated, archived, ...summary }
  } catch (error) {
    // 落库不成功就一并回滚：业务数据和留档都回到动手之前。
    replaceAllRows(snapshot)
    saveReleaseArchive(archiveSnapshot)
    throw error
  }
}

// 口径标识变了（首次启用或改了上下限）就自动重算一遍存量；已经在当前口径下就不动。
export function ensureReleaseStandard(): ReleaseRecalcResult | null {
  if (loadReleaseArchive().marker === releaseStandardMarker()) {
    return null
  }
  return recalculateSegmentRelease()
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 管片生产导出与台账、交付清单同一份取数，不再单独按出厂强度另算一遍。
  const rows = key === 'segmentprod' ? canonicalSegmentRows() : listRows(key)
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
