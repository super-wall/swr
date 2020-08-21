// 判断浏览器是否在线状态
export default function isOnline(): boolean {
  if (typeof navigator.onLine !== 'undefined') {
    return navigator.onLine
  }
  // 总是假设网络是在线的
  return true
}
