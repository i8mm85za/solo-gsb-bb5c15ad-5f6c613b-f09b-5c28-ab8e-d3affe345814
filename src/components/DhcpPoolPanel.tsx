import { useMemo, useState } from 'react'
import { isAllocSegment } from '../lib/hosts'
import { buildDhcpPool, downloadDhcpPoolConf, resolvePoolSegment } from '../lib/dhcpPool'
import { intToIp } from '../lib/ip'
import type { DhcpExclusionInput, HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  ownerId: string
  exclusions: DhcpExclusionInput[]
  onOwnerChange: (id: string) => void
  onExclusionsChange: (next: DhcpExclusionInput[]) => void
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

let exclusionCounter = 0
function exclusionUid(): string {
  exclusionCounter += 1
  return `dhcpx-${Date.now()}-${exclusionCounter}`
}

/** 复制到剪贴板；非安全上下文（无 navigator.clipboard）时回退到临时 textarea */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到回退方案
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

export default function DhcpPoolPanel({
  result,
  assignments,
  ownerId,
  exclusions,
  onOwnerChange,
  onExclusionsChange,
}: Props) {
  const [copied, setCopied] = useState(false)

  // 可作为地址池宿主的对象：当前成功分配的固定 / 自动网段（按地址升序）
  const allocatable = useMemo(() => {
    if (result.inputErrors.length > 0) return []
    return result.segments.filter(isAllocSegment)
  }, [result])

  const invalid = result.inputErrors.length > 0
  // 选中的网段在当前规划中失效（规划变化导致删除 / 分配失败）时暂停结果
  const segment = useMemo(() => resolvePoolSegment(result, ownerId), [result, ownerId])
  const ownerMissing = !invalid && allocatable.length > 0 && ownerId !== '' && !segment

  // 宿主网段有效时才实时校验与生成；任一录入错误都使配置文本为空
  const built = useMemo(
    () => (segment ? buildDhcpPool(exclusions, segment, assignments, result) : null),
    [exclusions, segment, assignments, result],
  )

  function patchExclusion(id: string, patch: Partial<DhcpExclusionInput>) {
    onExclusionsChange(exclusions.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }

  function addExclusion() {
    onExclusionsChange([...exclusions, { id: exclusionUid(), start: '', end: '' }])
  }

  function removeExclusion(id: string) {
    onExclusionsChange(exclusions.filter((x) => x.id !== id))
  }

  function clearExclusions() {
    onExclusionsChange([])
  }

  async function handleCopy() {
    if (!built || !built.configText) return
    const ok = await copyText(built.configText)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  function handleDownload() {
    if (!built || !built.configText || !segment) return
    downloadDhcpPoolConf(built.configText, segment.cidr)
  }

  const errors = built?.errors ?? []
  const hasAnyEntry = exclusions.length > 0
  const canOutput = !!built && errors.length === 0 && built.pools.length > 0

  return (
    <div className="panel dhcppool-panel">
      <h2>⑨ DHCP 动态地址池（dnsmasq dhcp-range）</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        选择一个当前<strong>成功分配</strong>的固定 / 自动网段，录入多段<strong>手工排除区间</strong>（起止 IPv4，含端点）。
        系统还会<strong>自动排除网络地址、广播地址</strong>以及该网段内<strong>当前有效的主机登记</strong>（见⑥面板）；
        手工区间<strong>重叠或相邻会自动合并</strong>，剩余地址按连续区间生成
        <code className="mono opt121-inline-code">dhcp-range=&lt;起始&gt;,&lt;结束&gt;,&lt;掩码&gt;</code>
        配置，逐段显示可分配数量与总数。排除区间必须完全位于所选网段且起止有序，任一条目无效都会明确定位并停止输出；
        规划、登记或排除项变化后实时重算，网段失效（被删除或分配失败）时<strong>保留全部录入并暂停输出</strong>。
      </p>

      {invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），DHCP 动态地址池生成已暂停；网段选择与全部排除区间录入均已保留，修正后自动恢复。
        </div>
      )}
      {!invalid && allocatable.length === 0 && (
        <div className="summary-disabled-note">当前没有成功分配的固定或自动网段，暂无可选的地址池网段。</div>
      )}
      {ownerMissing && (
        <div className="summary-disabled-note">
          已选择的网段在当前规划中已失效（被删除或分配失败），结果已暂停；排除区间录入已保留，重新选择有效网段后恢复生成。
        </div>
      )}

      <div className="opt121-client-row">
        <label className="field-label" htmlFor="dhcppool-owner">
          地址池网段（手工排除与自动扣除均限定在此网段内）
        </label>
        <select
          id="dhcppool-owner"
          className="opt121-select"
          value={ownerId}
          onChange={(e) => {
            setCopied(false)
            onOwnerChange(e.target.value)
          }}
        >
          <option value="">— 请选择地址池网段 —</option>
          {allocatable.map((seg) => (
            <option key={seg.ownerId} value={seg.ownerId}>
              {`[${KIND_LABEL[seg.kind]}] ${seg.name}　${seg.cidr}（可用 ${seg.firstUsable} ~ ${seg.lastUsable}）`}
            </option>
          ))}
        </select>
      </div>

      <fieldset
        disabled={!segment}
        className="opt121-fieldset"
        style={{ border: 'none', margin: 0, padding: 0 }}
      >
        <div className="btn-row opt121-toolbar">
          <button onClick={addExclusion} disabled={!segment}>
            + 添加手工排除区间
          </button>
          {hasAnyEntry && (
            <button onClick={clearExclusions} disabled={!segment} className="danger-btn">
              清空全部区间
            </button>
          )}
          <span className="opt121-toolbar-hint">
            区间例：<code className="mono">192.168.10.200</code> ~ <code className="mono">192.168.10.220</code>（可含网络 / 广播地址）
          </span>
        </div>

        <div className="opt121-rows">
          {exclusions.map((ex) => {
            const view = built?.rows.find((r) => r.id === ex.id) ?? null
            const rowErrors = view?.errors ?? []
            return (
              <div
                key={ex.id}
                className={`opt121-row${rowErrors.length > 0 ? ' has-error' : ''}${view?.empty ? ' is-empty' : ''}`}
              >
                <div className="opt121-row-inputs dhcppool-row-inputs">
                  <span className="opt121-idx mono">#{view?.index ?? ''}</span>
                  <input
                    type="text"
                    className="dhcppool-addr"
                    placeholder="起始 IPv4（含），如 192.168.10.200"
                    value={ex.start}
                    onChange={(e) => {
                      setCopied(false)
                      patchExclusion(ex.id, { start: e.target.value })
                    }}
                  />
                  <span className="dhcppool-tilde">～</span>
                  <input
                    type="text"
                    className="dhcppool-addr"
                    placeholder="结束 IPv4（含），如 192.168.10.220"
                    value={ex.end}
                    onChange={(e) => {
                      setCopied(false)
                      patchExclusion(ex.id, { end: e.target.value })
                    }}
                  />
                  <button
                    type="button"
                    className="icon"
                    title="删除该区间"
                    onClick={() => removeExclusion(ex.id)}
                  >
                    ✕
                  </button>
                </div>
                {rowErrors.length > 0 ? (
                  <ul className="opt121-row-errors">
                    {rowErrors.map((m, j) => (
                      <li key={j}>第 {view?.index} 条：{m}</li>
                    ))}
                  </ul>
                ) : (
                  view && !view.empty && view.range && (
                    <div className="opt121-row-bytes mono">
                      {intToIp(view.range.start)} ~ {intToIp(view.range.end)}
                      <span className="opt121-byte-count">
                        （{fmt(view.range.end - view.range.start + 1)} 个地址）
                      </span>
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>
      </fieldset>

      {errors.length > 0 && (
        <div className="opt121-error-box">
          <strong>存在 {errors.length} 处区间错误，已停止生成（dhcp-range 配置暂不输出）：</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                第 {e.index} 条：{e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {segment && !hasAnyEntry && (
        <p className="summary-empty">
          未录入手工排除区间时，将仅扣除网络地址、广播地址与当前有效主机登记后生成地址池。
        </p>
      )}

      {segment && built && (
        <div className="dhcppool-result">
          {/* 排除构成 */}
          <div className="table-scroll">
            <table className="opt121-table dhcppool-excl-table">
              <thead>
                <tr>
                  <th>排除类别</th>
                  <th>地址区间</th>
                  <th className="dhcppool-num-col">地址数</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>手工排除（{built.manualRanges.length} 段，重叠/相邻已合并）</td>
                  <td className="mono">
                    {built.manualRanges.length > 0
                      ? built.manualRanges.map((r) => `${intToIp(r.start)} ~ ${intToIp(r.end)}`).join('；')
                      : '—'}
                  </td>
                  <td className="mono dhcppool-num-col">{fmt(built.manualCount)}</td>
                </tr>
                <tr>
                  <td>自动排除（网络/广播地址 + {built.autoItems.filter((x) => x.kind === 'host').length} 条有效主机登记）</td>
                  <td className="mono">
                    {built.autoRanges.map((r) => `${intToIp(r.start)} ~ ${intToIp(r.end)}`).join('；')}
                  </td>
                  <td className="mono dhcppool-num-col">{fmt(built.autoCount)}</td>
                </tr>
                <tr className="dhcppool-total-row">
                  <td>
                    实际排除合计（手工 ∪ 自动，去重）/ 网段容量 {fmt(built.segmentCapacity)}
                  </td>
                  <td />
                  <td className="mono dhcppool-num-col">{fmt(built.excludedCount)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 有效主机登记明细 */}
          {built.autoItems.filter((x) => x.kind === 'host').length > 0 && (
            <details className="dhcppool-hosts">
              <summary>
                自动扣除的有效主机登记（{built.autoItems.filter((x) => x.kind === 'host').length}）
              </summary>
              <ul className="dhcppool-host-list">
                {built.autoItems
                  .filter((x) => x.kind === 'host')
                  .map((x) => (
                    <li key={x.label} className="mono">
                      {x.label}
                    </li>
                  ))}
              </ul>
            </details>
          )}

          <div className="dnsmasq-head">
            <h3>
              dnsmasq 动态地址池（{built.pools.length} 段，共 {fmt(built.total)} 个可分配地址，掩码 {built.netmask}）
            </h3>
            <div className="dnsmasq-actions">
              <button onClick={handleCopy} disabled={!canOutput} title="复制全部 dhcp-range 配置行">
                {copied ? '✓ 已复制' : '📋 复制'}
              </button>
              <button
                className="primary"
                onClick={handleDownload}
                disabled={!canOutput}
                title="下载为 dnsmasq 配置文件（.conf）"
              >
                ⬇ 下载 .conf
              </button>
            </div>
          </div>

          {built.pools.length === 0 ? (
            <div className="dnsmasq-empty">
              {errors.length > 0
                ? '存在区间错误，暂不生成。'
                : '排除后该网段已无剩余可分配地址（通常为 /30 且可用地址均已登记）。'}
            </div>
          ) : (
            <>
              <div className="table-scroll">
                <table className="opt121-table">
                  <thead>
                    <tr>
                      <th>段序</th>
                      <th>起始地址</th>
                      <th>结束地址</th>
                      <th className="dhcppool-num-col">可分配数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {built.pools.map((p) => (
                      <tr key={p.start}>
                        <td className="mono">{p.index}</td>
                        <td className="mono">{p.startIp}</td>
                        <td className="mono">{p.endIp}</td>
                        <td className="mono dhcppool-num-col">{fmt(p.count)}</td>
                      </tr>
                    ))}
                    <tr className="dhcppool-total-row">
                      <td colSpan={3}>合计可分配</td>
                      <td className="mono dhcppool-num-col">{fmt(built.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p className="dnsmasq-hint">
                可直接追加到 dnsmasq 配置（如 <code className="mono">/etc/dnsmasq.d/dhcp-range.conf</code>）后重新加载；
                静态登记（<code className="mono">dhcp-host</code>）与动态池地址互不重叠。
              </p>
              <pre className="mono dnsmasq-output">{built.configText}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

