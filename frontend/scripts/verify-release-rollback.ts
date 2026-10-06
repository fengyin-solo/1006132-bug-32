/* 落库失败时的回滚自检：写失败重试后仍失败 → 一并回滚，不沿用旧值。 */
import { listRows } from '@/data/local-store'
import { runAction } from '@/api/local-service'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`FAIL  ${name} ${detail}`)
  }
}

// 先正常办理一次出厂（无 window，落库退化为仅缓存，成功）
const ok = runAction('segmentprod', 3, '办理出厂')
check('正常出厂成功', ok.ok, ok.message)

// 模拟写库失败：localStorage.setItem 一直抛错
let attempts = 0
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: () => null,
    setItem: () => {
      attempts += 1
      throw new Error('QuotaExceeded')
    },
  },
}

const before = listRows('segmentprod').map((r) => [r['管片编号'], r.status])
const fail = runAction('segmentprod', 1, '开始浇筑')
check('写失败被挡回', !fail.ok, fail.message)
check('写失败有重试', attempts === 2, `attempts=${attempts}`)
const after = listRows('segmentprod').map((r) => [r['管片编号'], r.status])
check('失败后缓存一并回滚，不沿用旧值', JSON.stringify(before) === JSON.stringify(after))

console.log(failures === 0 ? '全部通过' : `${failures} 项未通过`)
if (failures > 0) {
  throw new Error(`verify-release-rollback: ${failures} 项未通过`)
}
