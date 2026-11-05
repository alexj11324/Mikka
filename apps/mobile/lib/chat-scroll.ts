/** Scroll state is independent of renders: incoming content must not move a reader in history. */
export class ChatScrollPosition {
  private following = true
  private height = 0
  private y = 0
  private prepend: { height: number; y: number } | null = null
  reset() { this.following = true; this.height = 0; this.y = 0; this.prepend = null }
  onScroll(y: number, height: number, viewport: number) {
    this.y = y; this.height = height
    this.following = height - viewport - y <= 80
    return this.following
  }
  pause() { this.following = false }
  latest() { this.following = true; this.prepend = null }
  preservePrepend() { this.prepend = { height: this.height, y: this.y }; this.following = false }
  onResize(height: number): 'end' | number | null {
    this.height = height
    if (this.prepend) {
      const y = Math.max(0, this.prepend.y + height - this.prepend.height)
      this.prepend = null; this.y = y
      return y
    }
    return this.following ? 'end' : null
  }
}
