// DHCP 动态地址池（dnsmasq dhcp-range）生成。
// 本模块只读取当前规划结果、主机登记与面板录入，绝不修改规划、基线、路由汇总、主机登记与导出。
//
// 生成规则：
//   - 网段只能选当前「成功分配」的固定 / 自动网段（以需求稳定 ID 关联）；
//   - 自动排除：网络地址、广播地址、该网段内当前「有效」的主机登记（逐个地址）；
//   - 手工排除：多段起止 IPv4，必须位于所选网段（含网络/广播地址，与手工录入语义一致）、
//     起止有序；重叠或相邻的手工区间先合并为一段；
//   - 可分配集合 = 整个网段 − 手工排除（合并后）− 自动排除（合并后），按连续区间切成多段；
//   - 每段输出一行 `dhcp-range=<起始>,<结束>,<点分十进制子网掩码>`，按 IPv4 升序；
//   - 任一行手工区间录入无效（非法 IPv4、起止倒置、越出网段）都明确定位并停止整体输出；
//   - 规划 / 登记 / 排除项变化后由调用方重新执行本纯函数实时重算。

import { intToIp, ipToInt, prefixMask } from './ip'
import { allocatableSegments, reconcileHosts, type AllocSegment } from './hosts'
import { mergeRanges } from './baseline'
import type { AddrRange, DhcpExclusionInput, HostAssignment, PlanResult } from './types'

/** 一行手工排除录入的实时校验视图 */
export interface DhcpExclusionRowView {
  id: string
  index: number
  /** 起止均为空白的行：占位行，不参与校验也不计数 */
  empty: boolean
  startIp: string | null
  endIp: string | null
  start: number | null
  end: number | null
  /** 本行自身无误时规范化后的区间；否则为 null */
  range: AddrRange | null
  errors: string[]
}

/** 一段连续可分配地址（最终输出单元） */
export interface DhcpPoolRange {
  index: number
  start: number
  end: number
  startIp: string
  endIp: string
  /** 本段可分配地址数 */
  count: number
  /** 配置行 dhcp-range=<起始>,<结束>,<掩码> */
  line: string
}

/** 自动排除项（用于面板说明其构成） */
export interface DhcpAutoExclusion {
  kind: 'network' | 'broadcast' | 'host'
  label: string
  start: number
  end: number
}

export interface DhcpPoolResult {
  rows: DhcpExclusionRowView[]
  /** 拍平后的全部错误（含序号前缀） */
  errors: { index: number; message: string }[]
  /** 全部行自身有效时：合并后的手工排除区间（升序、不重叠、不相邻）；有错时为空 */
  manualRanges: AddrRange[]
  /** 手工排除合计地址数 */
  manualCount: number
  /** 自动排除明细（网络地址 / 广播地址 / 每条有效主机登记） */
  autoItems: DhcpAutoExclusion[]
  /** 自动排除合并后的区间 */
  autoRanges: AddrRange[]
  /** 自动排除合计地址数（合并去重后） */
  autoCount: number
  /** 实际从可用集合中扣减的地址数 = 手工 ∪ 自动（合并去重） */
  excludedCount: number
  /** 网段容量（含网络地址与广播地址） */
  segmentCapacity: number
  /** 可分配分段（按地址升序） */
  pools: DhcpPoolRange[]
  /** 可分配地址总数 */
  total: number
  /** 点分十进制子网掩码，如 255.255.255.0 */
  netmask: string
  /** 全部 dhcp-range 配置行文本；有错或无剩余地址时为空串 */
  configText: string
}

/** 在当前规划中解析地址池宿主网段（必须是成功分配的固定 / 自动网段）；失效返回 null */
export function resolvePoolSegment(
  result: PlanResult,
  ownerId: string,
): AllocSegment | null {
  if (!ownerId) return null
  return allocatableSegments(result).find((s) => s.ownerId === ownerId) ?? null
}

/** A − B：从已合并、升序的区间集合 A 中扣除 B 覆盖的地址（B 同样需已合并、升序） */
function subtractRanges(a: AddrRange[], b: AddrRange[]): AddrRange[] {
  const out: AddrRange[] = []
  let j = 0
  for (const range of a) {
    while (j < b.length && b[j].end < range.start) j++
    let cursor = range.start
    for (let k = j; k < b.length && b[k].start <= range.end; k++) {
      const cut = b[k]
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start - 1, range.end) })
      cursor = Math.max(cursor, cut.end + 1)
      if (cursor > range.end) break
    }
    if (cursor <= range.end) out.push({ start: cursor, end: range.end })
  }
  return out
}

const rangeSize = (r: AddrRange) => r.end - r.start + 1

/**
 * 依据当前网段、主机登记与手工排除录入计算动态地址池视图。
 * 调用方应在宿主网段失效（resolvePoolSegment 为 null）或输入非法时暂停调用并暂停展示结果。
 */
export function buildDhcpPool(
  entries: DhcpExclusionInput[],
  segment: AllocSegment,
  assignments: HostAssignment[],
  result: PlanResult,
): DhcpPoolResult {
  const rows: DhcpExclusionRowView[] = []
  const errors: { index: number; message: string }[] = []
  const validRanges: AddrRange[] = []

  entries.forEach((entry, i) => {
    const index = i + 1
    const startRaw = entry.start.trim()
    const endRaw = entry.end.trim()
    const rowErrors: string[] = []

    if (!startRaw && !endRaw) {
      rows.push({
        id: entry.id,
        index,
        empty: true,
        startIp: null,
        endIp: null,
        start: null,
        end: null,
        range: null,
        errors: [],
      })
      return
    }

    let start: number | null = null
    let end: number | null = null

    if (!startRaw) {
      rowErrors.push('缺少起始地址')
    } else {
      const s = ipToInt(startRaw)
      if (Number.isNaN(s)) {
        rowErrors.push(`起始地址“${startRaw}”不是合法的 IPv4 地址`)
      } else {
        start = s
      }
    }
    if (!endRaw) {
      rowErrors.push('缺少结束地址')
    } else {
      const e = ipToInt(endRaw)
      if (Number.isNaN(e)) {
        rowErrors.push(`结束地址“${endRaw}”不是合法的 IPv4 地址`)
      } else {
        end = e
      }
    }

    let range: AddrRange | null = null
    if (start !== null && end !== null) {
      if (start > end) {
        rowErrors.push(
          `起始地址 ${intToIp(start)} 晚于结束地址 ${intToIp(end)}（起止须有序）`,
        )
      } else if (start < segment.start || end > segment.end) {
        rowErrors.push(
          `区间 ${intToIp(start)} ~ ${intToIp(end)} 超出所选网段 ${segment.cidr}（须位于 ${segment.network} ~ ${segment.broadcast} 内）`,
        )
      } else {
        range = { start, end }
        validRanges.push(range)
      }
    }

    for (const message of rowErrors) errors.push({ index, message })
    rows.push({
      id: entry.id,
      index,
      empty: false,
      startIp: start !== null ? intToIp(start) : null,
      endIp: end !== null ? intToIp(end) : null,
      start,
      end,
      range,
      errors: rowErrors,
    })
  })

  const netmask = intToIp(prefixMask(segment.prefix))
  const segmentRange: AddrRange[] = [{ start: segment.start, end: segment.end }]

  // 自动排除：网络地址、广播地址、当前在该网段内有效的主机登记
  const autoItems: DhcpAutoExclusion[] = [
    { kind: 'network', label: `网络地址 ${segment.network}`, start: segment.start, end: segment.start },
    { kind: 'broadcast', label: `广播地址 ${segment.broadcast}`, start: segment.end, end: segment.end },
  ]
  // /32 时网络地址与广播地址为同一地址，去重由后续 mergeRanges 完成；登记只取当前有效者
  const { rows: hostRows } = reconcileHosts(assignments, result)
  for (const row of hostRows) {
    // 只自动扣除属于当前宿主网段的登记；其他网段（或失效）登记一律与本网段地址池无关
    if (row.valid && row.assignment.ownerId === segment.ownerId) {
      const ip = intToIp(row.assignment.address)
      autoItems.push({
        kind: 'host',
        label: `主机登记 ${row.assignment.name || '未命名设备'} ${ip}`,
        start: row.assignment.address,
        end: row.assignment.address,
      })
    }
  }

  const autoRanges = mergeRanges(autoItems.map((x) => ({ start: x.start, end: x.end })))
  const autoCount = autoRanges.reduce((acc, r) => acc + rangeSize(r), 0)

  if (errors.length > 0) {
    return {
      rows,
      errors,
      manualRanges: [],
      manualCount: 0,
      autoItems,
      autoRanges,
      autoCount,
      excludedCount: autoCount,
      segmentCapacity: segment.capacity,
      pools: [],
      total: 0,
      netmask,
      configText: '',
    }
  }

  // 重叠或相邻的手工区间先合并
  const manualRanges = mergeRanges(validRanges)
  const manualCount = manualRanges.reduce((acc, r) => acc + rangeSize(r), 0)

  // 实际扣减 = 手工 ∪ 自动（合并去重，避免重叠重复计数）
  const excludedRanges = mergeRanges([...manualRanges, ...autoRanges])
  const excludedCount = excludedRanges.reduce((acc, r) => acc + rangeSize(r), 0)

  const freeRanges = subtractRanges(segmentRange, excludedRanges)
  const pools: DhcpPoolRange[] = freeRanges.map((r, i) => {
    const startIp = intToIp(r.start)
    const endIp = intToIp(r.end)
    return {
      index: i + 1,
      start: r.start,
      end: r.end,
      startIp,
      endIp,
      count: rangeSize(r),
      line: `dhcp-range=${startIp},${endIp},${netmask}`,
    }
  })
  const total = pools.reduce((acc, p) => acc + p.count, 0)

  return {
    rows,
    errors,
    manualRanges,
    manualCount,
    autoItems,
    autoRanges,
    autoCount,
    excludedCount,
    segmentCapacity: segment.capacity,
    pools,
    total,
    netmask,
    configText: pools.map((p) => p.line).join('\n'),
  }
}

/** 下载为 .conf 文件（Blob 方式，纯前端，不经过任何服务器） */
export function downloadDhcpPoolConf(text: string, segmentCidr: string) {
  const blob = new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const cidrPart = segmentCidr.replace(/\//g, '_')
  a.href = url
  a.download = `dnsmasq-dhcp-range-${cidrPart}-${stamp}.conf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
