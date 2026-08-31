/* Sticky Router Dashboard v2 — same data, same features, refined UX.
   Data endpoints (unchanged): /api/status, /api/history, /api/events (SSE),
   POST /api/usage/refresh, /api/bindings/clear, /api/history/clear,
   PATCH /api/instances/:port */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- plain browser JS outside any tsconfig project; type-aware rules cannot resolve DOM/fetch types here */

const state = {
  history: [],
  /** @type {string | null} */
  activeSession: null,
  routeHistorySize: 0,
  totalNanoAiuSinceStart: 0,
  instances: [],
  sseLive: false,
  /** @type {{ model: string | null, instance: number | null }} */
  filter: { model: null, instance: null },
}
const HISTORY_DISPLAY_LIMIT = 200
const PIP_TOP_REQUEST_LIMIT = 3
const LAST_ACTIVE_REFRESH_INTERVAL_MS = 5000

function budgetForecastRatio(forecastUsd, totalCapUsd) {
  return totalCapUsd > 0 ? forecastUsd / totalCapUsd : Infinity
}

const byId = (id) => document.getElementById(id)

const cut = (value, size = 24) => {
  const text = value || "-"
  return text.length > size ? `${text.slice(0, size)}…` : text
}

const fmtTime = (value) => {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("en-GB")
}

const fmtLocalDateTime = (value) => {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  })
}

const formatCompactNumber = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return "-"
  return number
    .toFixed(2)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1")
}

const formatCooldownRemaining = (value) => {
  const totalMs = Number(value || 0)
  if (!Number.isFinite(totalMs) || totalMs <= 0) return "-"
  const totalSeconds = Math.ceil(totalMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (hours > 0) parts.push(`${hours}h`)
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(" ")
}

const formatRelativeTime = (value) => {
  if (!value) return { label: "-", className: "", title: "" }
  const date = new Date(value)
  const ms = date.getTime()
  if (Number.isNaN(ms)) return { label: "-", className: "", title: "" }

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 60) {
    return {
      label: `${diffSec}s ago`,
      className: "time-recent",
      title: date.toISOString(),
    }
  }
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) {
    return {
      label: `${diffMin}m ago`,
      className: diffMin < 5 ? "time-recent" : "time-normal",
      title: date.toISOString(),
    }
  }
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) {
    return {
      label: `${diffHour}h ago`,
      className: diffHour < 2 ? "time-normal" : "time-stale",
      title: date.toISOString(),
    }
  }
  const diffDay = Math.floor(diffHour / 24)
  return {
    label: `${diffDay}d ago`,
    className: "time-stale",
    title: date.toISOString(),
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/* ---------- Instances ---------- */

function refreshLastActiveCells() {
  for (const cell of document.querySelectorAll(
    ".last-active[data-last-active]",
  )) {
    const last = formatRelativeTime(cell.getAttribute("data-last-active"))
    const span = cell.querySelector("span")
    if (!span) continue
    span.className = last.className
    span.textContent = last.label
    span.title = last.title
  }
}

function renderInstances(instances) {
  byId("instance-count").textContent = String(instances.length)
  const body = byId("instances-body")
  byId("instances-empty").hidden = instances.length > 0
  if (!instances.length) {
    body.innerHTML = ""
    return
  }
  body.innerHTML = instances
    .map((item) => {
      const counts = item.requestCounts || {}
      const entries = Object.entries(counts).sort(([, a], [, b]) => b - a)
      const total = entries.reduce((sum, [, count]) => sum + count, 0)
      const headerSnapshot = item.headerSnapshot || {}
      const premiumUsage = headerSnapshot.premiumUsage
      const sessionRateLimit = headerSnapshot.sessionRateLimit
      const weeklyRateLimit = headerSnapshot.weeklyRateLimit

      const usagePct =
        premiumUsage && Number(premiumUsage.total) > 0 ?
          Math.min(
            100,
            (Number(premiumUsage.used) / Number(premiumUsage.total)) * 100,
          )
        : 0
      const usageLabel =
        premiumUsage ?
          `${formatCompactNumber(premiumUsage.used)} / ${formatCompactNumber(premiumUsage.total)}`
        : "- / -"

      const modelListHtml =
        entries.length ?
          entries
            .map(
              ([model, count]) => `
          <div class="model-row"><span>${escapeHtml(model)}</span><strong>${count}</strong></div>
        `,
            )
            .join("")
        : '<span class="history-agent">none</span>'

      const last = formatRelativeTime(item.lastActive)
      const st = instanceState(item)
      const rowClass =
        st.key === "cool" ? ' class="row-cool"'
        : st.key === "off" ? ' class="is-off row-off"'
        : st.key === "down" ? ' class="row-down"'
        : ""
      return `
      <tr${rowClass}>
        <td>
          <div class="cell-name">
            <span class="status-dot${item.healthy ? " is-up" : ""}" title="${item.healthy ? "up" : "down"}"></span>
            <span class="name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          </div>
        </td>
        <td><span class="port-code">:${escapeHtml(String(item.port))}</span></td>
        <td><span class="state-pill state-${st.key}">${escapeHtml(st.label)}</span></td>
        <td class="cell-usage">
          ${usageLabel}
          <div class="mini-bar"><div class="mini-bar-fill" style="width: ${usagePct}%"></div></div>
        </td>
        <td>
          <span class="model-total">Total ${total}</span>
          <div class="model-list">${modelListHtml}</div>
        </td>
        <td>
          <dl class="cooldown-grid">
            <dt>cooldown</dt><dd>${escapeHtml(fmtLocalDateTime(item.cooldownUntil || "-"))} (${escapeHtml(formatCooldownRemaining(item.remainingCooldownMs))})</dd>
            <dt>upstream retry</dt><dd>${escapeHtml(String(item.upstreamRetryAfter || "-"))}</dd>
            <dt>session RL</dt><dd>${sessionRateLimit ? `${escapeHtml(formatCompactNumber(sessionRateLimit.remaining))} rem @ ${escapeHtml(fmtLocalDateTime(sessionRateLimit.resetAt))}` : "-"}</dd>
            <dt>weekly RL</dt><dd>${weeklyRateLimit ? `${escapeHtml(formatCompactNumber(weeklyRateLimit.remaining))} rem @ ${escapeHtml(fmtLocalDateTime(weeklyRateLimit.resetAt))}` : "-"}</dd>
          </dl>
        </td>
        <td class="last-active" data-last-active="${escapeHtml(item.lastActive || "")}"><span class="${last.className}" title="${escapeHtml(last.title)}">${escapeHtml(last.label)}</span></td>
        <td>
          <label class="switch" title="${item.disabled ? "Disabled" : "Enabled"}">
            <input type="checkbox" data-port="${escapeHtml(String(item.port))}" data-prev="${item.disabled ? "0" : "1"}" ${item.disabled ? "" : "checked"}>
            <span class="slider"></span>
          </label>
        </td>
      </tr>
    `
    })
    .join("")
}

/* ---------- Budget hero ---------- */

function renderBudget(instances) {
  const setText = (id, val) => {
    const el = byId(id)
    if (el) el.textContent = val
  }
  const bar = byId("budget-bar")
  const statusEl = byId("budget-status")
  const forecastEl = byId("budget-forecast")

  const reporting = (instances || []).filter((instance) => {
    const usage = instance?.headerSnapshot?.premiumUsage
    return (
      usage
      && Number.isFinite(Number(usage.used))
      && Number.isFinite(Number(usage.total))
    )
  })
  const total = reporting.length
  const now = new Date()
  const monthName = now.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  })
  setText("budget-month", monthName)
  setText(
    "budget-snapshot-note",
    `${total}/${(instances || []).length} instances reporting`,
  )

  const reset = () => {
    setText("budget-used", "–")
    setText("budget-total", "–")
    setText("budget-pct", "")
    setText("budget-pace", "–")
    setText("budget-forecast", "–")
    if (bar) {
      bar.style.width = "0%"
      bar.className = "hero-bar-fill"
    }
    if (statusEl) {
      statusEl.textContent = ""
      statusEl.className = "hero-status"
    }
    if (forecastEl) forecastEl.className = "stat-chip-value"
  }

  if (total === 0) {
    reset()
    return
  }

  const totalUsedCredits = reporting.reduce(
    (sum, i) => sum + Number(i.headerSnapshot.premiumUsage.used),
    0,
  )
  const totalCapCredits = reporting.reduce(
    (sum, i) => sum + Number(i.headerSnapshot.premiumUsage.total),
    0,
  )
  const CREDIT_TO_USD = 0.01
  const totalUsedUsd = totalUsedCredits * CREDIT_TO_USD
  const totalCapUsd = totalCapCredits * CREDIT_TO_USD
  const elapsed = now.getDate()
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate()
  const paceUsd = elapsed > 0 ? totalUsedUsd / elapsed : 0
  const forecastUsd = paceUsd * daysInMonth
  const pct = totalCapUsd > 0 ? (totalUsedUsd / totalCapUsd) * 100 : 0
  const ratio = budgetForecastRatio(forecastUsd, totalCapUsd)

  let statusClass = "is-good"
  let statusText = "On track"
  let statusIcon = "✓"
  if (ratio > 1.1) {
    statusClass = "is-danger"
    statusText = "Over pace"
    statusIcon = "🔴"
  } else if (ratio > 0.9) {
    statusClass = "is-warn"
    statusText = "Near pace limit"
    statusIcon = "⚠"
  }

  const fmtUsd = (n) =>
    `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  setText("budget-used", fmtUsd(totalUsedUsd))
  setText("budget-total", fmtUsd(totalCapUsd))
  setText("budget-pct", `${pct.toFixed(1)}% used`)
  setText("budget-pace", paceUsd > 0 ? fmtUsd(paceUsd) : "–")
  setText(
    "budget-forecast",
    forecastUsd > 0 ? `${statusIcon} ${fmtUsd(forecastUsd)}` : "–",
  )
  if (forecastEl) forecastEl.className = `stat-chip-value ${statusClass}`
  if (statusEl) {
    statusEl.textContent = statusText
    statusEl.className = `hero-status ${statusClass}`
  }
  if (bar) {
    bar.style.width = `${Math.min(100, pct)}%`
    bar.className = `hero-bar-fill${
      statusClass === "is-good" ? ""
      : statusClass === "is-warn" ? " is-warn"
      : " is-danger"
    }`
  }
}

/* ---------- Attention strip ---------- */

function budgetPaceRatio(instances) {
  const reporting = (instances || []).filter((instance) => {
    const usage = instance?.headerSnapshot?.premiumUsage
    return (
      usage
      && Number.isFinite(Number(usage.used))
      && Number.isFinite(Number(usage.total))
    )
  })
  if (!reporting.length) return null
  const totalUsedCredits = reporting.reduce(
    (sum, i) => sum + Number(i.headerSnapshot.premiumUsage.used),
    0,
  )
  const totalCapCredits = reporting.reduce(
    (sum, i) => sum + Number(i.headerSnapshot.premiumUsage.total),
    0,
  )
  const now = new Date()
  const elapsed = now.getDate()
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate()
  const totalUsedUsd = totalUsedCredits * 0.01
  const totalCapUsd = totalCapCredits * 0.01
  const paceUsd = elapsed > 0 ? totalUsedUsd / elapsed : 0
  const forecastUsd = paceUsd * daysInMonth
  return budgetForecastRatio(forecastUsd, totalCapUsd)
}

function instanceState(item) {
  if (item.disabled) return { key: "off", label: "已禁用" }
  const cooldownMs = Math.max(
    0,
    new Date(item.cooldownUntil || 0).getTime() - Date.now(),
  )
  const remainingMs = Math.max(
    cooldownMs,
    Number(item.remainingCooldownMs) || 0,
  )
  if (remainingMs > 0)
    return {
      key: "cool",
      label: `冷却 ${formatCooldownRemaining(remainingMs)}`,
    }
  if (!item.healthy) return { key: "down", label: "down" }
  return { key: "ok", label: "正常" }
}

function renderAttention() {
  const strip = byId("attention-strip")
  if (!strip) return
  const instances = state.instances || []
  const okCount = instances.filter((i) => instanceState(i).key === "ok").length
  const liveChip = `<span class="a-chip ${state.sseLive ? "is-ok" : "is-bad"}"><span class="a-dot"></span>${state.sseLive ? "Live" : "SSE down"}</span>`

  const problems = []
  for (const item of instances) {
    const st = instanceState(item)
    if (st.key === "cool")
      problems.push(
        `<span class="a-chip is-warn"><span class="a-dot"></span>:${escapeHtml(String(item.port))} ${escapeHtml(st.label)}</span>`,
      )
    else if (st.key === "down")
      problems.push(
        `<span class="a-chip is-bad"><span class="a-dot"></span>:${escapeHtml(String(item.port))} down</span>`,
      )
  }
  const disabledCount = instances.filter((i) => i.disabled).length
  if (disabledCount > 0)
    problems.push(
      `<span class="a-chip is-warn"><span class="a-dot"></span>${disabledCount} 已禁用</span>`,
    )
  const ratio = budgetPaceRatio(instances)
  if (ratio === Infinity || (ratio !== null && ratio > 1.1))
    problems.push(
      `<span class="a-chip is-bad"><span class="a-dot"></span>预算预测超 ${ratio === Infinity ? "100" : Math.round((ratio - 1) * 100)}%</span>`,
    )
  else if (ratio !== null && ratio > 0.9)
    problems.push(
      `<span class="a-chip is-warn"><span class="a-dot"></span>预算接近限速</span>`,
    )

  if (!problems.length && state.sseLive) {
    const budgetChip =
      ratio !== null && ratio <= 0.9 ?
        `<span class="a-chip is-ok">预算节奏正常</span>`
      : ""
    strip.className = "attention-strip is-calm"
    strip.innerHTML =
      liveChip
      + `<span class="a-chip is-ok">${okCount}/${instances.length} 正常</span>`
      + budgetChip
    return
  }
  strip.className = "attention-strip"
  strip.innerHTML = [
    liveChip,
    `<span class="a-chip">${okCount}/${instances.length} 正常</span>`,
    ...problems,
  ].join("")
}

/* ---------- Bindings ---------- */

function renderBindings(bindings) {
  const entries = Object.entries(bindings || {})
  byId("binding-count").textContent = String(entries.length)
  const list = byId("binding-list")
  byId("bindings-empty").hidden = entries.length > 0
  if (!entries.length) {
    list.innerHTML = ""
    return
  }
  list.innerHTML = entries
    .map(([key, port]) => {
      // key format: `${sessionId}:${agent}:${model}` — split from the right so
      // session ids containing ":" stay intact
      const parts = String(key).split(":")
      const model = parts.length > 1 ? parts.pop() : "-"
      const agent = parts.length > 1 ? parts.pop() : "-"
      const session = parts.join(":") || "-"
      return `
    <tr>
      <td><span class="binding-key" title="${escapeHtml(key)}">${escapeHtml(session)}</span></td>
      <td class="binding-dim">${escapeHtml(agent)}</td>
      <td class="binding-dim">${escapeHtml(model)}</td>
      <td class="num"><span class="binding-port">:${escapeHtml(String(port))}</span></td>
    </tr>
  `
    })
    .join("")
}

/* ---------- History ---------- */

function toPrettyJson(value) {
  return value == null ? "null" : JSON.stringify(value, null, 2)
}

function historyCached(item) {
  const usage = item.usage
  const cached =
    usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cache_read_input_tokens
  const value = Number(cached)
  return Number.isFinite(value) ? value : null
}

function historyUsd(item) {
  const nano = item.copilotUsage?.total_nano_aiu
  const value = Number(nano)
  return Number.isFinite(value) ? value / 100000000000 : null
}

function historyRankKey(item, index) {
  return item.historyId || item.ts || String(index)
}

function rankHistoryValues(history, getter, direction) {
  const rows = history
    .map((item, index) => ({
      key: historyRankKey(item, index),
      value: getter(item),
    }))
    .filter((row) => row.value !== null)
    .sort((a, b) =>
      direction === "asc" ? a.value - b.value : b.value - a.value,
    )
  const ranks = new Map()
  let previousValue = null
  let rank = 0
  rows.forEach((row, index) => {
    if (previousValue === null || row.value !== previousValue) rank = index + 1
    previousValue = row.value
    if (rank <= 3) ranks.set(row.key, rank)
  })
  return ranks
}

function historyRanks(history) {
  return {
    lowCache: rankHistoryValues(history, historyCached, "asc"),
    highCache: rankHistoryValues(history, historyCached, "desc"),
    highCost: rankHistoryValues(history, historyUsd, "desc"),
    lowCost: rankHistoryValues(history, historyUsd, "asc"),
  }
}

function chooseUsageRank(lowRank, highRank) {
  const hasLow = lowRank != null
  const hasHigh = highRank != null
  if (hasLow && hasHigh) {
    if (lowRank === 1 && highRank !== 1)
      return { rank: lowRank, direction: "low" }
    if (highRank === 1 && lowRank !== 1)
      return { rank: highRank, direction: "high" }
    return null
  }
  if (hasLow) return { rank: lowRank, direction: "low" }
  if (hasHigh) return { rank: highRank, direction: "high" }
  return null
}

function highlightUsagePart(text, className, rank, direction) {
  return rank ?
      `<span class="usage-part ${className}"><span class="usage-rank">${direction === "high" ? "▲" : "▼"}${rank}</span>${escapeHtml(text)}</span>`
    : escapeHtml(text)
}

function usageSummaryParts(item, ranks, index) {
  const usage = item.usage
  const copilotUsage = item.copilotUsage
  if (!usage && !copilotUsage) return []
  const parts = []
  const cached = historyCached(item)
  const rankKey = historyRankKey(item, index)
  const lowCacheRank = ranks.lowCache?.get(rankKey)
  const highCacheRank = ranks.highCache?.get(rankKey)
  const tokenDetails =
    Array.isArray(copilotUsage?.token_details) ? copilotUsage.token_details : []
  const typeOrder = ["input", "cache_read", "cache_write", "output"]
  const typeLabel = {
    input: "in",
    cache_read: "cache",
    cache_write: "cache_write",
    output: "out",
  }
  const typeCosts = {}
  for (const detail of tokenDetails) {
    if (!detail || typeof detail !== "object") continue
    const tokenType =
      typeof detail.token_type === "string" ? detail.token_type : ""
    const tokenCount = Number(detail.token_count)
    const batchSize = Number(detail.batch_size)
    const costPerBatch = Number(detail.cost_per_batch)
    if (
      !tokenType
      || !Number.isFinite(tokenCount)
      || !Number.isFinite(batchSize)
      || !Number.isFinite(costPerBatch)
      || batchSize <= 0
    )
      continue
    const nanoCost = (tokenCount / batchSize) * costPerBatch
    if (!Number.isFinite(nanoCost)) continue
    typeCosts[tokenType] = (typeCosts[tokenType] || 0) + nanoCost
  }
  if (cached !== null) {
    const text = `cached=${cached}`
    const rank = chooseUsageRank(lowCacheRank, highCacheRank)
    parts.push(
      rank ?
        highlightUsagePart(
          text,
          rank.direction === "low" ? "usage-low-cache" : "usage-high-cache",
          rank.rank,
          rank.direction,
        )
      : escapeHtml(text),
    )
  }
  for (const tokenType of typeOrder) {
    const typeNano = typeCosts[tokenType]
    if (!Number.isFinite(typeNano)) continue
    const typeUsd = typeNano / 100000000000
    parts.push(
      escapeHtml(`${typeLabel[tokenType] || tokenType}=$${typeUsd.toFixed(6)}`),
    )
  }
  return parts
}

function costCellHtml(item, ranks, index) {
  const usd = historyUsd(item)
  if (usd === null) return "-"
  const text = `$${usd.toFixed(6)}`
  const rankKey = historyRankKey(item, index)
  const rank = chooseUsageRank(
    ranks.lowCost?.get(rankKey),
    ranks.highCost?.get(rankKey),
  )
  return rank ?
      highlightUsagePart(
        text,
        rank.direction === "low" ? "usage-low-cost" : "usage-high-cost",
        rank.rank,
        rank.direction,
      )
    : escapeHtml(text)
}

function usageCellHtml(item, ranks, index) {
  if (!item.usage && !item.copilotUsage)
    return '<span class="history-agent">-</span>'
  const parts = usageSummaryParts(item, ranks, index)
  return `
    <details class="usage-details">
      <summary>${parts.length ? parts.join('<span class="usage-sep">·</span>') : "details"}</summary>
      <pre>usage:\n${escapeHtml(toPrettyJson(item.usage))}\n\ncopilot_usage:\n${escapeHtml(toPrettyJson(item.copilotUsage))}</pre>
    </details>
  `
}

function sessionColor(value) {
  const session = String(value || "-")
  if (session === "-") return "#8b949e"
  let hash = 0
  for (let index = 0; index < session.length; index += 1) {
    hash = ((hash << 5) - hash + session.charCodeAt(index)) | 0
  }
  return `hsl(${Math.abs(hash) % 360} 68% 68%)`
}

function sessionStyle(value) {
  return `--session-color: ${sessionColor(value)}`
}

function setActiveSession(session) {
  state.activeSession = state.activeSession === session ? null : session
  renderHistory(state.history)
}

function renderSessionFilters(history) {
  const counts = new Map()
  history.forEach((item) => {
    const session = String(item.sid || "-")
    counts.set(session, (counts.get(session) || 0) + 1)
  })
  const allActive = state.activeSession === null
  const all = `<button type="button" class="session-filter${allActive ? " is-active" : ""}" data-session="" aria-pressed="${allActive}" style="--session-color: var(--accent)">All ${history.length}</button>`
  const sessions = [...counts.entries()].map(([session, count]) => {
    const active = state.activeSession === session
    return `<button type="button" class="session-filter${active ? " is-active" : ""}" data-session="${escapeHtml(session)}" aria-pressed="${active}" title="${escapeHtml(session)}" style="${sessionStyle(session)}">${escapeHtml(cut(session, 18))} ${count}</button>`
  })
  byId("history-session-filters").innerHTML = [all, ...sessions].join("")
}

function applyHistoryHover(session) {
  document.querySelectorAll(".history-row[data-session]").forEach((row) => {
    const matches = row.dataset.session === session
    row.classList.toggle("history-session-match", matches)
    row.classList.toggle("history-session-muted", !matches)
  })
}

function clearHistoryHover() {
  document.querySelectorAll(".history-row[data-session]").forEach((row) => {
    row.classList.remove("history-session-match", "history-session-muted")
  })
}

function historyRowHtml(item, ranks, index) {
  const session = String(item.sid || "-")
  return `
    <tr class="history-row" data-session="${escapeHtml(session)}" style="${sessionStyle(session)}">
      <td class="history-time">${escapeHtml(fmtTime(item.ts))}</td>
      <td class="history-target"><button type="button" class="port-link" data-port="${escapeHtml(String(item.port || ""))}" title="Filter by this instance">:${escapeHtml(String(item.port || "-"))}</button></td>
      <td><button type="button" class="session-badge" data-session="${escapeHtml(session)}" title="${escapeHtml(item.sid || "-")}" style="${sessionStyle(session)}">${escapeHtml(cut(session, 18))}</button></td>
      <td class="history-agent" title="${escapeHtml(item.agent || "-")}">${escapeHtml(cut(item.agent, 18))}</td>
      <td class="history-model" title="${escapeHtml(item.model || "-")}">${escapeHtml(cut(item.model, 28))}</td>
      <td class="history-reason" title="${escapeHtml(item.reason || "-")}">${escapeHtml(item.reason || "-")}</td>
      <td class="cost-cell num">${costCellHtml(item, ranks, index)}</td>
      <td>${usageCellHtml(item, ranks, index)}</td>
    </tr>
  `
}

function historyPassesFilter(item) {
  if (
    state.activeSession !== null
    && String(item.sid || "-") !== state.activeSession
  )
    return false
  if (state.filter.model && item.model !== state.filter.model) return false
  if (state.filter.instance && Number(item.port) !== state.filter.instance)
    return false
  return true
}

function anyHistoryFilterActive() {
  return (
    state.activeSession !== null
    || state.filter.model !== null
    || state.filter.instance !== null
  )
}

function applyFilter(key, value) {
  if (value === null || value === undefined || value === "") {
    if (key === "model") state.filter.model = null
    else if (key === "instance") state.filter.instance = null
    else if (key === "session") state.activeSession = null
    renderHistory(state.history)
    return
  }
  if (key === "model")
    state.filter.model = state.filter.model === value ? null : value
  else if (key === "instance") {
    const port = Number(value)
    state.filter.instance = state.filter.instance === port ? null : port
  } else if (key === "session")
    state.activeSession = state.activeSession === value ? null : value
  renderHistory(state.history)
}

function renderFilterBar() {
  const bar = byId("history-filters")
  if (!bar) return
  const chips = []
  if (state.filter.model)
    chips.push({ key: "model", label: `模型: ${state.filter.model}` })
  if (state.activeSession)
    chips.push({ key: "session", label: `会话: ${state.activeSession}` })
  if (state.filter.instance)
    chips.push({
      key: "instance",
      label: `实例: :${String(state.filter.instance)}`,
    })
  bar.hidden = chips.length === 0
  bar.innerHTML = chips
    .map(
      (chip) =>
        `<button type="button" class="f-chip" data-filter="${chip.key}" title="Clear this filter">${escapeHtml(chip.label)} <span class="x">✕</span></button>`,
    )
    .join("")
}

function renderHistory(history) {
  state.history =
    Array.isArray(history) ?
      [...history]
        .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
        .slice(0, HISTORY_DISPLAY_LIMIT)
    : []
  renderSessionFilters(state.history)
  renderFilterBar()
  renderInsights(state.history)
  renderCostChart(state.history)
  const visibleHistory = state.history.filter(historyPassesFilter)
  const historyCount =
    anyHistoryFilterActive() ?
      visibleHistory.length
    : Math.max(state.routeHistorySize, visibleHistory.length)
  byId("history-count").textContent = String(historyCount)
  const list = byId("history-list")
  byId("history-empty").hidden = visibleHistory.length > 0
  if (!visibleHistory.length) {
    list.innerHTML = ""
    return
  }
  const ranks = historyRanks(state.history)
  list.innerHTML = visibleHistory
    .map((item, index) => historyRowHtml(item, ranks, index))
    .join("")
}

function renderHistoryTotal(totalNanoAiuSinceStart) {
  const nano = Number(totalNanoAiuSinceStart)
  const usd = Number.isFinite(nano) ? nano / 100000000000 : 0
  byId("history-total-usd").textContent = `$${usd.toFixed(6)}`
}

function prependHistory(item) {
  state.history.unshift(item)
  state.history = state.history.slice(0, HISTORY_DISPLAY_LIMIT)
  renderHistory(state.history)
}

function updateHistoryItem(item) {
  const historyId = item?.historyId
  if (!historyId) return
  const index = state.history.findIndex(
    (entry) => entry.historyId === historyId,
  )
  if (index === -1) return
  state.history[index] = item
  renderHistory(state.history)
}

/* ---------- Insights (cost breakdown, aggregated client-side) ---------- */

const INSIGHT_TOP_N = 5

function sumCostBy(history, keyFn) {
  const totals = new Map()
  for (const item of history) {
    const usd = historyUsd(item)
    if (usd === null) continue
    const key = keyFn(item)
    if (!key) continue
    totals.set(key, (totals.get(key) || 0) + usd)
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])
}

function rankListHtml(entries, filterKey) {
  if (!entries.length)
    return '<div class="insight-empty">No cost data yet.</div>'
  const max = entries[0][1] || 1
  return entries
    .slice(0, INSIGHT_TOP_N)
    .map(
      ([label, usd]) => `
    <div class="rank-row rank-row--click" role="button" tabindex="0" data-filter-key="${filterKey}" data-filter-value="${escapeHtml(label)}" title="Filter by ${escapeHtml(label)}">
      <span class="rank-label">${escapeHtml(cut(label, 22))}</span>
      <span class="rank-bar"><span style="width: ${(usd / max) * 100}%"></span></span>
      <span class="rank-val">$${usd.toFixed(6)}</span>
    </div>`,
    )
    .join("")
}

function topRequestsHtml(history) {
  const top = (Array.isArray(history) ? [...history] : [])
    .map((item) => ({ item, usd: historyUsd(item) }))
    .filter((entry) => entry.usd !== null)
    .sort(
      (a, b) =>
        b.usd - a.usd || (b.item.ts || "").localeCompare(a.item.ts || ""),
    )
    .slice(0, INSIGHT_TOP_N)
  if (!top.length) return '<div class="insight-empty">No cost data yet.</div>'
  return top
    .map(
      ({ item, usd }) => `
    <div class="rank-row rank-row--top rank-row--click" role="button" tabindex="0" data-filter-key="instance" data-filter-value="${escapeHtml(String(item.port || ""))}" title="Filter by :${escapeHtml(String(item.port || "-"))} — ${escapeHtml(item.model || "-")}">
      <span class="rank-val">$${usd.toFixed(6)}</span>
      <span class="rank-label">${escapeHtml(cut(item.model, 20))} · :${escapeHtml(String(item.port || "-"))}</span>
      <span class="rank-time">${escapeHtml(formatRelativeTime(item.ts).label)}</span>
    </div>`,
    )
    .join("")
}

function renderInsights(history) {
  byId("insights-window").textContent = `last ${history.length} routes`
  byId("by-model-list").innerHTML = rankListHtml(
    sumCostBy(history, (item) => item.model),
    "model",
  )
  byId("by-session-list").innerHTML = rankListHtml(
    sumCostBy(history, (item) => (item.sid ? String(item.sid) : null)),
    "session",
  )
  byId("top-requests-list").innerHTML = topRequestsHtml(history)
}

/* ---------- Hourly cost chart (client-side bucketing) ---------- */

function renderCostChart(history) {
  const chart = byId("cost-chart")
  if (!chart) return
  const axis = byId("cost-chart-axis")
  const note = byId("cost-chart-note")
  const rows = (Array.isArray(history) ? history : [])
    .map((item) => ({ ts: item.ts, usd: historyUsd(item) }))
    .filter((row) => row.ts && row.usd !== null)
  note.textContent = `last ${(Array.isArray(history) ? history : []).length} routes`
  if (!rows.length) {
    chart.innerHTML = '<div class="insight-empty">No cost data yet.</div>'
    axis.innerHTML = ""
    return
  }
  const buckets = new Map()
  for (const row of rows) {
    const ms = new Date(row.ts).getTime()
    if (Number.isNaN(ms)) continue
    const hourStart = Math.floor(ms / 3600000) * 3600000
    buckets.set(hourStart, (buckets.get(hourStart) || 0) + row.usd)
  }
  if (!buckets.size) {
    chart.innerHTML = '<div class="insight-empty">No cost data yet.</div>'
    axis.innerHTML = ""
    return
  }
  const MAX_HOURS = 24
  const nowHour = Math.floor(Date.now() / 3600000) * 3600000
  const startHour = nowHour - (MAX_HOURS - 1) * 3600000
  const hours = []
  for (let h = startHour; h <= nowHour; h += 3600000) hours.push(h)
  const maxVal = Math.max(...hours.map((h) => buckets.get(h) || 0), 1e-9)
  const peakHour = hours.reduce((a, b) =>
    (buckets.get(b) || 0) > (buckets.get(a) || 0) ? b : a,
  )
  const fmtHour = (ms) =>
    new Date(ms).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    })
  chart.innerHTML = hours
    .map((h) => {
      const value = buckets.get(h) || 0
      const pct = Math.max(2, (value / maxVal) * 100)
      const cls =
        h === peakHour && value > 0 ? "bar peak"
        : h === nowHour ? "bar now"
        : "bar"
      return `<div class="${cls}" style="height:${pct}%" title="${fmtHour(h)} · $${value.toFixed(4)}"></div>`
    })
    .join("")
  const step = Math.max(1, Math.ceil(hours.length / 8))
  axis.innerHTML = hours
    .map((h, i) => `<span>${i % step === 0 ? fmtHour(h) : ""}</span>`)
    .join("")
}

/* ---------- Data loading & actions ---------- */

async function loadStatus() {
  const response = await fetch("/api/status")
  const payload = await response.json()
  state.instances = payload.instances || []
  renderInstances(state.instances)
  renderBudget(state.instances)
  renderAttention()
  renderBindings(payload.sessionBindings || {})
  state.totalNanoAiuSinceStart = Number(payload.totalNanoAiuSinceStart || 0)
  renderHistoryTotal(state.totalNanoAiuSinceStart)
  if (typeof payload.routeHistorySize === "number") {
    state.routeHistorySize = payload.routeHistorySize
    const historyCount =
      anyHistoryFilterActive() ?
        state.history.filter(historyPassesFilter).length
      : state.routeHistorySize
    byId("history-count").textContent = String(historyCount)
  }
}

async function loadHistory() {
  const response = await fetch("/api/history")
  const payload = await response.json()
  renderHistory(payload || [])
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadHistory()])
}

async function refreshUsage() {
  const button = byId("refresh-usage")
  button.disabled = true
  button.textContent = "Refreshing…"
  try {
    const response = await fetch("/api/usage/refresh", { method: "POST" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await loadStatus()
  } catch (error) {
    window.alert(
      `Failed to refresh usage: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    button.disabled = false
    button.textContent = "Refresh usage"
  }
}

async function clearData(target) {
  const config =
    target === "bindings" ?
      {
        button: byId("clear-bindings"),
        path: "/api/bindings/clear",
        label: "Clear bindings",
      }
    : {
        button: byId("clear-history"),
        path: "/api/history/clear",
        label: "Clear history",
      }
  const { button, path, label } = config
  if (!window.confirm(`Clear ${target} from router memory?`)) return

  button.disabled = true
  button.textContent = "Clearing…"
  try {
    const response = await fetch(path, { method: "POST" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await refreshAll()
  } catch (error) {
    window.alert(
      `Failed to clear ${target}: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

/* ---------- SSE ---------- */

function connectSse() {
  const pill = byId("sse-status")
  const label = byId("sse-label")
  const events = new EventSource("/api/events")
  events.onopen = () => {
    label.textContent = "Live"
    pill.className = "sse-pill is-up"
    state.sseLive = true
    renderAttention()
  }
  events.onerror = () => {
    label.textContent = "Reconnecting"
    pill.className = "sse-pill is-down"
    state.sseLive = false
    renderAttention()
  }
  events.onmessage = async (event) => {
    try {
      prependHistory(JSON.parse(event.data))
      await loadStatus()
    } catch (error) {
      console.error("failed to parse SSE payload", error)
    }
  }
  events.addEventListener("reset", async () => {
    await refreshAll()
  })
  events.addEventListener("history_update", async (event) => {
    try {
      updateHistoryItem(JSON.parse(event.data))
      await loadStatus()
    } catch (error) {
      console.error("failed to parse history_update payload", error)
    }
  })
}

/* ---------- PiP ---------- */

function topCostHistory(history) {
  return (Array.isArray(history) ? [...history] : [])
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
    .slice(0, HISTORY_DISPLAY_LIMIT)
    .map((item) => ({ item, usd: historyUsd(item) }))
    .filter((entry) => entry.usd !== null)
    .sort(
      (a, b) =>
        b.usd - a.usd || (b.item.ts || "").localeCompare(a.item.ts || ""),
    )
    .slice(0, PIP_TOP_REQUEST_LIMIT)
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
}

byId("pip-btn").addEventListener("click", async () => {
  if (!("documentPictureInPicture" in window)) {
    alert(
      "Document Picture-in-Picture not supported. Use Chrome 116+ or Edge 116+.",
    )
    return
  }
  const pipWindow = await documentPictureInPicture.requestWindow({
    width: 240,
    height: 180,
  })
  const doc = pipWindow.document
  doc.head.innerHTML = `<style>
    body { font-family: ui-monospace, monospace; font-size: 12px; padding: 5px 8px; background: #0e1218; color: #d5dae4; line-height: 1.4; white-space: nowrap; display: flex; justify-content: center; margin: 0; }
    .root { display: inline-grid; grid-template-columns: max-content max-content; gap: 2px 9px; }
    .k { color: #77809a; }
    .v { color: #eef1f8; font-weight: 600; font-variant-numeric: tabular-nums; white-space: pre-line; }
    .section { grid-column: 1 / -1; color: #77809a; margin-top: 4px; border-top: 1px solid #232a38; padding-top: 3px; }
    .top-list { grid-column: 1 / -1; display: grid; gap: 2px; }
    .top-row { display: grid; grid-template-columns: 1fr max-content; gap: 8px; }
    .top-age { color: #98a0b3; }
    .danger { color: #f87171; }
    .warn { color: #fbbf24; }
    .ok { color: #4ade80; }
  </style>`
  const root = doc.createElement("div")
  root.className = "root"
  root.innerHTML = `
    <span class="k">Used</span><span class="v" id="pip-used">-</span>
    <span class="k">Total</span><span class="v" id="pip-total">-</span>
    <span class="k">Pace/day</span><span class="v" id="pip-pace">-</span>
    <span class="k">Forecast</span><span class="v" id="pip-forecast">-</span>
    <span class="k">History</span><span class="v" id="pip-history">-</span>
    <span class="k">Med/Avg</span><span class="v" id="pip-median">-</span>
    <span class="section">Top requests</span>
    <div id="pip-top-requests" class="top-list">-</div>`
  doc.body.appendChild(root)

  const fmtUsd = (n) =>
    "$"
    + Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })

  async function pipRefresh() {
    try {
      const [statusResponse, historyResponse] = await Promise.all([
        fetch("/api/status"),
        fetch("/api/history"),
      ])
      const [payload, history] = await Promise.all([
        statusResponse.json(),
        historyResponse.json(),
      ])
      const instances = payload.instances || []
      const reporting = instances.filter((i) => {
        const u = i?.headerSnapshot?.premiumUsage
        return (
          u
          && Number.isFinite(Number(u.used))
          && Number.isFinite(Number(u.total))
        )
      })
      const totalUsedCredits = reporting.reduce(
        (s, i) => s + Number(i.headerSnapshot.premiumUsage.used),
        0,
      )
      const totalCapCredits = reporting.reduce(
        (s, i) => s + Number(i.headerSnapshot.premiumUsage.total),
        0,
      )
      const totalUsedUsd = totalUsedCredits * 0.01
      const totalCapUsd = totalCapCredits * 0.01
      const now = new Date()
      const elapsed = now.getDate()
      const daysInMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
      ).getDate()
      const paceUsd = elapsed > 0 ? totalUsedUsd / elapsed : 0
      const forecastUsd = paceUsd * daysInMonth
      const ratio = budgetForecastRatio(forecastUsd, totalCapUsd)
      let fcClass = "ok"
      if (ratio > 1.1) fcClass = "danger"
      else if (ratio > 0.9) fcClass = "warn"
      const histUsd = Number(payload.totalNanoAiuSinceStart || 0) / 100000000000

      const set = (id, val) => {
        const el = doc.getElementById(id)
        if (el) el.textContent = val
      }
      set("pip-used", fmtUsd(totalUsedUsd))
      set("pip-total", fmtUsd(totalCapUsd))
      set("pip-pace", paceUsd > 0 ? fmtUsd(paceUsd) : "-")
      const fcEl = doc.getElementById("pip-forecast")
      if (fcEl) {
        fcEl.textContent = forecastUsd > 0 ? fmtUsd(forecastUsd) : "-"
        fcEl.className = "v " + fcClass
      }
      set("pip-history", fmtUsd(histUsd))
      const recent = Array.isArray(history) ? history : []
      const medianEl = doc.getElementById("pip-median")
      if (medianEl) {
        const usds = recent
          .map(historyUsd)
          .filter((u) => Number.isFinite(u) && u > 0)
        if (usds.length === 0) {
          medianEl.textContent = "-"
        } else {
          const sorted = usds.sort((a, b) => a - b)
          const mid = Math.floor(sorted.length / 2)
          const median =
            sorted.length % 2 === 0 ?
              (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid]
          const avg = usds.reduce((s, u) => s + u, 0) / usds.length
          const spanMs =
            recent.length > 1 ?
              new Date(recent[recent.length - 1].ts).getTime()
              - new Date(recent[0].ts).getTime()
            : 0
          const mins = Math.floor(spanMs / 60000)
          const spanLabel =
            mins >= 60 ?
              `${Math.floor(mins / 60)}h${mins % 60 > 0 ? (mins % 60) + "m" : ""}`
            : mins > 0 ? `${mins}m`
            : "<1m"
          medianEl.textContent = `$${median.toFixed(6)} / $${avg.toFixed(6)}\n(${recent.length}r, ${spanLabel})`
        }
      }
      const topRequests = doc.getElementById("pip-top-requests")
      if (topRequests) {
        const rows = topCostHistory(history)
        topRequests.innerHTML =
          rows.length ?
            rows
              .map(
                ({ item, usd }) =>
                  `<span class="top-row"><span class="v">$${usd.toFixed(6)}</span><span class="top-age">${formatRelativeTime(item.ts).label}</span></span>`,
              )
              .join("")
          : "-"
      }
    } catch (e) {
      console.error("PiP refresh failed", e)
    }
  }
  requestAnimationFrame(pipRefresh)
  const interval = setInterval(pipRefresh, 5000)
  pipWindow.addEventListener("pagehide", () => clearInterval(interval))
})

/* ---------- Event wiring ---------- */

byId("clear-bindings").addEventListener("click", () => clearData("bindings"))
byId("clear-history").addEventListener("click", () => clearData("history"))
byId("refresh-usage").addEventListener("click", refreshUsage)

byId("history-session-filters").addEventListener("click", (event) => {
  const button = event.target.closest(".session-filter")
  if (!button) return
  const session = button.dataset.session || null
  if (session === null) {
    state.activeSession = null
    renderHistory(state.history)
    return
  }
  setActiveSession(session)
})

const historyList = byId("history-list")
historyList.addEventListener("click", (event) => {
  const portLink = event.target.closest(".port-link")
  if (portLink && portLink.dataset.port) {
    applyFilter("instance", portLink.dataset.port)
    return
  }
  const badge = event.target.closest(".session-badge")
  if (!badge) return
  setActiveSession(badge.dataset.session || "-")
})
historyList.addEventListener("mouseover", (event) => {
  const badge = event.target.closest(".session-badge")
  if (badge) applyHistoryHover(badge.dataset.session || "-")
})
historyList.addEventListener("mouseout", (event) => {
  if (event.target.closest(".session-badge")) clearHistoryHover()
})

byId("instances-table").addEventListener("change", async (event) => {
  const input = event.target
  if (
    !(input instanceof HTMLInputElement)
    || input.type !== "checkbox"
    || !input.dataset.port
  )
    return
  const port = Number(input.dataset.port)
  const wasEnabled = input.dataset.prev === "1"
  const nowEnabled = input.checked
  if (wasEnabled === nowEnabled) return
  try {
    const response = await fetch(`/api/instances/${port}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: !nowEnabled }),
    })
    if (!response.ok) {
      window.alert(`Failed to toggle instance: HTTP ${response.status}`)
      input.checked = wasEnabled
      input.dataset.prev = wasEnabled ? "1" : "0"
      return
    }
    input.dataset.prev = nowEnabled ? "1" : "0"
    await refreshAll()
  } catch (err) {
    window.alert(
      `Failed to toggle instance: ${err instanceof Error ? err.message : String(err)}`,
    )
    input.checked = wasEnabled
    input.dataset.prev = wasEnabled ? "1" : "0"
  }
})

byId("history-filters").addEventListener("click", (event) => {
  const chip = event.target.closest(".f-chip")
  if (!chip) return
  applyFilter(chip.dataset.filter, null)
})

const insightGrid = document.querySelector(".insight-grid")
insightGrid.addEventListener("click", (event) => {
  const row = event.target.closest(".rank-row[data-filter-key]")
  if (!row || !row.dataset.filterValue) return
  applyFilter(row.dataset.filterKey, row.dataset.filterValue)
})
insightGrid.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return
  const row = event.target.closest(".rank-row[data-filter-key]")
  if (!row || !row.dataset.filterValue) return
  event.preventDefault()
  applyFilter(row.dataset.filterKey, row.dataset.filterValue)
})

setInterval(() => {
  refreshLastActiveCells()
  renderAttention()
}, LAST_ACTIVE_REFRESH_INTERVAL_MS)

void Promise.all([loadStatus(), loadHistory()]).finally(connectSse)
