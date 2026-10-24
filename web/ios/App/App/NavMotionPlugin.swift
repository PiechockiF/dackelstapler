import Capacitor
import CoreMotion
import UIKit

/// Motion sensors for indoor walking navigation (web/src/nav/motion.ts).
///
/// Emits `step` events ({t, yaw, amplitude}) detected from the vertical acceleration, and `heading`
/// events ({t, yaw}) at ~10 Hz. `yaw` is the gyro integrated around the vertical axis: radians,
/// counter-clockwise seen from above, arbitrary zero. No magnetometer, so steel structures and
/// machines don't disturb it, and CMMotionManager device motion needs no permission prompt.
@objc(NavMotionPlugin)
public class NavMotionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NavMotionPlugin"
    public let jsName = "NavMotion"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let manager = CMMotionManager()
    private let rate = 50.0

    // Step detector state.
    private var filtered = 0.0
    private var prev = 0.0
    private var prevPrev = 0.0
    private var minSinceStep = 0.0
    private var lastStep = 0.0
    // Integrated yaw.
    private var yaw = 0.0
    private var lastTimestamp: TimeInterval?
    private var lastHeadingEmit = 0.0

    /// Low-pass at ~3 Hz for a 50 Hz stream.
    private let alpha = 0.27
    /// Peak of the smoothed vertical acceleration (g) and peak-to-valley swing that count as a step.
    private let peakThreshold = 0.07
    private let minSwing = 0.12
    private let minStepInterval = 0.28

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": manager.isDeviceMotionAvailable])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard manager.isDeviceMotionAvailable else {
            call.reject("Device motion is not available on this device")
            return
        }
        DispatchQueue.main.async {
            self.reset()
            UIApplication.shared.isIdleTimerDisabled = true
            self.manager.deviceMotionUpdateInterval = 1.0 / self.rate
            // Gyro + accelerometer only; the reference frame's zero is arbitrary.
            self.manager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] motion, _ in
                if let motion = motion { self?.process(motion) }
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.manager.stopDeviceMotionUpdates()
            UIApplication.shared.isIdleTimerDisabled = false
            call.resolve()
        }
    }

    deinit {
        manager.stopDeviceMotionUpdates()
    }

    private func reset() {
        filtered = 0; prev = 0; prevPrev = 0; minSinceStep = 0; lastStep = 0
        yaw = 0; lastTimestamp = nil; lastHeadingEmit = 0
    }

    private func process(_ m: CMDeviceMotion) {
        let g = m.gravity
        let gNorm = max(1e-6, sqrt(g.x * g.x + g.y * g.y + g.z * g.z))
        // Unit "up" in device coordinates (gravity points down).
        let ux = -g.x / gNorm, uy = -g.y / gNorm, uz = -g.z / gNorm

        // Yaw: rotation rate about the vertical axis, independent of how the phone is held.
        let r = m.rotationRate
        if let last = lastTimestamp {
            let dt = min(0.1, max(0, m.timestamp - last))
            yaw += (r.x * ux + r.y * uy + r.z * uz) * dt
            yaw = atan2(sin(yaw), cos(yaw))
        }
        lastTimestamp = m.timestamp

        // Steps: peaks of the smoothed vertical acceleration.
        let a = m.userAcceleration
        let vertical = a.x * ux + a.y * uy + a.z * uz
        filtered += alpha * (vertical - filtered)
        minSinceStep = min(minSinceStep, filtered)
        let t = m.timestamp
        if prev > prevPrev && prev >= filtered && prev > peakThreshold && t - lastStep > minStepInterval {
            let swing = prev - minSinceStep
            if swing > minSwing {
                lastStep = t
                minSinceStep = prev
                notifyListeners("step", data: ["t": Date().timeIntervalSince1970 * 1000, "yaw": yaw, "amplitude": swing])
            }
        }
        prevPrev = prev
        prev = filtered

        if t - lastHeadingEmit >= 0.1 {
            lastHeadingEmit = t
            notifyListeners("heading", data: ["t": Date().timeIntervalSince1970 * 1000, "yaw": yaw])
        }
    }
}
