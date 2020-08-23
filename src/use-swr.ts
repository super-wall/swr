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

// 尽量将请求时机提前，考虑到SSR, 浏览器客户端使用useLayoutEffect，服务端使用useEffect
const useIsomorphicLayoutEffect = IS_SERVER ? useEffect : useLayoutEffect

/* 全局状态管理 */
// 存储请求的promise  key => promise
const CONCURRENT_PROMISES = {}
// 存储请求的时间戳    key => timestamp
const CONCURRENT_PROMISES_TS = {}
// 存储页面可见时的回调函数  key => callback
const FOCUS_REVALIDATORS = {}
// 浏览器网络重新连接时的回调函数  key => callback
const RECONNECT_REVALIDATORS = {}
// 缓存值改变时的回调函数（需要同步其他相同请求的结果值）  key => callback
const CACHE_REVALIDATORS = {}
// 触发突变的时间戳（手动改变缓存时触发的时间）key => timestamp
const MUTATION_TS = {}
// 触发突变结束的时间戳（手动改变缓存时触发结束的时间）key => timestamp
const MUTATION_END_TS = {}

// 浏览器客户端环境，需要监听一些事件（页面可见，浏览器重新连接），来实现重新取数
if (!IS_SERVER && window.addEventListener) {
  // 对指定对象重新取数
  const revalidate = revalidators => {
    // 页面不可见，无网络情况直接终止
    if (!isDocumentVisible() || !isOnline()) return

    // 遍历所有请求标识符的回调数组中第一个
    // 因为重新取数成功后，会执行同步操作（broadcastState函数），所以只执行一个取数回调函数就可以。
    for (const key in revalidators) {
      if (revalidators[key][0]) revalidators[key][0]()
    }
  }

  // 页面可见性(visibilitychange、focus)时，重新取数
  // focus、visibilitychange可能会同时触发，所以onFocus(527行)会做节流操作
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

// 通过key找到缓存值，然后同步数据，返回promise，resolve更新后的值
// 默认会重新请求，请求可能就会导致结果变，所以返回更新后最新的值
const trigger: triggerInterface = (_key, shouldRevalidate = true) => {
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
    // 返回更新后的值
    return Promise.all(promises).then(() => cache.get(key))
  }
  return Promise.resolve(cache.get(key))
}

// 当一个请求返回最新结果，也要更新其他相同请求标识符key的state
// 只做同步数据，不重新请求
const broadcastState: broadcastStateInterface = (key, data, error) => {
  const updaters = CACHE_REVALIDATORS[key]
  if (key && updaters) {
    for (let i = 0; i < updaters.length; ++i) {
      // 执行的是onUpdate函数
      updaters[i](false, data, error)
    }
  }
}

// 突变，改变缓存数据
const mutate: mutateInterface = async (
  _key,
  _data,
  shouldRevalidate = true
) => {
  const [key, , keyErr] = cache.serializeKey(_key)
  if (!key) return

  // 如果没有传要改变的数据，那么直接触发一次重新取数
  if (typeof _data === 'undefined') return trigger(_key, shouldRevalidate)

  // 更新突变的时间戳
  MUTATION_TS[key] = Date.now() - 1
  MUTATION_END_TS[key] = 0

  // 在异步等待前跟踪时间戳，保存上次时间戳
  const beforeMutationTs = MUTATION_TS[key]
  const beforeConcurrentPromisesTs = CONCURRENT_PROMISES_TS[key]

  let data, error

  if (_data && typeof _data === 'function') {
    // 传入是函数，将缓存值交给函数处理
    try {
      data = await _data(cache.get(key))
    } catch (err) {
      error = err
    }
  } else if (_data && typeof _data.then === 'function') {
    // 传入的是promise，直接await结果
    try {
      data = await _data
    } catch (err) {
      error = err
    }
  } else {
    // 否则是直接复制m
    data = _data
  }

  // 突变过程中，发生过其他突变或者取数，时间不相等，我们不保留这次变化
  if (
    beforeMutationTs !== MUTATION_TS[key] ||
    beforeConcurrentPromisesTs !== CONCURRENT_PROMISES_TS[key]
  ) {
    if (error) throw error
    return data
  }

  if (typeof data !== 'undefined') {
    // 更新缓存值
    cache.set(key, data)
  }
  // 更新缓存值
  cache.set(keyErr, error)

  // 突变结束后，更新结束时间
  MUTATION_END_TS[key] = Date.now() - 1

  // 进入同步过程，shouldRevalidate为true会重新请求，更新现有的swr hooks状态
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

  // configRef始终是最新的配置
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
      // 如果调用者被依赖（有使用），则应该触发更新
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

  // 触发事件，会执行config上的回调方法（onLoadingSlow、onSuccess、onError、onErrorRetry）
  const eventsRef = useRef({
    emit: (event, ...params) => {
      // 组件未卸载时，不需要触发
      if (unmountedRef.current) return
      configRef.current[event](...params)
    }
  })

  // 突变，改变缓存数据
  const boundMutate: responseInterface<Data, Error>['mutate'] = useCallback(
    (data, shouldRevalidate) => {
      return mutate(key, data, shouldRevalidate)
    },
    [key]
  )

  // 往全局Map上添加重新取数的回调
  const addRevalidator = (revalidators, callback) => {
    if (!callback) return
    if (!revalidators[key]) {
      revalidators[key] = [callback]
    } else {
      revalidators[key].push(callback)
    }
  }

  // 从全局Map上移除重新取数的回调
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

          // dedupingInterval时间后，从对象上删除此次请求，这段时间内，如果开启了dedupe，都可以直接用
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
          // 同时 突变结束后，一个新的取数应该被触发
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
          // 同时更新其他钩子函数
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
          dispatch({
            isValidating: false,
            error: err
          })

          if (!shouldDeduping) {
            // 同时更新其他钩子函数
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

  // 组件挂载，会进行请求取数
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

    // 会清除重复数据的重新取数，一定间隔内，会保存请求，碰到重复的，直接使用之前的。
    const softRevalidate = () => revalidate({ dedupe: true })

    // 触发重新取数，选项挂载请求为true 或者 没设置“初始值”和“挂载请求”
    // 如果显式的设置了“挂载请求”为false，初始值没有也不会触发
    if (
      config.revalidateOnMount ||
      (!config.initialData && config.revalidateOnMount === undefined)
    ) {
      if (typeof latestKeyedData !== 'undefined') {
        // 优化：如果有缓存数据，利用requestIdleCallback API 在浏览器空闲时间重新取数，以免阻塞渲染
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

    // 数据有更新的时候回调，shouldRevalidate代表是否重新取数
    const onUpdate: updaterInterface<Data, Error> = (
      shouldRevalidate = true,
      updatedData,
      updatedError,
      dedupe = true
    ) => {
      // 更新state
      const newState: actionType<Data, Error> = {}
      let needUpdate = false

      // 比较不相同时，更新
      if (
        typeof updatedData !== 'undefined' &&
        !config.compare(stateRef.current.data, updatedData)
      ) {
        newState.data = updatedData
        needUpdate = true
      }

      // 总是更新错误，因为它可能是undefined
      if (stateRef.current.error !== updatedError) {
        newState.error = updatedError
        needUpdate = true
      }

      // 有变更，触发更新
      if (needUpdate) {
        dispatch(newState)
      }

      // 是否重新取数
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
      // 清除
      dispatch = () => null

      // 标记为卸载
      unmountedRef.current = true

      // 移除回调函数
      removeRevalidator(FOCUS_REVALIDATORS, onFocus)
      removeRevalidator(RECONNECT_REVALIDATORS, onReconnect)
      removeRevalidator(CACHE_REVALIDATORS, onUpdate)
    }
  }, [key, revalidate])

  // 轮询，依赖项：refreshInterval(轮询间隔)、refreshWhenHidden(页面不可见时是否刷新)、refreshWhenOffline(无网络情况是否刷新)
  useIsomorphicLayoutEffect(() => {
    let timer = null
    const tick = async () => {
      // 默认：发生错误 或者 页面不可见 或者 无网络情况 都不会重新取数
      // 可以设置 refreshWhenHidden、refreshWhenOffline为true，也会触发取数
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
      // 继续轮询
      if (config.refreshInterval) {
        timer = setTimeout(tick, config.refreshInterval)
      }
    }
    // config.refreshInterval默认是0，所以不会轮询。每次轮询都会执行tick函数
    if (config.refreshInterval) {
      timer = setTimeout(tick, config.refreshInterval)
    }
    // 返回清理函数
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [
    config.refreshInterval,
    config.refreshWhenHidden,
    config.refreshWhenOffline,
    revalidate
  ])

  // 异步组件 suspense模式，我们不能返回空状态，它应该是被暂停等待的
  if (config.suspense) {
    // 尝试从缓存中取值
    let latestData = cache.get(key)
    let latestError = cache.get(keyErr)

    // 缓存不存在时，使用初始值。
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
      // 如果还没有发起请求，需要开始进行请求
      if (!CONCURRENT_PROMISES[key]) {
        revalidate()
      }

      if (
        CONCURRENT_PROMISES[key] &&
        typeof CONCURRENT_PROMISES[key].then === 'function'
      ) {
        // 如果是promise，直接抛出promise错误，实现suspense
        throw CONCURRENT_PROMISES[key]
      }

      // 如果是普通值，直接返回
      latestData = CONCURRENT_PROMISES[key]
    }

    // 在suspense模式下，如果没有内容则抛出错误
    if (typeof latestData === 'undefined' && latestError) {
      throw latestError
    }

    // 从缓存返回最新数据/错误，以防“key”已更改
    return {
      error: latestError,
      data: latestData,
      revalidate,
      mutate: boundMutate,
      isValidating: stateRef.current.isValidating
    }
  }

  // 定义返回值 { revalidate, mutate, error, data, isValidating }
  // 其中后三个通过设置get、set来维护是否被依赖，如果某值改变时，没有被依赖（调用者没有使用），就不会触发组件更新。
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
