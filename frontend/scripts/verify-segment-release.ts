/* 出厂口径收拢的回归自检：算法、迁移、回写、幂等、越权、事务。 */
import {
  evaluateSegment,
  recalculateSegments,
  releaseConclusion,
  segmentReleaseStats,
  syncTestingCommissions,
  SEGMENT_RELEASE_CONFIG,
} from '@/data/segment-release'
import { SEED_ROWS } from '@/data/seed'
import {
  exportEntries,
  listSegmentDelivery,
  loadSegmentReleaseStats,
  recalculateSegmentRelease,
  runAction,
  updateEntryField,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name} ${detail}`)
  }
}

const clone = (v: unknown) => JSON.parse(JSON.stringify(v))

// ---- 1. 共用算法：交付清单口径 ----
const seg2 = clone(SEED_ROWS.segmentprod[1]) // 养护中，未签字
const seg3 = clone(SEED_ROWS.segmentprod[2]) // 待出厂，已签字，21天/38.6MPa
check('未签字不达标', !evaluateSegment(seg2).eligible)
check('签字且双达标可出厂', evaluateSegment(seg3).eligible)
check('已出厂结论不翻案', releaseConclusion(clone(SEED_ROWS.segmentprod[3])) === '已出厂')
check('待浇筑结论保持', releaseConclusion(clone(SEED_ROWS.segmentprod[0])) === '待浇筑')
const lowCuring = { ...seg3, 养护天数: SEGMENT_RELEASE_CONFIG.curingDays.min - 1 }
check('养护天数低于下限被挡', !evaluateSegment(lowCuring).eligible)
const lowStrength = { ...seg3, 出厂强度: SEGMENT_RELEASE_CONFIG.strength.min - 1 }
check('出厂强度低于下限被挡', !evaluateSegment(lowStrength).eligible)

// ---- 2. 存量重算：按生产日期过一遍，已出厂留档 ----
const recalc = recalculateSegments(clone(SEED_ROWS.segmentprod))
check('种子数据重算后无变更（口径自洽）', recalc.changed === 0, `changed=${recalc.changed}`)
const legacy = clone(SEED_ROWS.segmentprod)
legacy[1].status = '待出厂' // 旧口径误判：未签字却待出厂
legacy[3]['出厂依据'] = '' // 历史已出厂缺留档
const recalc2 = recalculateSegments(legacy)
const fixed2 = recalc2.rows.find((r) => r['管片编号'] === 'SEGM-0002')
const fixed4 = recalc2.rows.find((r) => r['管片编号'] === 'SEGM-0004')
check('未签字的待出厂被重算回养护中', fixed2?.status === '养护中')
check('历史已出厂只补留档不翻案', fixed4?.status === '已出厂' && String(fixed4?.['出厂依据']).includes('留档'))
check('重算幂等', recalculateSegments(recalc2.rows).changed === 0)

// ---- 3. 服务层：重算 + 回写委托清单 ----
const first = recalculateSegmentRelease()
check('首次重算有回写', first.ok && first.changed >= 0)
const second = recalculateSegmentRelease()
check('重复重算只落一条（幂等）', second.ok && second.changed === 0, `changed=${second.changed}`)
const t3 = listRows('testing').find((r) => r['管片编号'] === 'SEGM-0003')
check('达标管片结论回写委托清单', t3?.['检测结果'] === '达出厂标准，待办理出厂', String(t3?.['检测结果']))
const t4 = listRows('testing').find((r) => r['管片编号'] === 'SEGM-0004')
check('已出厂委托单保持已出报告', t4?.status === '已出报告' && t4?.['检测结果'] === '出厂检验合格，准予出厂')

// ---- 4. 办理出厂：不达标挡回、达标放行、重复不重复落库 ----
const reject = runAction('segmentprod', 2, '办理出厂')
check('未签字管片出厂被挡回', !reject.ok, reject.message)
const release = runAction('segmentprod', 3, '办理出厂')
check('达标管片办理出厂成功', release.ok, release.message)
const seg3after = listRows('segmentprod').find((r) => Number(r.id) === 3)
check('出厂依据按新口径落档', String(seg3after?.['出厂依据']).includes('v2-交付清单口径'))
check('出厂日期已落账', Boolean(seg3after?.['出厂日期']))
const t3after = listRows('testing').find((r) => r['管片编号'] === 'SEGM-0003')
check('出厂后委托单结转为已出报告', t3after?.status === '已出报告' && t3after?.['检测结果'] === '出厂检验合格，准予出厂')
const again = runAction('segmentprod', 3, '办理出厂')
check('重复办理出厂被挡', !again.ok)

// ---- 5. 已出厂不许改钢筋笼批号 ----
const forbid = updateEntryField('segmentprod', 3, '钢筋笼批号', 'GJL-HACK')
check('已出厂改批号被挡回', !forbid.ok, forbid.message)
const allow = updateEntryField('segmentprod', 2, '钢筋笼批号', 'GJL-20260910-02R')
check('未出厂改批号放行', allow.ok, allow.message)
const same = updateEntryField('segmentprod', 2, '钢筋笼批号', 'GJL-20260910-02R')
check('同值重复提交被挡', !same.ok)

// ---- 6. 两处台数对得上 + 导出同口径 ----
const stats = loadSegmentReleaseStats()
const delivery = listSegmentDelivery()
check('生产台账与交付清单待出厂数一致', stats.ready === delivery.ready, `${stats.ready} vs ${delivery.ready}`)
const csv = exportEntries('segmentprod')
check('导出带出厂结论列', csv.content.includes('出厂结论'))
const seg2line = csv.content.split('\n').find((l) => l.includes('SEGM-0002'))
check('导出结论与页面同口径', Boolean(seg2line?.endsWith('养护中')), String(seg2line))

// ---- 7. 回写同步函数本身幂等 ----
const sync1 = syncTestingCommissions(listRows('segmentprod'), listRows('testing'))
check('委托清单回写幂等', sync1.changed === 0, `changed=${sync1.changed}`)

console.log(failures === 0 ? '全部通过' : `${failures} 项未通过`)
if (failures > 0) {
  throw new Error(`verify-segment-release: ${failures} 项未通过`)
}
