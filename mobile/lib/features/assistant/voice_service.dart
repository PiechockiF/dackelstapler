import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:just_audio/just_audio.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../../core/api_client.dart';

enum VoiceMode { server, device }

class VoiceUnavailable implements Exception {
  const VoiceUnavailable(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Text worth speaking: no parenthetical notes or markdown, at most ~600 characters.
String speakable(String text) {
  final cleaned = text
      .replaceAll(RegExp(r'\([^)]*\)'), '')
      .replaceAll(RegExp(r'[*_#`>|]'), '')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return cleaned.length <= 600 ? cleaned : cleaned.substring(0, 600);
}

bool looksGerman(String text) =>
    RegExp(r'[äöüß]|\b(der|die|das|ist|wo|bitte|ich|nicht|zum|zur)\b', caseSensitive: false).hasMatch(text);

/// Server speech (ElevenLabs via the backend) when configured, otherwise on-device recognition and synthesis.
class VoiceService {
  VoiceService(this._api) {
    _native.setMethodCallHandler((call) async {
      if (call.method == 'speechEnded') _finishSpeaking();
    });
  }

  static const _native = MethodChannel('sitetwin/speech');

  final ApiClient _api;
  final _recorder = AudioRecorder();
  final _player = AudioPlayer();
  final _speech = SpeechToText();
  bool? _serverVoice;
  bool _deviceSpeechReady = false;
  void Function()? _onSpeechDone;

  Future<bool> _serverAvailable() async {
    final known = _serverVoice;
    if (known != null) return known;
    try {
      final health = await _api.health();
      return _serverVoice = health['voice'] == true;
    } on ApiException {
      return _serverVoice = false;
    }
  }

  /// Starts capturing a question. Device recognition streams transcripts to [onTranscript].
  Future<VoiceMode> startListening({required void Function(String text, bool isFinal) onTranscript}) async {
    if (await _serverAvailable() && await _recorder.hasPermission()) {
      final directory = await getTemporaryDirectory();
      final path = p.join(directory.path, 'question-${DateTime.now().microsecondsSinceEpoch}.m4a');
      await _recorder.start(const RecordConfig(encoder: AudioEncoder.aacLc), path: path);
      return VoiceMode.server;
    }
    if (!_deviceSpeechReady) {
      _deviceSpeechReady = await _speech.initialize();
    }
    if (!_deviceSpeechReady) {
      throw const VoiceUnavailable(
        'Speech recognition is unavailable. Allow microphone and speech recognition for SiteTwin in Settings.',
      );
    }
    await _speech.listen(
      onResult: (result) => onTranscript(result.recognizedWords, result.finalResult),
      listenOptions: SpeechListenOptions(
        partialResults: true,
        listenFor: const Duration(seconds: 30),
        pauseFor: const Duration(seconds: 3),
      ),
    );
    return VoiceMode.device;
  }

  /// Stops capturing; server mode returns the transcript, device mode delivers it through the callback.
  Future<String?> stopListening(VoiceMode mode) async {
    if (mode == VoiceMode.device) {
      await _speech.stop();
      return null;
    }
    final path = await _recorder.stop();
    if (path == null) return null;
    try {
      return await _api.speechToText(path);
    } on ApiException catch (error) {
      if (error.isUnavailable) _serverVoice = false;
      rethrow;
    } finally {
      unawaited(File(path).delete().then<void>((_) {}, onError: (Object _) {}));
    }
  }

  Future<void> cancelListening() async {
    if (await _recorder.isRecording()) await _recorder.cancel();
    if (_speech.isListening) await _speech.cancel();
  }

  Future<void> speak(String text, {required void Function() onDone}) async {
    final clean = speakable(text);
    if (clean.isEmpty) return onDone();
    await stopSpeaking();
    _onSpeechDone = onDone;
    if (await _serverAvailable()) {
      try {
        final audio = await _api.textToSpeech(clean);
        final directory = await getTemporaryDirectory();
        final file = File(p.join(directory.path, 'reply-${DateTime.now().microsecondsSinceEpoch}.mp3'));
        await file.writeAsBytes(audio, flush: true);
        await _player.setFilePath(file.path);
        unawaited(
          _player.play().whenComplete(() {
            _finishSpeaking();
            unawaited(file.delete().then<void>((_) {}, onError: (Object _) {}));
          }),
        );
        return;
      } on ApiException catch (error) {
        if (error.isUnavailable) _serverVoice = false;
      } on PlayerException {
        // Fall back to the on-device voice.
      }
    }
    await _native.invokeMethod<void>('speak', {'text': clean, 'language': looksGerman(clean) ? 'de-DE' : 'en-US'});
  }

  Future<void> stopSpeaking() async {
    _onSpeechDone = null;
    await _player.stop();
    await _native.invokeMethod<void>('stop');
  }

  void _finishSpeaking() {
    final done = _onSpeechDone;
    _onSpeechDone = null;
    done?.call();
  }

  Future<void> dispose() async {
    _native.setMethodCallHandler(null);
    _onSpeechDone = null;
    await cancelListening();
    await _recorder.dispose();
    await _player.dispose();
    await _native.invokeMethod<void>('stop');
  }
}
