import AVFoundation
import Capacitor
import Speech

/// Voice for the local assistant (web/src/local/voice.ts): speech-to-text with Apple's recognizer
/// (on-device when the phone supports it, so it works offline) and spoken replies.
///
/// Events: `speech` ({text, final}) while listening, `speechEnd` when listening stops,
/// `speechError` ({message}), `speakEnd` when a reply finished or was cut off.
@objc(VoicePlugin)
public class VoicePlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    public let identifier = "VoicePlugin"
    public let jsName = "Voice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise),
    ]

    // The assistant's commands are English, so recognize and speak English.
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Bumped per listening session, so a cancelled session's late callbacks can't end the next one.
    private var session = 0
    private let synth = AVSpeechSynthesizer()
    /// Plays answers synthesized elsewhere (ElevenLabs mp3).
    private var player: AVAudioPlayer?

    override public func load() {
        synth.delegate = self
        synth.usesApplicationAudioSession = true
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve([
            "available": recognizer?.isAvailable ?? false,
            "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        ])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.resolve(["granted": false])
                return
            }
            let done: (Bool) -> Void = { ok in call.resolve(["granted": ok]) }
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission(completionHandler: done)
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission(done)
            }
        }
    }

    @objc func startListening(_ call: CAPPluginCall) {
        let hints = (call.getArray("hints") ?? []).compactMap { $0 as? String }
        DispatchQueue.main.async {
            guard let recognizer = self.recognizer, recognizer.isAvailable else {
                call.reject("Speech recognition is not available right now.")
                return
            }
            self.cancelListening()
            self.stopOutput()
            self.session += 1
            let id = self.session
            do {
                let audio = AVAudioSession.sharedInstance()
                try audio.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
                try audio.setActive(true, options: .notifyOthersOnDeactivation)

                let request = SFSpeechAudioBufferRecognitionRequest()
                request.shouldReportPartialResults = true
                if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
                request.contextualStrings = hints
                self.request = request

                let input = self.engine.inputNode
                input.removeTap(onBus: 0)
                input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                    request.append(buffer)
                }
                self.engine.prepare()
                try self.engine.start()

                self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                    guard let self = self else { return }
                    DispatchQueue.main.async {
                        guard id == self.session else { return }
                        self.handle(result: result, error: error)
                    }
                }
                call.resolve()
            } catch {
                self.finish()
                call.reject("Could not start listening: \(error.localizedDescription)")
            }
        }
    }

    private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result = result {
            notifyListeners("speech", data: ["text": result.bestTranscription.formattedString, "final": result.isFinal])
        }
        if let error = error, result == nil {
            notifyListeners("speechError", data: ["message": error.localizedDescription])
        }
        if error != nil || result?.isFinal == true { finish() }
    }

    /// Stop recording; the recognizer then delivers its final result.
    @objc func stopListening(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endAudio()
            call.resolve()
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.resolve()
            return
        }
        DispatchQueue.main.async {
            self.prepareToSpeak()
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
            self.synth.speak(utterance)
            call.resolve()
        }
    }

    /// Plays base64 audio (mp3) as a spoken answer, under the same silent-switch rules as speak().
    @objc func playAudio(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("No audio")
            return
        }
        DispatchQueue.main.async {
            self.prepareToSpeak()
            do {
                let player = try AVAudioPlayer(data: data)
                player.delegate = self
                self.player = player
                player.play()
                call.resolve()
            } catch {
                call.reject("Could not play audio: \(error.localizedDescription)")
            }
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopOutput()
            call.resolve()
        }
    }

    /// Ambient follows the Ring/Silent switch: answers are heard unless the phone is muted.
    private func prepareToSpeak() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .spokenAudio)
        try? session.setActive(true)
        stopOutput()
    }

    private func stopOutput() {
        synth.stopSpeaking(at: .immediate)
        if player?.isPlaying == true { notifyListeners("speakEnd", data: [:]) }
        player?.stop()
        player = nil
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        if player === self.player { self.player = nil }
        notifyListeners("speakEnd", data: [:])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        notifyListeners("speakEnd", data: [:])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        notifyListeners("speakEnd", data: [:])
    }

    private func endAudio() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
    }

    private func cancelListening() {
        task?.cancel()
        task = nil
        endAudio()
        request = nil
    }

    private func finish() {
        guard request != nil || task != nil else { return }
        endAudio()
        task = nil
        request = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        notifyListeners("speechEnd", data: [:])
    }
}
