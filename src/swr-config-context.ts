import { createContext } from 'react'

import { ConfigInterface } from './types'

// 创建上下文，注入默认配置，优先级大于系统默认配置defaultConfig
const SWRConfigContext = createContext<ConfigInterface>({})
SWRConfigContext.displayName = 'SWRConfigContext'

export default SWRConfigContext
