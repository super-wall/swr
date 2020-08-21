import { CacheInterface, keyInterface, cacheListener } from './types'
import hash from './libs/hash'

export default class Cache implements CacheInterface {
  // 缓存Map
  private __cache: Map<string, any>
  // 订阅者数组
  private __listeners: cacheListener[]

  constructor(initialData: any = {}) {
    this.__cache = new Map(Object.entries(initialData))
    this.__listeners = []
  }

  // 根据key获取缓存
  get(key: keyInterface): any {
    const [_key] = this.serializeKey(key)
    return this.__cache.get(_key)
  }

  // 设置对应key的缓存值，并且触发其他订阅者更新
  set(key: keyInterface, value: any): any {
    const [_key] = this.serializeKey(key)
    this.__cache.set(_key, value)
    this.notify()
  }

  // 获取所有key的数组
  keys() {
    return Array.from(this.__cache.keys())
  }

  // 查看是否存在对应key的缓存值
  has(key: keyInterface) {
    const [_key] = this.serializeKey(key)
    return this.__cache.has(_key)
  }

  // 清空缓存，并触发其他订阅者更新
  clear() {
    this.__cache.clear()
    this.notify()
  }

  // 删除对应key的缓存
  delete(key: keyInterface) {
    const [_key] = this.serializeKey(key)
    this.__cache.delete(_key)
    this.notify()
  }

  // 对传入的key进行序列化
  serializeKey(key: keyInterface): [string, any, string] {
    let args = null
    //  传入函数直接执行拿到key
    if (typeof key === 'function') {
      try {
        key = key()
      } catch (err) {
        // 函数中报错，可能是因为依赖取数还没有准备好导致的
        key = ''
      }
    }
    // 如果是数组，代表都是参数
    if (Array.isArray(key)) {
      args = key
      key = hash(key)
    } else {
      // 转换成字符串，null => ''
      key = String(key || '')
    }

    // 错误的key加上err@前缀
    const errorKey = key ? 'err@' + key : ''

    return [key, args, errorKey]
  }

  // 添加订阅者，返回取消订阅的函数
  subscribe(listener: cacheListener) {
    if (typeof listener !== 'function') {
      throw new Error('Expected the listener to be a function.')
    }

    let isSubscribed = true
    this.__listeners.push(listener)

    return () => {
      if (!isSubscribed) return
      isSubscribed = false
      const index = this.__listeners.indexOf(listener)
      if (index > -1) {
        this.__listeners[index] = this.__listeners[this.__listeners.length - 1]
        this.__listeners.length--
      }
    }
  }

  // 通知订阅者
  private notify() {
    for (let listener of this.__listeners) {
      listener()
    }
  }
}
