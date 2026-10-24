import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api_client.dart';
import '../../core/sse.dart';
import '../site/site_session.dart';
import 'voice_service.dart';

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.fromUser,
    required this.text,
    this.chips = const [],
    this.pending = false,
    this.error = false,
  });

  final String id;
  final bool fromUser;
  final String text;
  final List<String> chips;
  final bool pending;
  final bool error;

  ChatMessage copyWith({String? text, List<String>? chips, bool? pending, bool? error}) => ChatMessage(
    id: id,
    fromUser: fromUser,
    text: text ?? this.text,
    chips: chips ?? this.chips,
    pending: pending ?? this.pending,
    error: error ?? this.error,
  );
}

class ChatState {
  const ChatState({
    this.messages = const [],
    this.busy = false,
    this.listening = false,
    this.transcribing = false,
    this.speaking = false,
    this.muted = false,
    this.draft = '',
    this.voiceError,
  });

  final List<ChatMessage> messages;
  final bool busy;
  final bool listening;
  final bool transcribing;
  final bool speaking;
  final bool muted;

  /// Live transcript while dictating.
  final String draft;
  final String? voiceError;

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? busy,
    bool? listening,
    bool? transcribing,
    bool? speaking,
    bool? muted,
    String? draft,
    Object? voiceError = _keepError,
  }) => ChatState(
    messages: messages ?? this.messages,
    busy: busy ?? this.busy,
    listening: listening ?? this.listening,
    transcribing: transcribing ?? this.transcribing,
    speaking: speaking ?? this.speaking,
    muted: muted ?? this.muted,
    draft: draft ?? this.draft,
    voiceError: identical(voiceError, _keepError) ? this.voiceError : voiceError as String?,
  );
}

const _keepError = Object();

/// Kept alive for the app session so a site's conversation survives closing the panel or leaving the site.
final chatControllerProvider = NotifierProvider.family<ChatController, ChatState, String>(ChatController.new);

class ChatController extends Notifier<ChatState> {
  ChatController(this.siteId);

  final String siteId;
  late final String _sessionId = '$siteId-ios-${DateTime.now().microsecondsSinceEpoch}';
  VoiceService? _voiceService;
  CancelToken? _cancel;
  VoiceMode? _mode;
  int _counter = 0;

  VoiceService get _voice => _voiceService ??= VoiceService(ref.read(apiClientProvider));

  @override
  ChatState build() {
    ref.onDispose(() {
      _cancel?.cancel();
      final voice = _voiceService;
      _voiceService = null;
      if (voice != null) unawaited(voice.dispose());
    });
    return const ChatState();
  }

  String _id() => '${DateTime.now().microsecondsSinceEpoch}-${_counter++}';

  void _updateMessage(String id, ChatMessage Function(ChatMessage message) update) {
    state = state.copyWith(
      messages: [for (final message in state.messages) message.id == id ? update(message) : message],
    );
  }

  Future<void> send(String raw) async {
    final text = raw.trim();
    if (text.isEmpty || state.busy) return;
    final voice = _voiceService;
    if (voice != null) unawaited(voice.stopSpeaking());
    final reply = ChatMessage(id: _id(), fromUser: false, text: '', pending: true);
    state = state.copyWith(
      busy: true,
      draft: '',
      speaking: false,
      messages: [
        ...state.messages,
        ChatMessage(id: _id(), fromUser: true, text: text),
        reply,
      ],
    );
    final session = ref.read(siteSessionProvider(siteId).notifier);
    final buffer = StringBuffer();
    String? finalText;
    _cancel = CancelToken();
    try {
      final stream = ref
          .read(apiClientProvider)
          .streamChat(
            siteId: siteId,
            sessionId: _sessionId,
            message: text,
            here: ref.read(siteSessionProvider(siteId)).originId,
            cancelToken: _cancel,
          );
      await for (final event in stream) {
        if (!ref.mounted) return;
        switch (event) {
          case ChatDelta(text: final delta):
            buffer.write(delta);
            _updateMessage(reply.id, (message) => message.copyWith(text: buffer.toString()));
          case ChatActionEvent(:final action):
            if (action.type == 'understood') {
              _updateMessage(
                reply.id,
                (message) => message.copyWith(chips: {...message.chips, ...action.chips}.toList()),
              );
            } else {
              session.applyChatAction(action);
            }
          case ChatDone(reply: final full):
            finalText = full.isNotEmpty ? full : buffer.toString();
        }
      }
      if (!ref.mounted) return;
      final answer = finalText ?? buffer.toString();
      _updateMessage(reply.id, (message) => message.copyWith(text: answer.isEmpty ? 'Done.' : answer, pending: false));
      if (!state.muted && answer.isNotEmpty) {
        state = state.copyWith(speaking: true);
        unawaited(
          _voice.speak(
            answer,
            onDone: () {
              if (ref.mounted) state = state.copyWith(speaking: false);
            },
          ),
        );
      }
    } on ApiException catch (error) {
      if (!ref.mounted) return;
      _updateMessage(
        reply.id,
        (message) =>
            message.copyWith(text: "I couldn't reach the server (${error.message}).", pending: false, error: true),
      );
    } on FormatException catch (error) {
      if (!ref.mounted) return;
      _updateMessage(reply.id, (message) => message.copyWith(text: error.message, pending: false, error: true));
    } finally {
      if (ref.mounted) state = state.copyWith(busy: false);
    }
  }

  /// Stops dictation and speech without sending anything, e.g. when the panel closes.
  Future<void> cancelVoice() async {
    _mode = null;
    final voice = _voiceService;
    if (voice == null) return;
    state = state.copyWith(listening: false, transcribing: false, speaking: false);
    await voice.cancelListening();
    await voice.stopSpeaking();
  }

  void toggleMuted() {
    final muted = !state.muted;
    state = state.copyWith(muted: muted, speaking: muted ? false : state.speaking);
    final voice = _voiceService;
    if (muted && voice != null) unawaited(voice.stopSpeaking());
  }

  Future<void> toggleListening() async {
    if (state.listening) return stopListening();
    if (state.busy || state.transcribing) return;
    await _voice.stopSpeaking();
    state = state.copyWith(voiceError: null, speaking: false);
    try {
      _mode = await _voice.startListening(
        onTranscript: (text, isFinal) {
          if (!ref.mounted) return;
          state = state.copyWith(draft: text);
          if (!isFinal) return;
          _mode = null;
          state = state.copyWith(listening: false);
          if (text.trim().isNotEmpty) unawaited(send(text));
        },
      );
      if (ref.mounted) state = state.copyWith(listening: true);
    } on VoiceUnavailable catch (error) {
      if (ref.mounted) state = state.copyWith(voiceError: error.message);
    } catch (error) {
      if (ref.mounted) state = state.copyWith(voiceError: 'Could not start listening ($error).');
    }
  }

  Future<void> stopListening() async {
    final mode = _mode;
    _mode = null;
    state = state.copyWith(listening: false);
    if (mode == null) return;
    if (mode == VoiceMode.device) {
      await _voice.stopListening(mode);
      return;
    }
    state = state.copyWith(transcribing: true);
    try {
      final text = await _voice.stopListening(mode);
      if (ref.mounted && text != null && text.isNotEmpty) await send(text);
    } on ApiException catch (error) {
      if (ref.mounted) {
        state = state.copyWith(
          voiceError: error.isUnavailable
              ? 'Server speech is not configured; on-device recognition will be used next time.'
              : error.message,
        );
      }
    } finally {
      if (ref.mounted) state = state.copyWith(transcribing: false);
    }
  }
}
