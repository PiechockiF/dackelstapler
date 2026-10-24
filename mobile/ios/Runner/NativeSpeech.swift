import AVFoundation
import Flutter

/// On-device spoken replies (`sitetwin/speech`), used when server text-to-speech is unavailable.
/// Channel handlers and delegate callbacks are funnelled onto the main thread.
final class NativeSpeech: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
  private let channel: FlutterMethodChannel
  private let synthesizer = AVSpeechSynthesizer()

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "sitetwin/speech", binaryMessenger: messenger)
    super.init()
    synthesizer.delegate = self
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(nil)
        return
      }
      switch call.method {
      case "speak":
        let arguments = call.arguments as? [String: Any]
        if let text = arguments?["text"] as? String, !text.isEmpty {
          self.speak(text, language: arguments?["language"] as? String)
        }
        result(nil)
      case "stop":
        self.synthesizer.stopSpeaking(at: .immediate)
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func speak(_ text: String, language: String?) {
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
    try? session.setActive(true)
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = AVSpeechSynthesisVoice(language: language ?? AVSpeechSynthesisVoice.currentLanguageCode())
    utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * 1.05)
    synthesizer.speak(utterance)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finished()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finished()
  }

  private func finished() {
    DispatchQueue.main.async {
      guard !self.synthesizer.isSpeaking else { return }
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      self.channel.invokeMethod("speechEnded", arguments: nil)
    }
  }
}
