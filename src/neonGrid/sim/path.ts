export type Vec2 = { x: number; y: number }

export class PolylinePath {
  private points: Vec2[]
  private segmentLengths: number[]
  private totalLength: number

  constructor(points: Vec2[]) {
    if (points.length < 2) throw new Error('Path needs >= 2 points')
    this.points = points
    this.segmentLengths = []
    let total = 0
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]
      const b = points[i + 1]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      this.segmentLengths.push(len)
      total += len
    }
    this.totalLength = Math.max(1e-6, total)
  }

  getLength(): number {
    return this.totalLength
  }

  sample(t01: number): Vec2 {
    const t = Math.max(0, Math.min(1, t01))
    let dist = t * this.totalLength

    for (let i = 0; i < this.segmentLengths.length; i++) {
      const segLen = this.segmentLengths[i]
      if (dist <= segLen) {
        const a = this.points[i]
        const b = this.points[i + 1]
        const u = segLen <= 0 ? 0 : dist / segLen
        return {
          x: a.x + (b.x - a.x) * u,
          y: a.y + (b.y - a.y) * u,
        }
      }
      dist -= segLen
    }

    return this.points[this.points.length - 1]
  }
}
