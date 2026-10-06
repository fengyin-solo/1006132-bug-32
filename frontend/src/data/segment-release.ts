import type { EntryRow } from './types'

// 管片出厂判定：全系统只有这一份实现。
// 口径定为「以交付清单为准」：检验人员已签字，且养护天数、出厂强度都落在上下限内，
// 才算「待出厂」；「已出厂」只能由办理出厂动作达成。生产台账、导出、进度节点交付清单、
// 试验检测委托清单都从这里取数，谁也不许再各算一遍。

/** 规则版本：改口径时升版本，历史已出厂的管片按当时版本留档，不用新口径翻案。 */
export const SEGMENT_RELEASE_RULE_VERSION = 'v2-交付清单口径'

/** 出厂标准配置：养护天数与出厂强度的上下限只在这里维护一份。 */
export const SEGMENT_RELEASE_CONFIG = {
  /** 养护天数上下限（天） */
  curingDays: { min: 7, max: 28 },
  /** 出厂强度上下限（MPa） */
  strength: { min: 30, max: 55 },
  /** 交付清单口径：检验人员必须签字才算达标 */
  requireInspectorSign: true,
} as const

export type ReleaseEvaluation = {
  eligible: boolean
  reasons: string[]
}

function readNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** 按统一口径检查一根管片是否达到出厂标准，不达标的原因一并返回。 */
export function evaluateSegment(row: EntryRow): ReleaseEvaluation {
  const reasons: string[] = []
  const { curingDays, strength, requireInspectorSign } = SEGMENT_RELEASE_CONFIG

  if (requireInspectorSign && String(row['检验人员'] ?? '').trim() === '') {
    reasons.push('检验人员未签字')
  }
  const curing = readNumber(row['养护天数'])
  if (curing === null) {
    reasons.push('养护天数未登记')
  } else if (curing < curingDays.min) {
    reasons.push(`养护天数 ${curing} 天，低于下限 ${curingDays.min} 天`)
  } else if (curing > curingDays.max) {
    reasons.push(`养护天数 ${curing} 天，超出上限 ${curingDays.max} 天`)
  }
  const value = readNumber(row['出厂强度'])
  if (value === null || value <= 0) {
    reasons.push('出厂强度未登记')
  } else if (value < strength.min) {
    reasons.push(`出厂强度 ${value}MPa，低于下限 ${strength.min}MPa`)
  } else if (value > strength.max) {
    reasons.push(`出厂强度 ${value}MPa，超出上限 ${strength.max}MPa`)
  }
  return { eligible: reasons.length === 0, reasons }
}

/**
 * 一根管片的出厂结论，所有入口共用：
 * 已出厂 → 已出厂（历史留档，不翻案）；未浇筑 → 待浇筑；
 * 其余按统一口径判定，达标 → 待出厂，不达标 → 养护中。
 */
export function releaseConclusion(row: EntryRow): string {
  const status = String(row.status ?? '')
  if (status === '已出厂') return '已出厂'
  if (status === '待浇筑') return '待浇筑'
  return evaluateSegment(row).eligible ? '待出厂' : '养护中'
}

export type SegmentReleaseStats = {
  /** 养护中管片 */
  curing: number
  /** 待出厂管片 */
  ready: number
  /** 本月出厂数（按出厂日期落账） */
  releasedThisMonth: number
}

/** 生产台账、试验检测、交付清单共用的出厂统计，保证几处台数对得上。 */
export function segmentReleaseStats(rows: EntryRow[], today: Date = new Date()): SegmentReleaseStats {
  const month = today.toISOString().slice(0, 7)
  let curing = 0
  let ready = 0
  let releasedThisMonth = 0
  for (const row of rows) {
    const conclusion = releaseConclusion(row)
    if (conclusion === '养护中') curing += 1
    if (conclusion === '待出厂') ready += 1
    if (conclusion === '已出厂' && String(row['出厂日期'] ?? '').startsWith(month)) {
      releasedThisMonth += 1
    }
  }
  return { curing, ready, releasedThisMonth }
}

/**
 * 存量管片按生产日期先后重新过一遍统一口径：
 * 历史已出厂的只补留档（出厂依据），不翻案；其余按新算法重算状态。
 * 幂等：再跑一遍没有变化就返回 changed = 0，调用方不用落库。
 */
export function recalculateSegments(rows: EntryRow[]): { rows: EntryRow[]; changed: number } {
  const ordered = [...rows].sort((a, b) => {
    const byDate = String(a['生产日期'] ?? '9999').localeCompare(String(b['生产日期'] ?? '9999'))
    return byDate !== 0 ? byDate : Number(a.id) - Number(b.id)
  })
  const patch = new Map<number, EntryRow>()
  for (const row of ordered) {
    if (String(row.status) === '已出厂') {
      if (!row['出厂依据']) {
        patch.set(Number(row.id), { ...row, 出厂依据: '历史出厂（按当时标准留档）', pending: false })
      }
      continue
    }
    const target = releaseConclusion(row)
    const pending = target !== '已出厂'
    if (target !== String(row.status) || pending !== Boolean(row.pending)) {
      patch.set(Number(row.id), { ...row, status: target, pending })
    }
  }
  if (patch.size === 0) {
    return { rows, changed: 0 }
  }
  return { rows: rows.map((row) => patch.get(Number(row.id)) ?? row), changed: patch.size }
}

/**
 * 把出厂结论回写到试验检测的委托清单：按管片编号对上委托单，原地更新检测结果，
 * 已出厂的委托单一并结转为已出报告。原地更新不新增行，重复执行不会落重复数据。
 */
export function syncTestingCommissions(
  segments: EntryRow[],
  commissions: EntryRow[],
): { rows: EntryRow[]; changed: number } {
  const byCode = new Map(segments.map((row) => [String(row['管片编号'] ?? ''), row]))
  let changed = 0
  const rows = commissions.map((commission) => {
    const code = String(commission['管片编号'] ?? '').trim()
    if (code === '') return commission
    const segment = byCode.get(code)
    if (!segment) return commission
    const conclusion = releaseConclusion(segment)
    const result =
      conclusion === '已出厂'
        ? '出厂检验合格，准予出厂'
        : conclusion === '待出厂'
          ? '达出厂标准，待办理出厂'
          : '未达出厂标准'
    const next: EntryRow = { ...commission, 检测结果: result }
    if (conclusion === '已出厂' && String(next.status) !== '已出报告') {
      next.status = '已出报告'
      next.pending = false
    }
    const untouched =
      String(next.status) === String(commission.status) &&
      Boolean(next.pending) === Boolean(commission.pending) &&
      String(next['检测结果']) === String(commission['检测结果'] ?? '')
    if (untouched) return commission
    changed += 1
    return next
  })
  return { rows, changed }
}
