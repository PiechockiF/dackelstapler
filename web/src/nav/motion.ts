// Motion sensors for navigation. On iOS: the NavMotion plugin (ios/App/App/NavMotionPlugin.swift) counts
// steps from the accelerometer and integrates the gyro into a yaw. In a browser: a simulated walker.
import { registerPlugin, WebPlugin, type PluginListenerHandle } from '@capacitor/core'
import { bearingAt, pointAt, wrap, type NavPath } from './pdr'

/** yaw: radians, counter-clockwise seen from above, arbitrary zero (no compass). */
export interface StepEvent { t: number; yaw: number; amplitude?: number }
export interface HeadingEvent { t: number; yaw: number }

export interface NavMotionPlugin {
  isAvailable(): Promise<{ available: boolean }>
  start(): Promise<void>
  stop(): Promise<void>
  addListener(event: 'step', fn: (e: StepEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'heading', fn: (e: HeadingEvent) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

const DEG = Math.PI / 180

/**
 * Walks the route for real (ground truth) and reports what a phone would: steps with a slightly longer
 * stride than the default, a noisy and drifting yaw with an arbitrary zero. ←/→ veer off, space pauses.
 */
export class SimMotion extends WebPlugin {
  private path: NavPath | null = null
  private leg = 0
  private s = 0
  private walking = false
  private paused = false
  private veer = 0
  private timers: number[] = []
  private started = 0
  private x = 0
  private y = 0
  private onLeg = true
  /** Where the fake gyro's zero points, and its drift (rad/s). */
  private zero = 1.1
  private drift = 3 * DEG / 60
  private stride = 0.74

  async isAvailable() { return { available: true } }

  async start() {
    this.stop()
    this.started = performance.now()
    this.timers.push(window.setInterval(() => this.notifyListeners('heading', { t: Date.now(), yaw: this.yaw() }), 100))
    this.timers.push(window.setInterval(() => this.tick(), 1000 / 1.8))
    window.addEventListener('keydown', this.onKey)
  }

  async stop() {
    this.timers.forEach((t) => window.clearInterval(t))
    this.timers = []
    this.walking = false
    window.removeEventListener('keydown', this.onKey)
  }

  setPath(path: NavPath) {
    this.path = path
    this.leg = 0
    this.s = 0
    this.veer = 0
    this.onLeg = true
    const p = path.legs[0]?.pts[0] ?? [0, 0]
    ;[this.x, this.y] = p
  }

  setWalking(walking: boolean) { this.walking = walking }

  /** The walker took the stairs/lift (the app confirmed the floor change). */
  nextLeg() {
    if (!this.path || this.leg >= this.path.legs.length - 1) return
    this.leg++
    this.s = 0
    this.onLeg = true
    ;[this.x, this.y] = this.path.legs[this.leg].pts[0]
  }

  /** True plan bearing the simulated person faces. */
  private trueHeading() {
    const leg = this.path?.legs[this.leg]
    if (!leg) return 0
    return wrap((this.onLeg ? bearingAt(leg, this.s) : this.offHeading) + this.veer)
  }
  private offHeading = 0

  private yaw() {
    const t = (performance.now() - this.started) / 1000
    // A little sway per step plus slow drift; the zero is arbitrary like a real gyro.
    return wrap(this.trueHeading() - this.zero + this.drift * t + (Math.random() - 0.5) * 6 * DEG)
  }

  private tick() {
    const leg = this.path?.legs[this.leg]
    if (!leg || !this.walking || this.paused) return
    const atEnd = this.onLeg && this.s >= leg.length - 0.3
    if (atEnd) return // waiting at the stairs / arrived
    const stride = this.stride * (0.92 + Math.random() * 0.16)
    if (this.veer && this.onLeg) {
      this.onLeg = false
      this.offHeading = bearingAt(leg, this.s)
      ;[this.x, this.y] = pointAt(leg, this.s)
    }
    if (this.onLeg) {
      this.s = Math.min(leg.length, this.s + stride)
      ;[this.x, this.y] = pointAt(leg, this.s)
    } else {
      const h = this.trueHeading()
      this.x += stride * Math.cos(h)
      this.y += stride * Math.sin(h)
    }
    this.notifyListeners('step', { t: Date.now(), yaw: this.yaw(), amplitude: 0.4 * (stride / 0.7) ** 2 })
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest('input, textarea')) return
    if (e.key === 'ArrowLeft') this.veer += 40 * DEG
    else if (e.key === 'ArrowRight') this.veer -= 40 * DEG
    else if (e.key === ' ') this.paused = !this.paused
    else return
    e.preventDefault()
  }

  /** Back on the route (after a reroute the new route starts where the walker is). */
  rejoin(path: NavPath) {
    this.path = path
    this.leg = 0
    this.veer = 0
    this.onLeg = true
    const leg = path.legs[0]
    let best = { s: 0, d: Infinity }
    for (let i = 0; leg && i < leg.pts.length; i++) {
      const d = Math.hypot(leg.pts[i][0] - this.x, leg.pts[i][1] - this.y)
      if (d < best.d) best = { s: leg.cum[i], d }
    }
    this.s = best.s
  }
}

export const sim = new SimMotion()
export const NavMotion = registerPlugin<NavMotionPlugin>('NavMotion', { web: () => sim })
