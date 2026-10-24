import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../app/theme.dart';
import '../../app/widgets.dart';
import 'chat_controller.dart';

const _factorySuggestions = [
  "Where's the steel drum that came in yesterday?",
  'Take me to Quality lab 0.21 without stairs',
  'Close the office lift',
  'Free room for 6 people at 14:00?',
  'What changed this week?',
];

const _defaultSuggestions = [
  'Where do I get coffee?',
  'How do I get to the lecture hall without stairs?',
  'Free room for 6 people at 14:00?',
  'What changed this week?',
];

class AssistantPanel extends ConsumerStatefulWidget {
  const AssistantPanel({
    required this.siteId,
    required this.scrollController,
    required this.onShowOnTwin,
    required this.onClose,
    required this.bottomInset,
    super.key,
  });

  final String siteId;
  final ScrollController scrollController;
  final VoidCallback onShowOnTwin;
  final VoidCallback onClose;
  final double bottomInset;

  @override
  ConsumerState<AssistantPanel> createState() => _AssistantPanelState();
}

class _AssistantPanelState extends ConsumerState<AssistantPanel> {
  final _input = TextEditingController();
  late final ChatController _chat;

  @override
  void initState() {
    super.initState();
    _chat = ref.read(chatControllerProvider(widget.siteId).notifier);
    _input.addListener(() => setState(() {}));
    _scrollToEnd();
  }

  @override
  void dispose() {
    unawaited(_chat.cancelVoice());
    _input.dispose();
    super.dispose();
  }

  void _send([String? text]) {
    final message = text ?? _input.text;
    if (message.trim().isEmpty) return;
    HapticFeedback.lightImpact();
    _input.clear();
    unawaited(ref.read(chatControllerProvider(widget.siteId).notifier).send(message));
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final controller = widget.scrollController;
      if (!controller.hasClients) return;
      unawaited(
        controller.animateTo(
          controller.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(chatControllerProvider(widget.siteId));
    final controller = ref.read(chatControllerProvider(widget.siteId).notifier);
    final kind = ref.watch(sitesProvider).value?.where((site) => site.id == widget.siteId).firstOrNull?.kind;
    final suggestions = kind == 'factory' ? _factorySuggestions : _defaultSuggestions;
    ref.listen(chatControllerProvider(widget.siteId).select((state) => state.draft), (_, draft) {
      if (draft.isNotEmpty && draft != _input.text) _input.text = draft;
    });
    ref.listen(chatControllerProvider(widget.siteId).select((state) => state.messages), (previous, next) {
      if (previous?.length != next.length || (next.isNotEmpty && next.last.pending)) _scrollToEnd();
    });
    final status = chat.listening
        ? 'Listening…'
        : chat.transcribing
        ? 'Transcribing…'
        : chat.speaking
        ? 'Speaking…'
        : 'Voice or text · routes, deliveries, rooms';
    return Column(
      children: [
        PanelHeader(
          title: 'Ask the building',
          subtitle: status,
          onClose: widget.onClose,
          leading: Container(
            width: 34,
            height: 34,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(colors: [AppColors.accent, AppColors.accent2]),
            ),
            child: const Icon(CupertinoIcons.sparkles, size: 17, color: AppColors.background),
          ),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppIconButton(
                icon: chat.muted ? CupertinoIcons.speaker_slash : CupertinoIcons.speaker_2,
                tooltip: chat.muted ? 'Unmute spoken replies' : 'Mute spoken replies',
                onPressed: controller.toggleMuted,
              ),
              const SizedBox(width: 6),
              AppIconButton(icon: CupertinoIcons.cube, tooltip: 'Show the twin', onPressed: widget.onShowOnTwin),
              const SizedBox(width: 6),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            controller: widget.scrollController,
            padding: const EdgeInsets.fromLTRB(14, 4, 14, 12),
            children: [
              if (chat.messages.isEmpty)
                const Padding(
                  padding: EdgeInsets.fromLTRB(2, 4, 2, 12),
                  child: Text(
                    'Hi! Ask me where things are, how to get somewhere, or tell me what changed.',
                    style: TextStyle(color: AppColors.textMuted, fontSize: 15, height: 1.45),
                  ),
                ),
              for (final message in chat.messages) _MessageBubble(message: message),
            ],
          ),
        ),
        if (chat.voiceError != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
            child: InlineMessage(chat.voiceError!, color: AppColors.warn),
          ),
        SizedBox(
          height: 40,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            itemCount: suggestions.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, index) => ActionChip(
              label: Text(suggestions[index], style: const TextStyle(fontSize: 12, color: AppColors.text)),
              backgroundColor: const Color(0x0FFFFFFF),
              side: const BorderSide(color: AppColors.border),
              shape: const StadiumBorder(),
              onPressed: chat.busy ? null : () => _send(suggestions[index]),
            ),
          ),
        ),
        Padding(
          padding: EdgeInsets.fromLTRB(12, 10, 12, widget.bottomInset),
          child: Row(
            children: [
              _MicButton(
                listening: chat.listening,
                busy: chat.transcribing,
                onPressed: chat.busy ? null : controller.toggleListening,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _input,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _send(),
                  style: const TextStyle(fontSize: 14, color: AppColors.text),
                  decoration: const InputDecoration(hintText: 'Ask anything about this site…'),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.filled(
                onPressed: chat.busy || _input.text.trim().isEmpty ? null : _send,
                tooltip: 'Send',
                icon: chat.busy
                    ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(CupertinoIcons.arrow_up, size: 18),
                style: IconButton.styleFrom(
                  minimumSize: const Size(46, 46),
                  backgroundColor: AppColors.accent,
                  foregroundColor: AppColors.background,
                  disabledBackgroundColor: const Color(0x3338BDF8),
                  disabledForegroundColor: const Color(0x80E0F2FE),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MicButton extends StatelessWidget {
  const _MicButton({required this.listening, required this.busy, required this.onPressed});

  final bool listening;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: busy ? null : onPressed,
      tooltip: listening ? 'Stop listening' : 'Ask by voice',
      icon: busy
          ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
          : Icon(listening ? CupertinoIcons.stop_fill : CupertinoIcons.mic_fill, size: 19),
      style: IconButton.styleFrom(
        minimumSize: const Size(46, 46),
        backgroundColor: listening ? const Color(0x33F87171) : const Color(0x0FFFFFFF),
        foregroundColor: listening ? AppColors.danger : AppColors.text,
        side: BorderSide(color: listening ? const Color(0x66F87171) : AppColors.border),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    if (message.fromUser) {
      return Align(
        alignment: Alignment.centerRight,
        child: Container(
          margin: const EdgeInsets.only(bottom: 10, left: 48),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: const Color(0x3338BDF8),
            borderRadius: BorderRadius.circular(18).copyWith(bottomRight: const Radius.circular(6)),
            border: Border.all(color: const Color(0x4D38BDF8)),
          ),
          child: Text(message.text, style: const TextStyle(color: Color(0xFFF0F9FF), fontSize: 14, height: 1.4)),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 12, right: 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (message.chips.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  const Text('UNDERSTOOD', style: TextStyle(color: AppColors.textDim, fontSize: 9, letterSpacing: 1.1)),
                  for (final chip in message.chips) StatusBadge(chip, color: AppColors.accent2),
                ],
              ),
            ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: message.error ? const Color(0x1AF87171) : const Color(0x0DFFFFFF),
              borderRadius: BorderRadius.circular(18).copyWith(bottomLeft: const Radius.circular(6)),
              border: Border.all(color: message.error ? const Color(0x40F87171) : AppColors.border),
            ),
            child: message.pending && message.text.isEmpty
                ? const SizedBox(
                    width: 36,
                    height: 18,
                    child: Center(
                      child: SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2)),
                    ),
                  )
                : Text(
                    message.text,
                    style: TextStyle(
                      color: message.error ? AppColors.danger : AppColors.text,
                      fontSize: 14,
                      height: 1.45,
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
