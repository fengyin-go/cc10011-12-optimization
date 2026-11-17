/**
 * 反爬挑战冷却判断的唯一实现。
 *
 * 背景：识别服务每遇到一次反爬挑战都会写一条挑战记录，冷却窗口用「等待时长」配置。
 * 冷却判断原先是各入口各写一份（列表、回放、动作、导出），规则一改就要改多处。
 * 这里把「能不能复用旧挑战结论」收敛成一个纯函数，页面与数据层只调用它。
 *
 * 复用条件（全部满足才算有效结论，缺一不可）：
 * 1. 记录属于同一主记录（反爬策略 + 对抗策略 + 策略编号）与同一挑战站点；
 * 2. 记录已放行（只有放行过的挑战才有可复用的结论，进行中/被中断的不算）；
 * 3. 按本次调用明确传入的关账时刻判断（now <= 冷却截止时间），不读 ambient 时钟；
 * 4. 结论必须绑定挑战时刻与等待配置版本（v0.2 之前的旧记录没有版本，一律视为过期）；
 * 5. 等待配置版本必须与当前配置版本一致——等待时长调整后，旧窗口的结论不再放行。
 *
 * 注意第 3 条：不传关账时刻时返回 unable-to-determine（valid=false），
 * 而不是「看起来没过期就放行」。
 */

export type AntibotStrategyRecord = {
  strategyNo: string
  counterStrategy: string
  recognitionService: string
  captchaType: string
  waitMs: number
  waitConfigVersion: string
}

export type AntibotChallengeRecord = {
  id: number
  strategyNo: string
  counterStrategy: string
  challengeAt: number
  decidedAt: number | null
  cooldownDeadline: number
  waitMs: number
  waitConfigVersion: string
  outcome: 'allowed' | 'blocked' | 'pending' | 'interrupted'
  evidence: string
}

export type ReuseDecisionReason =
  | 'no-strategy'
  | 'record-identity-mismatch'
  | 'record-from-other-config'
  | 'record-not-allowed'
  | 'cooldown-elapsed'
  | 'unable-to-determine'
  | 'reusable'

export type ReuseDecision = {
  valid: boolean
  reason: ReuseDecisionReason
  recordId: number | null
  cooldownDeadline: number | null
  waitConfigVersion: string
  message: string
}

export type ReuseView = ReuseDecision & {
  strategy: AntibotStrategyRecord | null
  record: AntibotChallengeRecord | null
  /** 关账时刻是否由调用方明确给出；没有给出时不做任何放行判断。 */
  evaluatedAt: number | null
  /** 等待配置是否在挑战放行之后被调整过。 */
  configChangedAfterDecision: boolean
}

export const LEGACY_CONFIG_VERSION = 'legacy-unversioned'

const VALID_OUTCOME = 'allowed'
const EVIDENCE_KINDS = new Set(['inline', 'truncated', 'local-evidence-untouched'])

/** 主记录身份：反爬策略 + 对抗策略 + 策略编号，三者缺一不可。 */
export function sameRecordIdentity(
  left: Pick<AntibotStrategyRecord, 'strategyNo' | 'counterStrategy'>,
  right: Pick<AntibotChallengeRecord, 'strategyNo' | 'counterStrategy'>,
): boolean {
  if (!left.strategyNo || !right.strategyNo) {
    return false
  }
  if (left.strategyNo !== right.strategyNo) {
    return false
  }
  if (left.counterStrategy && right.counterStrategy) {
    return left.counterStrategy === right.counterStrategy
  }
  return false
}

/** 记录是否带着可核对的挑战证据（挑战时刻 + 等待配置版本都在）。 */
export function hasChallengeEvidence(record: AntibotChallengeRecord): boolean {
  if (!EVIDENCE_KINDS.has(record.evidence)) {
    return false
  }
  if (!Number.isFinite(record.challengeAt) || record.challengeAt <= 0) {
    return false
  }
  if (!Number.isFinite(record.cooldownDeadline) || record.cooldownDeadline <= 0) {
    return false
  }
  return isVersionedConfig(record.waitConfigVersion)
}

/** 版本号形态：v<次>.<修订>；没带版本或形态不对的挑战记录一律当作过期结论。 */
export function isVersionedConfig(version: string): boolean {
  return /^v\d+\.\d+$/.test(version)
}

/**
 * 判断「现在能不能复用旧挑战的结论」。
 * now 必须由调用方给出（页面时间、复核时刻或测试固定时刻都行）。
 */
export function evaluateReuse(
  strategy: AntibotStrategyRecord,
  record: AntibotChallengeRecord | null,
  now: number,
): ReuseDecision {
  const base = {
    recordId: record?.id ?? null,
    cooldownDeadline: record?.cooldownDeadline ?? null,
    waitConfigVersion: strategy.waitConfigVersion,
  }
  if (!record) {
    return { ...base, valid: false, reason: 'no-strategy', message: '没有可复用的挑战记录，本次需要重新挑战' }
  }
  if (!sameRecordIdentity(strategy, record)) {
    return { ...base, valid: false, reason: 'record-identity-mismatch', message: '挑战记录不属于同一主记录，不能复用' }
  }
  if (record.outcome !== VALID_OUTCOME || record.decidedAt === null) {
    return { ...base, valid: false, reason: 'record-not-allowed', message: '挑战尚未放行，没有可复用的结论' }
  }
  if (!hasChallengeEvidence(record)) {
    return { ...base, valid: false, reason: 'record-from-other-config', message: '挑战记录缺失挑战时刻或等待配置版本，结论视为过期' }
  }
  if (record.waitConfigVersion !== strategy.waitConfigVersion) {
    return { ...base, valid: false, reason: 'record-from-other-config', message: '等待配置已调整，旧窗口的结论不能直接放行' }
  }
  if (!Number.isFinite(now)) {
    return { ...base, valid: false, reason: 'unable-to-determine', message: '缺少关账时刻，无法判断冷却窗口，需要重新挑战' }
  }
  if (now > record.cooldownDeadline) {
    return { ...base, valid: false, reason: 'cooldown-elapsed', message: '冷却窗口已结束，过期结论需要重新验证' }
  }
  return {
    ...base,
    valid: true,
    reason: 'reusable',
    message: `冷却窗口内，复用 ${formatClock(record.decidedAt)} 放行的挑战结论`,
  }
}

export function describeReuse(
  strategy: AntibotStrategyRecord,
  record: AntibotChallengeRecord | null,
  now: number,
): ReuseView {
  const decision = evaluateReuse(strategy, record, now)
  return {
    ...decision,
    strategy,
    record,
    evaluatedAt: Number.isFinite(now) ? now : null,
    configChangedAfterDecision: Boolean(
      record && record.decidedAt !== null && record.waitConfigVersion !== strategy.waitConfigVersion,
    ),
  }
}

export function formatClock(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* ------------------------------------------------------------------ */
/* 等待时长调整：旧窗口关账                                            */
/* ------------------------------------------------------------------ */

export type WaitConfigRevision = {
  fromVersion: string
  toVersion: string
  fromWaitMs: number
  toWaitMs: number
  effectiveAt: number
  operator: string
  /** 本次调整是否让等待时长变短。变短时旧窗口的截止时间会晚于新配置的窗口。 */
  shortened: boolean
}

export type StoredSettings = {
  waitMs: number
  waitConfigVersion: string
  revisions: WaitConfigRevision[]
}

export const DEFAULT_SETTINGS: StoredSettings = {
  waitMs: 30_000,
  waitConfigVersion: 'v1.0',
  revisions: [],
}

export function nextConfigVersion(version: string): string {
  const matched = /^v(\d+)\.(\d+)$/.exec(version)
  if (!matched) {
    return 'v1.1'
  }
  return `v${matched[1]}.${Number(matched[2]) + 1}`
}

/* ------------------------------------------------------------------ */
/* 复用清单                                                            */
/* ------------------------------------------------------------------ */

export type ReuseOutcome = 'reuse-valid' | 'reverify-elapsed' | 'reverify-config'

export type ReuseListItem = {
  id: number
  strategyNo: string
  counterStrategy: string
  challengeAt: number
  cooldownDeadline: number
  /** 产出该结论的等待配置版本，与清单当前绑定版本可能不同。 */
  waitConfigVersion: string
  /** 清单当前绑定的等待配置版本。 */
  boundConfigVersion: string
  decisionAt: number
  valid: boolean
  outcome: ReuseOutcome
  reason: ReuseDecisionReason
  note: string
  evidenceRef: string
}

export type ReuseSnapshot = {
  /** 幂等键：同一策略 + 同一挑战 + 同一配置版本只允许一条结论。 */
  key: string
  strategyNo: string
  counterStrategy: string
  challengeAt: number
  cooldownDeadline: number
  waitConfigVersion: string
  decisionAt: number
  valid: boolean
  outcome: ReuseOutcome
  reason: ReuseDecisionReason
  note: string
  evidenceRef: string
}

export function snapshotFor(
  strategy: AntibotStrategyRecord,
  record: AntibotChallengeRecord | null,
  now: number,
): ReuseSnapshot {
  const decision = evaluateReuse(strategy, record, now)
  const outcome: ReuseOutcome = decision.valid
    ? 'reuse-valid'
    : decision.reason === 'record-from-other-config'
      ? 'reverify-config'
      : 'reverify-elapsed'
  return {
    key: `${strategy.strategyNo}|${record?.id ?? 0}|${strategy.waitConfigVersion}`,
    strategyNo: strategy.strategyNo,
    counterStrategy: strategy.counterStrategy,
    challengeAt: record?.challengeAt ?? 0,
    cooldownDeadline: decision.cooldownDeadline ?? 0,
    waitConfigVersion: strategy.waitConfigVersion,
    decisionAt: now,
    valid: decision.valid,
    outcome,
    reason: decision.reason,
    note: decision.message,
    evidenceRef: `challenge:${record?.id ?? 0}`,
  }
}

/**
 * 按冷却窗口去重既有挑战记录：
 * 同一主记录下开始时间落在同一窗口（[截止时间 - 等待时长, 截止时间]）里的多条挑战只留最早的入口，
 * 避免同一次冷却里重复发起挑战。没有截止时间、或版本过旧的记录原样保留（保留证据，不删）。
 */
export function dedupeChallenges(records: AntibotChallengeRecord[]): AntibotChallengeRecord[] {
  const kept: AntibotChallengeRecord[] = []
  const seen = new Map<string, number>()
  for (const record of records) {
    const hasWindow = Number.isFinite(record.cooldownDeadline) && record.cooldownDeadline > 0
    if (!hasWindow) {
      kept.push(record)
      continue
    }
    const windowStart = record.cooldownDeadline - record.waitMs
    const key = `${record.strategyNo}|${record.counterStrategy}|${windowStart}|${record.cooldownDeadline}`
    if (seen.has(key)) {
      continue
    }
    seen.set(key, record.id)
    kept.push(record)
  }
  return kept
}

export type ReusePlan = {
  items: ReuseListItem[]
  /** 可以结论复用、无需再次挑战的条数。 */
  reused: number
  /** 结论过期、需要重新验证的条数。 */
  reverified: number
  /** 按冷却窗口去重合并掉的重复挑战条数。 */
  deduped: number
  /** 清单当前绑定的等待配置版本。 */
  boundConfigVersion: string
}

/**
 * 生成反爬挑战复用清单：
 * 去重 -> 只保留已给出结论的窗口 -> 结论绑定挑战时刻与等待配置版本 -> 用关账时刻重新判定。
 * 过期结论不会因为「曾经放行过」而被直接放行，会以 reverify-* 的条目留在清单里供复核。
 */
export function buildReusePlan(
  strategies: AntibotStrategyRecord[],
  records: AntibotChallengeRecord[],
  waitConfigVersion: string,
  now: number,
): ReusePlan {
  const deduped = dedupeChallenges(records)
  const items: ReuseListItem[] = []
  for (const record of deduped) {
    const strategy = strategies.find((item) => sameRecordIdentity(item, record))
    if (!strategy) {
      continue
    }
    const boundStrategy: AntibotStrategyRecord = { ...strategy, waitConfigVersion }
    const snapshot = snapshotFor(boundStrategy, record, now)
    const latest = items[items.length - 1]
    if (latest && latest.strategyNo === snapshot.strategyNo && latest.boundConfigVersion === snapshot.boundConfigVersion && latest.challengeAt === snapshot.challengeAt && latest.cooldownDeadline === snapshot.cooldownDeadline) {
      continue
    }
    items.push({
      id: items.length + 1,
      strategyNo: snapshot.strategyNo,
      counterStrategy: snapshot.counterStrategy,
      challengeAt: snapshot.challengeAt,
      cooldownDeadline: snapshot.cooldownDeadline,
      waitConfigVersion: record.waitConfigVersion,
      boundConfigVersion: snapshot.waitConfigVersion,
      decisionAt: snapshot.decisionAt,
      valid: snapshot.valid,
      outcome: snapshot.outcome,
      reason: snapshot.reason,
      note: snapshot.note,
      evidenceRef: snapshot.evidenceRef,
    })
  }
  return {
    items,
    reused: items.filter((item) => item.valid).length,
    reverified: items.filter((item) => !item.valid).length,
    deduped: records.length - deduped.length,
    boundConfigVersion: waitConfigVersion,
  }
}
