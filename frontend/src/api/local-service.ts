import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModules, saveRows } from '@/data/local-store'
import {
  SEGMENT_RELEASE_RULE_VERSION,
  evaluateSegment,
  recalculateSegments,
  releaseConclusion,
  segmentReleaseStats,
  syncTestingCommissions,
} from '@/data/segment-release'
import type { SegmentReleaseStats } from '@/data/segment-release'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const SEGMENTPROD_KEY = 'segmentprod'
const TESTING_KEY = 'testing'

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
  if (key === SEGMENTPROD_KEY) {
    return runSegmentprodAction(id, action)
  }
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
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch {
    return { ok: false, message: `${meta.entity}${action}落库失败，已回滚，请重试` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 管片生产的三个动作全部走统一出厂口径：状态由共用算法判定，不再各自写一套。
function runSegmentprodAction(id: number, action: string): ActionResult {
  const rows = listRows(SEGMENTPROD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的管片` }
  }
  const row = rows[index]
  const status = String(row.status)
  const today = new Date().toISOString().slice(0, 10)

  if (action === '开始浇筑') {
    if (status !== '待浇筑') {
      return { ok: false, message: `管片当前是「${status}」，不用重复浇筑` }
    }
    return commitSegmentRows(rows, index, { ...row, status: '养护中', pending: true, abnormal: false },
      '管片已开始浇筑，转入养护中')
  }
  if (action === '确认养护') {
    if (status === '待浇筑') {
      return { ok: false, message: '管片尚未浇筑，不能确认养护' }
    }
    if (status === '已出厂') {
      return { ok: false, message: '管片已出厂，不用再确认养护' }
    }
    if (status === '待出厂') {
      return { ok: false, message: '管片已是「待出厂」，不用重复操作' }
    }
    const verdict = evaluateSegment(row)
    if (!verdict.eligible) {
      return { ok: false, message: `未达出厂标准，继续养护：${verdict.reasons.join('；')}` }
    }
    return commitSegmentRows(rows, index, { ...row, status: '待出厂', pending: true, abnormal: false },
      '管片养护已确认，当前状态「待出厂」')
  }
  if (action === '办理出厂') {
    if (status === '已出厂') {
      return { ok: false, message: '管片已出厂，重复提交不会重复落库' }
    }
    const verdict = evaluateSegment(row)
    if (!verdict.eligible) {
      return { ok: false, message: `未达出厂标准，出厂申请被挡回：${verdict.reasons.join('；')}` }
    }
    return commitSegmentRows(
      rows,
      index,
      {
        ...row,
        status: '已出厂',
        pending: false,
        abnormal: false,
        出厂依据: `${SEGMENT_RELEASE_RULE_VERSION}（${today}）`,
        出厂日期: today,
      },
      '管片已办理出厂，结论已回写试验检测委托清单',
    )
  }
  return { ok: false, message: `管片没有登记「${action}」这个动作` }
}

// 管片变更与委托清单回写放在同一次提交里：要么一起落库，要么一起回滚。
function commitSegmentRows(
  rows: EntryRow[],
  index: number,
  updated: EntryRow,
  message: string,
): ActionResult {
  const nextSegments = [...rows]
  nextSegments[index] = updated
  const nextTesting = syncTestingCommissions(nextSegments, listRows(TESTING_KEY)).rows
  try {
    saveModules({ [SEGMENTPROD_KEY]: nextSegments, [TESTING_KEY]: nextTesting })
  } catch {
    return { ok: false, message: '落库失败，管片与委托清单一并回滚，请重试' }
  }
  return { ok: true, message }
}

/**
 * 改单个字段的入口。已出厂的管片不许再改钢筋笼批号，越权提交在这里挡回去。
 */
export function updateEntryField(key: string, id: number, field: string, value: string): ActionResult {
  const meta = moduleMeta(key)
  if (!meta.fields.includes(field)) {
    return { ok: false, message: `${meta.entity}没有「${field}」这个字段` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  if (key === SEGMENTPROD_KEY && field === '钢筋笼批号' && String(row.status) === '已出厂') {
    return { ok: false, message: '管片已出厂，钢筋笼批号不允许再改，越权提交已挡回' }
  }
  if (String(row[field] ?? '') === value) {
    return { ok: false, message: `${field}没有变化，不用重复提交` }
  }
  const next = [...rows]
  next[index] = { ...row, [field]: value }
  try {
    saveRows(key, next)
  } catch {
    return { ok: false, message: `${meta.entity}的${field}落库失败，已回滚，请重试` }
  }
  return { ok: true, message: `${meta.entity}的${field}已更新` }
}

/**
 * 存量管片按统一出厂口径重算一遍（按生产日期先后过），结论同步回写委托清单。
 * 幂等：重复执行没有变化就不落库，重复点两回也只落一条。
 */
export function recalculateSegmentRelease(): ActionResult & { changed: number } {
  const segments = recalculateSegments(listRows(SEGMENTPROD_KEY))
  const testing = syncTestingCommissions(segments.rows, listRows(TESTING_KEY))
  if (segments.changed === 0 && testing.changed === 0) {
    return { ok: true, message: '存量管片已按统一口径复查，无需变更', changed: 0 }
  }
  try {
    saveModules({ [SEGMENTPROD_KEY]: segments.rows, [TESTING_KEY]: testing.rows })
  } catch {
    return { ok: false, message: '重算落库失败，已一并回滚，请重试', changed: 0 }
  }
  return {
    ok: true,
    message: `已按统一出厂口径重算 ${segments.changed} 条管片，回写 ${testing.changed} 条委托`,
    changed: segments.changed,
  }
}

/** 出厂统计：生产台账、试验检测、交付清单都从这里取，保证几处台数对得上。 */
export function loadSegmentReleaseStats(): SegmentReleaseStats {
  return segmentReleaseStats(listRows(SEGMENTPROD_KEY))
}

/** 进度节点的管片交付清单：与生产台账同一份取数、同一份算法。 */
export function listSegmentDelivery(): { items: EntryRow[]; ready: number } {
  const rows = listRows(SEGMENTPROD_KEY)
  const items = rows.map((row) => {
    const conclusion = releaseConclusion(row)
    const note =
      conclusion === '已出厂'
        ? String(row['出厂依据'] ?? '历史出厂（按当时标准留档）')
        : conclusion === '待出厂'
          ? '达出厂标准，可办理出厂'
          : evaluateSegment(row).reasons.join('；')
    return { ...row, 出厂结论: conclusion, 说明: note }
  })
  return { items, ready: items.filter((item) => item['出厂结论'] === '待出厂').length }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  // 管片生产清单带一列「出厂结论」，与页面、交付清单同一份算法，不再另算。
  const extraColumns = key === SEGMENTPROD_KEY ? ['出厂结论'] : []
  const header = ['编号', ...meta.fields, '当前状态', ...extraColumns]
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    const cells = [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status]
    if (key === SEGMENTPROD_KEY) {
      cells.push(releaseConclusion(row))
    }
    lines.push(cells.join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: '\uFEFF' + lines.join('\n') }
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
