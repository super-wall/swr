// 判断是否页面可见
export default function isDocumentVisible(): boolean {
  if (
    typeof document !== 'undefined' &&
    typeof document.visibilityState !== 'undefined'
  ) {
    return document.visibilityState !== 'hidden'
  }
  // 不是客户端，总是假设它是可见的
  return true
}
