import type { Locale } from './i18n'
export const rateCopy: Record<Locale, {message: string; turn: string; elapsed: string; finished: string; decode: string; decodeNote: string; firstToken: string}> = {
  en: { message: 'Last completed message · wall-clock average', turn: 'Last completed turn · includes tool time', elapsed: 'Turn duration', finished: 'Completed',
    decode: 'Decode speed', decodeNote: 'Model streaming only · excludes first-token wait and tools · {n} calls', firstToken: 'First token (median)' },
  'zh-CN': { message: '最近一条完成消息 · 按消息耗时平均', turn: '最近一个完成轮次 · 含工具耗时', elapsed: '整轮耗时', finished: '完成于',
    decode: '解码速度', decodeNote: '仅模型流式输出 · 不含首 token 等待与工具 · {n} 次调用', firstToken: '首 token 延迟（中位数）' },
  'zh-TW': { message: '最近一則完成訊息 · 按訊息耗時平均', turn: '最近一個完成輪次 · 含工具耗時', elapsed: '整輪耗時', finished: '完成於',
    decode: '解碼速度', decodeNote: '僅模型串流輸出 · 不含首 token 等待與工具 · {n} 次呼叫', firstToken: '首 token 延遲（中位數）' }
}
