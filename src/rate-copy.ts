import type { Locale } from './i18n'
export const rateCopy: Record<Locale, {message: string; turn: string; elapsed: string; finished: string}> = {
  en: { message: 'Last completed message · wall-clock average', turn: 'Last completed turn · includes tool time', elapsed: 'Turn duration', finished: 'Completed' },
  'zh-CN': { message: '最近一条完成消息 · 按消息耗时平均', turn: '最近一个完成轮次 · 含工具耗时', elapsed: '整轮耗时', finished: '完成于' },
  'zh-TW': { message: '最近一則完成訊息 · 按訊息耗時平均', turn: '最近一個完成輪次 · 含工具耗時', elapsed: '整輪耗時', finished: '完成於' }
}
