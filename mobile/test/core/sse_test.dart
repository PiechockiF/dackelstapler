import 'package:flutter_test/flutter_test.dart';
import 'package:sitetwin/core/sse.dart';

const _stream =
    'event: action\n'
    'data: {"type": "set_location", "space_id": "s-office"}\n'
    '\n'
    ': keep-alive comment\n'
    'event: delta\r\n'
    'data: {"text": "Take the lift"}\r\n'
    '\r\n'
    'event: action\n'
    'data: {"type": "understood", "chips": ["to: Quality lab 0.21", "step-free"]}\n'
    '\n'
    'event: done\n'
    'data: {"reply": "Take the lift to L0."}\n'
    '\n';

List<ChatStreamEvent> _parseInChunks(String input, int chunkSize) {
  final parser = SseParser();
  final events = <SseEvent>[];
  for (var start = 0; start < input.length; start += chunkSize) {
    final end = start + chunkSize > input.length ? input.length : start + chunkSize;
    events.addAll(parser.add(input.substring(start, end)));
  }
  events.addAll(parser.close());
  return events.map(parseChatEvent).whereType<ChatStreamEvent>().toList();
}

void main() {
  test('parses the chat stream identically for every chunk size', () {
    for (var size = 1; size <= _stream.length; size++) {
      final events = _parseInChunks(_stream, size);
      expect(events, hasLength(4), reason: 'chunk size $size');
      expect((events[0] as ChatActionEvent).action.spaceId, 's-office');
      expect((events[1] as ChatDelta).text, 'Take the lift');
      expect((events[2] as ChatActionEvent).action.chips, ['to: Quality lab 0.21', 'step-free']);
      expect((events[3] as ChatDone).reply, 'Take the lift to L0.');
    }
  });

  test('joins multi-line data and flushes an unterminated final event', () {
    final parser = SseParser();
    expect(parser.add('event: note\ndata: first\ndata: second'), isEmpty);
    final events = parser.close();
    expect(events.single.event, 'note');
    expect(events.single.data, 'first\nsecond');
  });

  test('ignores event types the app does not use', () {
    expect(parseChatEvent(const SseEvent('ping', '{}')), isNull);
  });

  test('reports malformed JSON with a readable message', () {
    expect(
      () => parseChatEvent(const SseEvent('delta', '{"text": ')),
      throwsA(isA<FormatException>().having((error) => error.message, 'message', contains('Malformed "delta"'))),
    );
    expect(() => parseChatEvent(const SseEvent('done', '[1, 2]')), throwsFormatException);
  });
}
