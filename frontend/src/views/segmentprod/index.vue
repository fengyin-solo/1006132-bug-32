<template>
  <section class="page" data-module="segmentprod">
    <header class="page-head">
      <div>
        <h2>管片生产管理</h2>
        <p class="page-desc">维护管片，围绕管片编号、管片型号、生产模具、钢筋笼批号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管片</button>
        <button class="btn" type="button" @click="recalculate">按交付清单口径重算</button>
        <button class="btn" type="button" @click="exportRows">导出管片生产清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="editRebarBatch(row)">修改钢筋笼批号</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无管片生产数据，可先登记管片</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片生产记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  ensureReleaseStandard,
  listCanonicalSegments,
  moduleMeta,
  recalculateSegmentRelease,
  runAction as applyAction,
  summarizeRelease,
  updateSegmentRebarBatch,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('segmentprod')
const columns = ["管片编号", "管片型号", "生产模具", "钢筋笼批号", "生产日期", "养护天数", "出厂强度", "检验人员", "生产状态"]
const actions = ["开始浇筑", "确认养护", "办理出厂"]
const statuses = ["待浇筑", "养护中", "待出厂", "已出厂"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 统计卡与状态图例都基于统一判定后的行，待出厂数与试验检测页出自同一个 summarizeRelease。
const stats = computed(() => {
  const summary = summarizeRelease()
  const month = new Date().toISOString().slice(0, 7)
  const releasedThisMonth = rows.value.filter(
    (row) => String(row.status) === '已出厂' && String(row['生产日期'] ?? '').startsWith(month),
  ).length
  return [
    { label: '养护中管片', value: rows.value.filter((row) => String(row.status) === '养护中').length },
    { label: '待出厂管片', value: summary.pendingRelease },
    { label: '本月出厂数', value: releasedThisMonth },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '管片登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function editRebarBatch(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const input = window.prompt('请输入新的钢筋笼批号', String(row['钢筋笼批号'] ?? ''))
  if (input === null) {
    return
  }
  const result = updateSegmentRebarBatch(Number(row.id), input)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

// 口径重算：留档、改判、回写试验检测在一个事务里，失败已整体回滚，可放心重试。
function recalculate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const result = recalculateSegmentRelease()
    noticeMessage.value = `已按交付清单口径重算：改判 ${result.recalculated} 台，历史出厂留档 ${result.archived} 台，当前待出厂 ${result.pendingRelease} 台，结论已回写试验检测委托清单`
  } catch (error) {
    errorMessage.value = error instanceof Error ? `重算落库失败，已回滚：${error.message}` : '重算落库失败，已回滚，请重试'
    return
  }
  // 提交完再进一次页面复查：重新取数，不沿用旧值。
  reload()
}

// 读取失败时重试一次，仍失败就把错误摆出来，不沿用旧值。
function reload() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = listCanonicalSegments(filters.value)
      rows.value = payload.items
      total.value = payload.total
      errorMessage.value = ''
      return
    } catch (error) {
      if (attempt === 1) {
        errorMessage.value = error instanceof Error ? error.message : '管片生产列表读取失败'
      }
    }
  }
}

onMounted(() => {
  // 口径有变化时先把存量重算一遍（幂等）；写失败不阻塞页面，重算按钮可再试。
  try {
    ensureReleaseStandard()
  } catch {
    errorMessage.value = '出厂口径重算落库失败，已回滚，请点「按交付清单口径重算」重试'
  }
  reload()
})
</script>
