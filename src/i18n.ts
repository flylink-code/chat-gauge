export type Locale = 'en' | 'zh-CN' | 'zh-TW'

export function resolveLocale(preference: unknown, system = Intl.DateTimeFormat().resolvedOptions().locale): Locale {
  if (preference === 'en' || preference === 'zh-CN' || preference === 'zh-TW') return preference
  try {
    const locale = new Intl.Locale(system.replaceAll('_', '-'))
    if (locale.language === 'zh') return locale.maximize().script === 'Hant' ? 'zh-TW' : 'zh-CN'
  } catch { /* Use the default translation for an invalid locale. */ }
  return 'en'
}

const en = {
  loading: 'Checking local chats…', unavailable: 'Could not read local Orca session metadata.',
  empty: 'No local agent chats in this workspace.',
  waiting: 'No usage reported for this chat yet.', missing: 'No matching agent metrics yet.', ready: 'Latest metrics',
  working: 'Working', idle: 'Idle', waitingState: 'Waiting', blocked: 'Blocked', unknown: 'Unknown',
  workspace: 'Local chats · Current workspace', selectChat: 'Chat to monitor', chooseChat: 'Choose a chat',
  context: 'Context window', contextUsed: 'Context window used', tokens: 'tokens',
  used: 'Used', high: 'High usage', nearLimit: 'Near limit', estimated: 'Estimated', reported: 'Reported',
  contextUnavailable: 'No context estimate yet', windowUnknown: 'Window unknown', windowLimit: 'Limit', updated: 'Updated',
  throughput: 'Average throughput', lastRequest: 'Last request · includes first-token wait',
  timingUnavailable: 'Request timing not available', details: 'Details', model: 'Model',
  input: 'Input incl. cache', output: 'Output', duration: 'Request duration', requestRecorded: 'Request recorded',
  contextTokens: 'Context tokens'
}

type Copy = typeof en
const zhCN: Copy = {
  loading: '正在查找本机对话…', unavailable: '无法读取本机 Orca 会话数据。',
  empty: '当前工作区没有本机 Agent 对话。',
  waiting: '该对话还没有用量数据。', missing: '暂未找到该对话的指标。', ready: '最新指标',
  working: '运行中', idle: '空闲', waitingState: '等待中', blocked: '已阻塞', unknown: '未知',
  workspace: '本机对话 · 当前工作区', selectChat: '监控对话', chooseChat: '选择对话',
  context: '上下文窗口', contextUsed: '上下文窗口占用', tokens: 'token',
  used: '已用', high: '占用较高', nearLimit: '接近上限', estimated: '估算值', reported: '报告值',
  contextUnavailable: '暂无上下文数据', windowUnknown: '窗口上限未知', windowLimit: '上限', updated: '更新于',
  throughput: '平均吞吐', lastRequest: '最近一次请求 · 含首 token 等待',
  timingUnavailable: '暂无请求计时数据', details: '请求明细', model: '模型',
  input: '输入（含缓存）', output: '输出', duration: '请求耗时', requestRecorded: '请求记录于',
  contextTokens: '上下文 token'
}
const zhTW: Copy = {
  loading: '正在尋找本機對話…', unavailable: '無法讀取本機 Orca 工作階段資料。',
  empty: '目前工作區沒有本機 Agent 對話。',
  waiting: '這個對話還沒有用量資料。', missing: '暫未找到這個對話的指標。', ready: '最新指標',
  working: '執行中', idle: '閒置', waitingState: '等待中', blocked: '已阻擋', unknown: '未知',
  workspace: '本機對話 · 目前工作區', selectChat: '監控對話', chooseChat: '選擇對話',
  context: '上下文視窗', contextUsed: '上下文視窗用量', tokens: 'token',
  used: '已用', high: '用量偏高', nearLimit: '接近上限', estimated: '估算值', reported: '回報值',
  contextUnavailable: '暫無上下文資料', windowUnknown: '視窗上限未知', windowLimit: '上限', updated: '更新於',
  throughput: '平均輸出速率', lastRequest: '最近一次請求 · 含首 token 等待',
  timingUnavailable: '暫無請求計時資料', details: '請求明細', model: '模型',
  input: '輸入（含快取）', output: '輸出', duration: '請求耗時', requestRecorded: '請求記錄於',
  contextTokens: '上下文 token'
}

const copy: Record<Locale, Copy> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW }
export const messages = (locale: Locale) => copy[locale]
export const contextCopy = {
  en: {
    free: 'Remaining', cache: 'Prompt cache hit rate', last: 'Last completed request', breakdown: 'Context breakdown',
    deferred: 'deferred', missing: 'This agent has not reported a breakdown.', agy: 'Orca records context totals for Antigravity, without a breakdown or cache usage.',
    agyRate: 'No completed turn could be matched to a complete Antigravity output count.',
    occupied: 'Reported occupied categories · Area by token count', outside: 'Free, reserved, or deferred', previous: 'Previous report'
  },
  'zh-CN': {
    free: '剩余', cache: '提示词缓存命中率', last: '最近一次已完成请求', breakdown: '上下文构成',
    deferred: '按需加载', missing: '此 Agent 未报告分类明细。', agy: 'Orca 记录了 Antigravity 的上下文总量，但没有分类或缓存明细。',
    agyRate: '未能为已完成的轮次匹配完整的 Antigravity 输出 token 数。',
    occupied: '已占用分类 · 面积按 token 数分配', outside: '剩余、预留或按需加载', previous: '上次报告'
  },
  'zh-TW': {
    free: '剩餘', cache: '提示詞快取命中率', last: '最近一次已完成請求', breakdown: '上下文構成',
    deferred: '按需載入', missing: '此 Agent 未回報分類明細。', agy: 'Orca 記錄了 Antigravity 的上下文總量，但沒有分類或快取明細。',
    agyRate: '未能為已完成的輪次配對完整的 Antigravity 輸出 token 數。',
    occupied: '已占用分類 · 面積按 token 數分配', outside: '剩餘、預留或按需載入', previous: '上次報告'
  }
}

const timestamps = new Map<Locale, Intl.DateTimeFormat>()

export function localTimestamp(time: number, locale: Locale): string {
  let formatter = timestamps.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    timestamps.set(locale, formatter)
  }
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? formatter.format(date) : '—'
}
