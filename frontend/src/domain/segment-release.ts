import type { EntryRow } from '@/data/types'

/**
 * 管片出厂判定：全系统只有这一份实现。
 * 生产台账、清单导出、进度节点的交付清单、试验检测的委托清单都从这里取结论，
 * 不允许任何页面再各自算一遍。
 */

// 出厂判定配置：养护天数与出厂强度的上下限只在这一份里维护，改口径只改这里。
export const RELEASE_LIMITS = {
  curingDays: { min: 14, max: 28 }, // 养护天数上下限（天）
  releaseStrength: { min: 30, max: 50 }, // 出厂强度上下限（MPa）
} as const

// 统一口径以交付清单为准：检验人员签字是出厂前提，养护天数、出厂强度须落在上下限之内。
export const RELEASE_STANDARD = '交付清单口径：检验人员签字 + 养护天数/出厂强度在上下限内'

export type ReleaseState = '待出厂' | '已出厂'

export type ReleaseVerdict = {
  state: ReleaseState
  reasons: string[] // 未达标原因，空数组表示达标
}

function toNumber(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// 纯函数：只依据行内字段与上下限配置给出判定结论，不读任何存储。
export function evaluateRelease(row: EntryRow, limits = RELEASE_LIMITS): ReleaseVerdict {
  const reasons: string[] = []
  const inspector = String(row['检验人员'] ?? '').trim()
  if (inspector === '' || inspector === '—') {
    reasons.push('检验人员未签字')
  }
  const curing = toNumber(row['养护天数'])
  if (curing === null) {
    reasons.push('养护天数缺失')
  } else if (curing < limits.curingDays.min || curing > limits.curingDays.max) {
    reasons.push(`养护天数须在${limits.curingDays.min}-${limits.curingDays.max}天`)
  }
  const strength = toNumber(row['出厂强度'])
  if (strength === null) {
    reasons.push('出厂强度缺失')
  } else if (strength < limits.releaseStrength.min || strength > limits.releaseStrength.max) {
    reasons.push(`出厂强度须在${limits.releaseStrength.min}-${limits.releaseStrength.max}MPa`)
  }
  return { state: reasons.length === 0 ? '已出厂' : '待出厂', reasons }
}

// 口径标识：上下限或判定准则一变，标识就变，用来触发存量重算。
export function releaseStandardMarker(): string {
  return [
    RELEASE_STANDARD,
    `养护${RELEASE_LIMITS.curingDays.min}-${RELEASE_LIMITS.curingDays.max}`,
    `强度${RELEASE_LIMITS.releaseStrength.min}-${RELEASE_LIMITS.releaseStrength.max}`,
  ].join('|')
}

// 留档用的口径说明：带上具体上下限，以后改了配置，历史留档仍看得出当时按什么标准放的行。
export function releaseStandardLabel(): string {
  return `交付清单口径：检验人员签字，养护${RELEASE_LIMITS.curingDays.min}-${RELEASE_LIMITS.curingDays.max}天，强度${RELEASE_LIMITS.releaseStrength.min}-${RELEASE_LIMITS.releaseStrength.max}MPa`
}
