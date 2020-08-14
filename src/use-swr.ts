import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  useDebugValue
} from 'react'

import defaultConfig, { cache } from './config'
import isDocumentVisible from './libs/is-document-visible'
import isOnline from './libs/is-online'
import SWRConfigContext from './swr-config-context'
import {
  actionType,
  broadcastStateInterface,
  ConfigInterface,
  fetcherFn,
  keyInterface,
  mutateInterface,
  responseInterface,
  RevalidateOptionInterface,
  triggerInterface,
  updaterInterface
} from './types'

// 判断是否是服务端，用window对象代表是客户端
const IS_SERVER = typeof window === 'undefined'

// 不支持requestIdleCallback，用setTimeout模拟
const rIC = IS_SERVER
  ? null
  : window['requestIdleCallback'] || (f => setTimeout(f, 1))

// 考虑到SSR, 浏览器客户端使用useLayoutEffect，服务端使用useEffect
const useIsomorphicLayoutEffect = IS_SERVER ? useEffect : useLayoutEffect

// 全局状态管理
const CONCURRENT_PROMISES = {}
const CONCURRENT_PROMISES_TS = {}
const FOCUS_REVALIDATORS = {} // 页面可见性取数回调
const RECONNECT_REVALIDATORS = {} // 浏览器可访问网络取数回调
const CACHE_REVALIDATORS = {}
const MUTATION_TS = {}
const MUTATION_END_TS = {}

// 浏览器客户端环境，需要监听一些事件，来实现重新取数
if (!IS_SERVER && window.addEventListener) {
  // 对指定对象重新取数
  const revalidate = revalidators => {
    if (!isDocumentVisible() || !isOnline()) return

    // 遍历所有请求标识符的回调数组中第一个。为什么第一个?
    for (const key in revalidators) {
      if (revalidators[key][0]) revalidators[key][0]()
    }
  }

  // 页面可见性(visibilitychange、focus)时，重新取数
  // focus、visibilitychange可能会同时触发，所以onFocus(527行)做了节流操作
  window.addEventListener(
    'visibilitychange',
    () => revalidate(FOCUS_REVALIDATORS),
    false
  )
  window.addEventListener('focus', () => revalidate(FOCUS_REVALIDATORS), false)
  // 当浏览器能够访问网络, 重新取数
  window.addEventListener(
    'online',
    () => revalidate(RECONNECT_REVALIDATORS),
    false
  )
}

const trigger: triggerInterface = (_key, shouldRevalidate = true) => {
  // we are ignoring the second argument which correspond to the arguments
  // the fetcher will receive when key is an array
  const [key, , keyErr] = cache.serializeKey(_key)
  if (!key) return Promise.resolve()

  const updaters = CACHE_REVALIDATORS[key]

  if (key && updaters) {
    const currentData = cache.get(key)
    const currentError = cache.get(keyErr)
    const promises = []
    for (let i = 0; i < updaters.length; ++i) {
      promises.push(
        updaters[i](shouldRevalidate, currentData, currentError, i > 0)
      )
    }
    // return new updated value
    return Promise.all(promises).then(() => cache.get(key))
  }
  return Promise.resolve(cache.get(key))
}

const broadcastState: broadcastStateInterface = (key, data, error) => {
  const updaters = CACHE_REVALIDATORS[key]
  if (key && updaters) {
    for (let i = 0; i < updaters.length; ++i) {
      updaters[i](false, data, error)
    }
  }
}

const mutate: mutateInterface = async (
  _key,
  _data,
  shouldRevalidate = true
) => {
  const [key, , keyErr] = cache.serializeKey(_key)
  if (!key) return

  // if there is no new data, call revalidate against the key
  if (typeof _data === 'undefined') return trigger(_key, shouldRevalidate)

  // update timestamps
  MUTATION_TS[key] = Date.now() - 1
  MUTATION_END_TS[key] = 0

  // keep track of timestamps before await asynchronously
  const beforeMutationTs = MUTATION_TS[key]
  const beforeConcurrentPromisesTs = CONCURRENT_PROMISES_TS[key]

  let data, error

  if (_data && typeof _data === 'function') {
    // `_data` is a function, call it passing current cache value
    try {
      data = await _data(cache.get(key))
    } catch (err) {
      error = err
    }
  } else if (_data && typeof _data.then === 'function') {
    // `_data` is a promise
    try {
      data = await _data
    } catch (err) {
      error = err
    }
  } else {
    data = _data
  }

  // check if other mutations have occurred since we've started awaiting, if so then do not persist this change
  if (
    beforeMutationTs !== MUTATION_TS[key] ||
    beforeConcurrentPromisesTs !== CONCURRENT_PROMISES_TS[key]
  ) {
    if (error) throw error
    return data
  }

  if (typeof data !== 'undefined') {
    // update cached data, avoid notifying from the cache
    cache.set(key, data)
  }
  cache.set(keyErr, error)

  // reset the timestamp to mark the mutation has ended
  MUTATION_END_TS[key] = Date.now() - 1

  // enter the revalidation stage
  // update existing SWR Hooks' state
  const updaters = CACHE_REVALIDATORS[key]
  if (updaters) {
    const promises = []
    for (let i = 0; i < updaters.length; ++i) {
      promises.push(updaters[i](!!shouldRevalidate, data, error, i > 0))
    }
    // return new updated value
    return Promise.all(promises).then(() => {
      if (error) throw error
      return cache.get(key)
    })
  }
  // throw error or return data to be used by caller of mutate
  if (error) throw error
  return data
}

function useSWR<Data = any, Error = any>(
  key: keyInterface
): responseInterface<Data, Error>
function useSWR<Data = any, Error = any>(
  key: keyInterface,
  config?: ConfigInterface<Data, Error>
): responseInterface<Data, Error>
function useSWR<Data = any, Error = any>(
  key: keyInterface,
  fn?: fetcherFn<Data>,
  config?: ConfigInterface<Data, Error>
): responseInterface<Data, Error>
function useSWR<Data = any, Error = any>(
  ...args
): responseInterface<Data, Error> {
  // 根据传参不同，规范化url，请求函数，config
  let _key: keyInterface,
    fn: fetcherFn<Data> | undefined,
    config: ConfigInterface<Data, Error> = {}
  if (args.length >= 1) {
    _key = args[0]
  }
  if (args.length > 2) {
    fn = args[1]
    config = args[2]
  } else {
    if (typeof args[1] === 'function') {
      fn = args[1]
    } else if (typeof args[1] === 'object') {
      config = args[1]
    }
  }

  // 我们假设key是请求的标识符，key是可以改变的，但请求fn不应该改变，
  // 因为revalidate函数以依赖于key，keyErr是错误对象的缓存key
  const [key, fnArgs, keyErr] = cache.serializeKey(_key)

  // 合并配置，优先级：hook调用传入的config > 全局配置 > 默认配置
  config = Object.assign(
    {},
    defaultConfig,
    useContext(SWRConfigContext),
    config
  )

  console.log(config)

  const configRef = useRef(config)
  useIsomorphicLayoutEffect(() => {
    configRef.current = config
  })

  // 如果没传如请求函数，使用配置中fetcher
  if (typeof fn === 'undefined') {
    fn = config.fetcher
  }

  // 初始值（可能为空），先通过请求标识符尝试取缓存，不存在使用配置中的初始值
  const initialData = cache.get(key) || config.initialData
  // 初始错误，通过错误标识符取缓存
  const initialError = cache.get(keyErr)

  // 如果state中属性(data, error, isValidating)被访问(使用Object.defineProperties的get进行拦截)
  // 我们将对应属性变为true代表存在依赖关系，以至于执行dispatch函数(L265行)时，我们可以触发渲染
  const stateDependencies = useRef({
    data: false,
    error: false,
    isValidating: false
  })
  const stateRef = useRef({
    data: initialData,
    error: initialError,
    isValidating: false
  })

  // React DevTools debugger 显示state的data
  useDebugValue(stateRef.current.data)

  // 用于强制渲染
  const rerender = useState(null)[1]
  // 类似于redux的dispatch 用于更新state(data, error, isValidating)
  let dispatch = useCallback(payload => {
    let shouldUpdateState = false
    for (let k in payload) {
      stateRef.current[k] = payload[k]
      if (stateDependencies.current[k]) {
        shouldUpdateState = true
      }
    }
    // 如果改变的属性存在依赖关系 或者是 suspense模式
    if (shouldUpdateState || config.suspense) {
      // 组件已卸载
      if (unmountedRef.current) return
      // 强制渲染
      rerender({})
    }
  }, [])

  // 组件卸载标志位
  const unmountedRef = useRef(false)
  // 最新的请求标识符key
  const keyRef = useRef(key)

  // 触发事件，组件未卸载时，会执行config上的回调方法
  const eventsRef = useRef({
    emit: (event, ...params) => {
      if (unmountedRef.current) return
      configRef.current[event](...params)
    }
  })

  const boundMutate: responseInterface<Data, Error>['mutate'] = useCallback(
    (data, shouldRevalidate) => {
      return mutate(key, data, shouldRevalidate)
    },
    [key]
  )

  // 添加重新取数的回调
  const addRevalidator = (revalidators, callback) => {
    if (!callback) return
    if (!revalidators[key]) {
      revalidators[key] = [callback]
    } else {
      revalidators[key].push(callback)
    }
  }

  // 移除重新取数的回调
  const removeRevalidator = (revlidators, callback) => {
    if (revlidators[key]) {
      const revalidators = revlidators[key]
      const index = revalidators.indexOf(callback)
      if (index >= 0) {
        // https://jsperf.com/array-remove-by-index
        // 将最后一个回调移至待删除位置，然后删除最后一位，比splice要快速
        revalidators[index] = revalidators[revalidators.length - 1]
        revalidators.pop()
      }
    }
  }

  // 重新取数，返回布尔值Promise
  const revalidate = useCallback(
    async (
      revalidateOpts: RevalidateOptionInterface = {}
    ): Promise<boolean> => {
      // 请求标识符或请求函数不存在直接返回false
      if (!key || !fn) return false
      // 组件已卸载返回false
      if (unmountedRef.current) return false
      revalidateOpts = Object.assign({ dedupe: false }, revalidateOpts)

      // loading状态
      let loading = true
      // 是否可以使用重复请求。相同的请求未过期时(config.dedupingInterval间隔会清除一次)，并且开启了去重
      let shouldDeduping =
        typeof CONCURRENT_PROMISES[key] !== 'undefined' && revalidateOpts.dedupe

      // 开始异步请求
      try {
        dispatch({
          isValidating: true
        })

        let newData
        let startAt

        // 已经有一个正在进行的请求，需要去重，直接使用之前的就可以。
        if (shouldDeduping) {
          startAt = CONCURRENT_PROMISES_TS[key]
          newData = await CONCURRENT_PROMISES[key]
        } else {
          // 如果没有缓存，说明页面时空白状态，超时后触发网速慢的回调事件，默认是空函数
          if (config.loadingTimeout && !cache.get(key)) {
            setTimeout(() => {
              if (loading) eventsRef.current.emit('onLoadingSlow', key, config)
            }, config.loadingTimeout)
          }

          // useSWR传入数组，fnArgs是该数组，当做参数执行请求函数
          if (fnArgs !== null) {
            CONCURRENT_PROMISES[key] = fn(...fnArgs)
          } else {
            // 否则将请求标识符key当做参数传入，基本上是请求url
            CONCURRENT_PROMISES[key] = fn(key)
          }

          // 此次请求的时间戳
          CONCURRENT_PROMISES_TS[key] = startAt = Date.now()

          // 将请求结果赋值给newData
          newData = await CONCURRENT_PROMISES[key]

          // dedupingInterval时间后，删除此次请求，这段时间内，如果开启了dedupe，都可以直接用
          setTimeout(() => {
            delete CONCURRENT_PROMISES[key]
            delete CONCURRENT_PROMISES_TS[key]
          }, config.dedupingInterval)

          // 触发成功事件
          eventsRef.current.emit('onSuccess', newData, key, config)
        }

        const shouldIgnoreRequest =
          // 如果有其他正在进行的请求发生在此请求之后，我们需要忽略当前请求，以后面的为准
          CONCURRENT_PROMISES_TS[key] > startAt ||
          // 如果有其他突变，要忽略当前请求，因为它不是最新的了。
          // 同时突变结束后，一个新的取数应该被触发
          // case 1:
          //   req------------------>res
          //       mutate------>end
          // case 2:
          //         req------------>res
          //   mutate------>end
          // case 3:
          //   req------------------>res
          //       mutate-------...---------->
          (MUTATION_TS[key] &&
            // case 1
            (startAt <= MUTATION_TS[key] ||
              // case 2
              startAt <= MUTATION_END_TS[key] ||
              // case 3
              MUTATION_END_TS[key] === 0))

        if (shouldIgnoreRequest) {
          dispatch({ isValidating: false })
          return false
        }

        cache.set(key, newData)
        cache.set(keyErr, undefined)

        // 为dispatch函数创建新的state
        const newState: actionType<Data, Error> = {
          isValidating: false
        }

        // 此次请求没有发生错误，如果之前是错误，需要修改
        if (typeof stateRef.current.error !== 'undefined') {
          newState.error = undefined
        }
        // 请求结果不相等时(深度比较)，更新
        if (!config.compare(stateRef.current.data, newData)) {
          newState.data = newData
        }

        // 更新state，触发渲染。
        dispatch(newState)

        if (!shouldDeduping) {
          // also update other hooks
          broadcastState(key, newData, undefined)
        }
      } catch (err) {
        // 捕获错误， 删除此次请求的promise
        delete CONCURRENT_PROMISES[key]
        delete CONCURRENT_PROMISES_TS[key]

        // 缓存：设置错误
        cache.set(keyErr, err)

        // 发生错误不同，更新state
        if (stateRef.current.error !== err) {
          // we keep the stale data
          dispatch({
            isValidating: false,
            error: err
          })

          if (!shouldDeduping) {
            // also broadcast to update other hooks
            broadcastState(key, undefined, err)
          }
        }

        // 触发onError事件回调
        eventsRef.current.emit('onError', err, key, config)
        // 发生错误后是否进行重试
        if (config.shouldRetryOnError) {
          // 当重试时，需要启动清除重复，一直维护重试次数
          const retryCount = (revalidateOpts.retryCount || 0) + 1
          eventsRef.current.emit(
            'onErrorRetry',
            err,
            key,
            config,
            revalidate,
            Object.assign({ dedupe: true }, revalidateOpts, { retryCount })
          )
        }
      }

      loading = false
      return true
    },
    [key]
  )

  // 组件挂载
  useIsomorphicLayoutEffect(() => {
    if (!key) return undefined

    // 请求标识符key有值后，需要标记为组件已挂载
    unmountedRef.current = false

    // 组件挂载后，我们需要更新从缓存更新数据，并且触发重新取数
    const currentHookData = stateRef.current.data
    const latestKeyedData = cache.get(key) || config.initialData

    // 如果请求标识符key改变 或者 缓存和当前值不相同时
    if (
      keyRef.current !== key ||
      !config.compare(currentHookData, latestKeyedData)
    ) {
      // dispatch改变state.current.data，触发渲染(也可能不触发)
      dispatch({ data: latestKeyedData })
      // 更新key
      keyRef.current = key
    }

    // 会清除重复数据的重新取数
    const softRevalidate = () => revalidate({ dedupe: true })

    // 触发重新取数，选项挂载请求为true 或者 没设置“初始值”和“挂载请求”
    // 如果显式的设置了“挂载请求”为false，初始值没有也不会触发
    if (
      config.revalidateOnMount ||
      (!config.initialData && config.revalidateOnMount === undefined)
    ) {
      if (typeof latestKeyedData !== 'undefined') {
        // 优化：如果有缓存数据，利用requestIdleCallback API 在浏览器空闲时间重新取数，以免阻止渲染
        rIC(softRevalidate)
      } else {
        // 没有缓存数据，就必须直接取数
        softRevalidate()
      }
    }

    // 页面可见时回调，因为focus、visibilitychange可能会同时触发，所以做了节流操作
    let pending = false
    const onFocus = () => {
      if (pending || !configRef.current.revalidateOnFocus) return
      pending = true
      softRevalidate()
      setTimeout(
        () => (pending = false),
        configRef.current.focusThrottleInterval
      )
    }

    // 浏览器可访问网络时回调
    const onReconnect = () => {
      if (configRef.current.revalidateOnReconnect) {
        softRevalidate()
      }
    }

    // 缓存更新监听函数
    const onUpdate: updaterInterface<Data, Error> = (
      shouldRevalidate = true,
      updatedData,
      updatedError,
      dedupe = true
    ) => {
      // update hook state
      const newState: actionType<Data, Error> = {}
      let needUpdate = false

      if (
        typeof updatedData !== 'undefined' &&
        !config.compare(stateRef.current.data, updatedData)
      ) {
        newState.data = updatedData
        needUpdate = true
      }

      // always update error
      // because it can be `undefined`
      if (stateRef.current.error !== updatedError) {
        newState.error = updatedError
        needUpdate = true
      }

      if (needUpdate) {
        dispatch(newState)
      }

      if (shouldRevalidate) {
        if (dedupe) {
          return softRevalidate()
        } else {
          return revalidate()
        }
      }
      return false
    }

    addRevalidator(FOCUS_REVALIDATORS, onFocus)
    addRevalidator(RECONNECT_REVALIDATORS, onReconnect)
    addRevalidator(CACHE_REVALIDATORS, onUpdate)

    return () => {
      // cleanup
      dispatch = () => null

      // mark it as unmounted
      unmountedRef.current = true

      removeRevalidator(FOCUS_REVALIDATORS, onFocus)
      removeRevalidator(RECONNECT_REVALIDATORS, onReconnect)
      removeRevalidator(CACHE_REVALIDATORS, onUpdate)
    }
  }, [key, revalidate])

  // set up polling
  useIsomorphicLayoutEffect(() => {
    let timer = null
    const tick = async () => {
      if (
        !stateRef.current.error &&
        (config.refreshWhenHidden || isDocumentVisible()) &&
        (config.refreshWhenOffline || isOnline())
      ) {
        // only revalidate when the page is visible
        // if API request errored, we stop polling in this round
        // and let the error retry function handle it
        await revalidate({ dedupe: true })
      }
      if (config.refreshInterval) {
        timer = setTimeout(tick, config.refreshInterval)
      }
    }
    if (config.refreshInterval) {
      timer = setTimeout(tick, config.refreshInterval)
    }
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [
    config.refreshInterval,
    config.refreshWhenHidden,
    config.refreshWhenOffline,
    revalidate
  ])

  // suspense
  if (config.suspense) {
    // in suspense mode, we can't return empty state
    // (it should be suspended)

    // try to get data and error from cache
    let latestData = cache.get(key)
    let latestError = cache.get(keyErr)

    if (typeof latestData === 'undefined') {
      latestData = initialData
    }
    if (typeof latestError === 'undefined') {
      latestError = initialError
    }

    if (
      typeof latestData === 'undefined' &&
      typeof latestError === 'undefined'
    ) {
      // need to start the request if it hasn't
      if (!CONCURRENT_PROMISES[key]) {
        // trigger revalidate immediately
        // to get the promise
        revalidate()
      }

      if (
        CONCURRENT_PROMISES[key] &&
        typeof CONCURRENT_PROMISES[key].then === 'function'
      ) {
        // if it is a promise
        throw CONCURRENT_PROMISES[key]
      }

      // it's a value, return it directly (override)
      latestData = CONCURRENT_PROMISES[key]
    }

    if (typeof latestData === 'undefined' && latestError) {
      // in suspense mode, throw error if there's no content
      throw latestError
    }

    // return the latest data / error from cache
    // in case `key` has changed
    return {
      error: latestError,
      data: latestData,
      revalidate,
      mutate: boundMutate,
      isValidating: stateRef.current.isValidating
    }
  }

  // define returned state
  // can be memorized since the state is a ref
  return useMemo(() => {
    const state = { revalidate, mutate: boundMutate } as responseInterface<
      Data,
      Error
    >
    // 请求标识符key可能发生变化，所以key不相等时，返回初始的值
    Object.defineProperties(state, {
      error: {
        get: function() {
          stateDependencies.current.error = true
          return keyRef.current === key ? stateRef.current.error : initialError
        },
        enumerable: true
      },
      data: {
        get: function() {
          stateDependencies.current.data = true
          return keyRef.current === key ? stateRef.current.data : initialData
        },
        enumerable: true
      },
      isValidating: {
        get: function() {
          stateDependencies.current.isValidating = true
          return stateRef.current.isValidating
        },
        enumerable: true
      }
    })

    return state
  }, [revalidate])
}

const SWRConfig = SWRConfigContext.Provider

export { trigger, mutate, SWRConfig }
export default useSWR
