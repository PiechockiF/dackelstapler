import 'dart:convert';

import 'models.dart';

class SseEvent {
  const SseEvent(this.event, this.data);

  final String event;
  final String data;
}

/// Incremental `text/event-stream` parser; feed decoded text in arbitrary chunks.
class SseParser {
  String _buffer = '';
  String _event = '';
  final List<String> _data = [];

  List<SseEvent> add(String chunk) {
    _buffer += chunk;
    final events = <SseEvent>[];
    var newline = _buffer.indexOf('\n');
    while (newline >= 0) {
      _processLine(_stripCarriageReturn(_buffer.substring(0, newline)), events);
      _buffer = _buffer.substring(newline + 1);
      newline = _buffer.indexOf('\n');
    }
    return events;
  }

  /// Flushes a trailing event that was not terminated by a blank line.
  List<SseEvent> close() {
    final events = <SseEvent>[];
    if (_buffer.isNotEmpty) {
      _processLine(_stripCarriageReturn(_buffer), events);
      _buffer = '';
    }
    _dispatch(events);
    return events;
  }

  static String _stripCarriageReturn(String line) => line.endsWith('\r') ? line.substring(0, line.length - 1) : line;

  void _processLine(String line, List<SseEvent> out) {
    if (line.isEmpty) {
      _dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;
    final colon = line.indexOf(':');
    final field = colon < 0 ? line : line.substring(0, colon);
    var value = colon < 0 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);
    switch (field) {
      case 'event':
        _event = value;
      case 'data':
        _data.add(value);
    }
  }

  void _dispatch(List<SseEvent> out) {
    if (_data.isNotEmpty) {
      out.add(SseEvent(_event.isEmpty ? 'message' : _event, _data.join('\n')));
    }
    _event = '';
    _data.clear();
  }
}

sealed class ChatStreamEvent {
  const ChatStreamEvent();
}

class ChatDelta extends ChatStreamEvent {
  const ChatDelta(this.text);

  final String text;
}

class ChatActionEvent extends ChatStreamEvent {
  const ChatActionEvent(this.action);

  final ChatAction action;
}

class ChatDone extends ChatStreamEvent {
  const ChatDone(this.reply);

  final String reply;
}

/// Maps one chat SSE event; returns null for event types this client does not use.
/// Throws [FormatException] when a known event carries malformed JSON.
ChatStreamEvent? parseChatEvent(SseEvent event) {
  if (event.event != 'delta' && event.event != 'action' && event.event != 'done') {
    return null;
  }
  final Object? decoded;
  try {
    decoded = jsonDecode(event.data);
  } on FormatException catch (error) {
    throw FormatException('Malformed "${event.event}" event from assistant: ${error.message}');
  }
  if (decoded is! Map) {
    throw FormatException('Assistant "${event.event}" event is not a JSON object.');
  }
  final json = decoded.map((key, value) => MapEntry(key.toString(), value));
  return switch (event.event) {
    'delta' => ChatDelta(json['text']?.toString() ?? ''),
    'action' => ChatActionEvent(ChatAction.fromJson(json)),
    _ => ChatDone(json['reply']?.toString() ?? ''),
  };
}
