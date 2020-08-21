import deepEqual from 'fast-deep-equal'
import isDocumentVisible from './libs/is-document-visible'
import {
  ConfigInterface,
  RevalidateOptionInterface,
  revalidateType
} from './types'
import Cache from './cache'

// 缓存
const cache = new Cache()

// 发生错误重试
function onErrorRetry(
  _,
  __,
  config: ConfigInterface,
  revalidate: revalidateType,
  opts: RevalidateOptionInterface
): void {
  // 页面不可见，直接终止。页面可见时，会自动重新取数
  if (!isDocumentVisible()) {
    return
  }

  // 大于配置的重试次数，直接终止，不再进行重试
  if (
    typeof config.errorRetryCount === 'number' &&
    opts.retryCount > config.errorRetryCount
  ) {
    return
  }

  // 重试的间隔以指数形式增长
  const count = Math.min(opts.retryCount || 0, 8)
  const timeout =
    ~~((Math.random() + 0.5) * (1 << count)) * config.errorRetryInterval
  setTimeout(revalidate, timeout, opts)
}

// 客户端需要基于浏览器网络状态调整配置
// 慢连接（<= 70Kbps）
const slowConnection =
  typeof window !== 'undefined' &&
  navigator['connection'] &&
  ['slow-2g', '2g'].indexOf(navigator['connection'].effectiveType) !== -1

// 默认配置
const defaultConfig: ConfigInterface = {
  // 事件回调
  onLoadingSlow: () => {}, // 超时
  onSuccess: () => {}, // 成功
  onError: () => {}, // 发生错误
  onErrorRetry, // 发生错误重试

  // 错误重试间隔
  errorRetryInterval: (slowConnection ? 10 : 5) * 1000,
  // 页面可见时请求节流间隔
  focusThrottleInterval: 5 * 1000,
  // 重复数据存在的间隔，
  dedupingInterval: 2 * 1000,
  // 请求超时时间
  loadingTimeout: (slowConnection ? 5 : 3) * 1000,
  // 刷新数据间隔，0代表不刷新
  refreshInterval: 0,
  // 页面可见时是否需要重新请求
  revalidateOnFocus: true,
  // 浏览器网络重新连接时是否需要重新请求
  revalidateOnReconnect: true,
  // 页面不可见时，是否需要刷新
  refreshWhenHidden: false,
  // 浏览器无网络时，是否需要刷新
  refreshWhenOffline: false,
  // 发生错误后是否进行重试
  shouldRetryOnError: true,
  // 是否是Concurrent模式
  suspense: false,
  // 比较data值函数，默认是深比较
  compare: deepEqual
}

export { cache }
export default defaultConfig
