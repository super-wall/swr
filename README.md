# useSWR库源码学习

## 调试前准备

1. 连接到全局，实时编译
```bash
# 连接到全局
npm link
# 下载依赖
yarn
# 开启watch，编辑源代码实时编译
yarn watch
```

2. 进入示例项目，连接

```bash
cd example/basic
# 下载依赖
yarn
# 将swr、react、react-dom链接到外层目录，保持react版本一致
npm link swr
npm link react
npm link react-dom 
# 执行dev
yarn dev
```

## 知识点

- 为了将请求时机提前，主体代码放在了 UI 渲染前（`useLayoutEffect`），并兼容了服务端场景（`useEffect`）
- 当请求存在缓存时，利用`requestIdleCallback`使取数发生在浏览器空闲时间，以免阻止渲染
- 通过Object.defineProperty对属性get进行拦截，修改是否被依赖的标志位`stateDependencies`。当没被依赖的属性更新时，可以做到不渲染。
- `navigator.connection.effectiveType`可以查看当前网络状态，网络慢时，适当延长了超时(`loadingTimeout`)时间、错误重试(`errorRetryInterval`)间隔。

  

