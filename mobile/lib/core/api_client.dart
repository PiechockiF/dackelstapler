import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:http_parser/http_parser.dart';
import 'package:path/path.dart' as p;

import 'config.dart';
import 'models.dart';
import 'sse.dart';

class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  bool get isUnavailable => statusCode == 501;

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient(this.config, {Dio? dio})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: config.apiBaseUrl,
              connectTimeout: const Duration(seconds: 8),
              receiveTimeout: const Duration(seconds: 45),
            ),
          );

  final AppConfig config;
  final Dio _dio;

  void close() => _dio.close(force: true);

  Future<Map<String, dynamic>> health() async => _object(await _send(() => _dio.get<Object?>('/api/health')));

  Future<List<Site>> sites() async =>
      _objects(await _send(() => _dio.get<Object?>('/api/sites'))).map(Site.fromJson).toList(growable: false);

  Future<Building> building(String siteId) async =>
      Building.fromJson(_object(await _send(() => _dio.get<Object?>('/api/sites/$siteId/building'))));

  Future<SiteState> state(String siteId) async =>
      SiteState.fromJson(_object(await _send(() => _dio.get<Object?>('/api/sites/$siteId/state'))));

  Future<List<SiteEvent>> events(String siteId, {int limit = 200}) async =>
      _objects(await _send(() => _dio.get<Object?>('/api/sites/$siteId/events', queryParameters: {'limit': limit})))
          .map(SiteEvent.fromJson)
          .toList(growable: false);

  Future<RouteModel> route(
    String siteId, {
    required String from,
    required String to,
    bool stepFree = false,
    double? minWidthM,
    List<String>? via,
  }) async => RouteModel.fromJson(
    _object(
      await _send(
        () => _dio.post<Object?>(
          '/api/sites/$siteId/route',
          data: {
            'from': from,
            'to': to,
            'step_free': stepFree,
            'min_width_m': ?minWidthM,
            if (via != null && via.isNotEmpty) 'via': via,
          },
        ),
      ),
    ),
  );

  Future<SiteState> setClosed(String siteId, String elementId, {required bool closed}) async => SiteState.fromJson(
    _object(
      await _send(
        () => _dio.post<Object?>('/api/sites/$siteId/closures', data: {'element_id': elementId, 'closed': closed}),
      ),
    ),
  );

  Future<List<BookableRoom>> bookableRooms(
    String siteId, {
    required DateTime start,
    required DateTime end,
    required int people,
    String? near,
  }) async => _objects(
    await _send(
      () => _dio.get<Object?>(
        '/api/sites/$siteId/rooms/bookable',
        queryParameters: {
          'start': start.toUtc().toIso8601String(),
          'end': end.toUtc().toIso8601String(),
          'people': people,
          'near': ?near,
        },
      ),
    ),
  ).map(BookableRoom.fromJson).toList(growable: false);

  Future<Booking> book(
    String siteId, {
    required String spaceId,
    required DateTime start,
    required DateTime end,
    required String who,
    required String title,
  }) async => Booking.fromJson(
    _object(
      await _send(
        () => _dio.post<Object?>(
          '/api/sites/$siteId/bookings',
          data: {
            'space_id': spaceId,
            'start': start.toUtc().toIso8601String(),
            'end': end.toUtc().toIso8601String(),
            'who': who,
            'title': title,
          },
        ),
      ),
    ),
  );

  Future<CaptureJob> captureDelivery({
    required String siteId,
    required List<String> photoPaths,
    Dimensions? declared,
    String? targetSpaceId,
    String? label,
    String? note,
    ProgressCallback? onSendProgress,
  }) async {
    final form = FormData()..fields.add(MapEntry('site_id', siteId));
    for (final path in photoPaths) {
      form.files.add(MapEntry('photos', await _file(path)));
    }
    if (declared != null) {
      form.fields.addAll([
        MapEntry('declared_w', declared.w.toString()),
        MapEntry('declared_d', declared.d.toString()),
        MapEntry('declared_h', declared.h.toString()),
      ]);
    }
    if (targetSpaceId != null) form.fields.add(MapEntry('target_space', targetSpaceId));
    if (label != null && label.isNotEmpty) form.fields.add(MapEntry('label', label));
    if (note != null && note.isNotEmpty) form.fields.add(MapEntry('note', note));
    return CaptureJob.fromJson(
      _object(
        await _send(
          () => _dio.post<Object?>(
            '/api/capture/delivery',
            data: form,
            onSendProgress: onSendProgress,
            options: Options(sendTimeout: const Duration(minutes: 3)),
          ),
        ),
      ),
    );
  }

  /// Without [videoPath] the server produces its labelled demo scan.
  Future<CaptureJob> captureRoom({
    required String siteId,
    required String spaceId,
    String? videoPath,
    ProgressCallback? onSendProgress,
  }) async {
    final form = FormData()..fields.addAll([MapEntry('site_id', siteId), MapEntry('space_id', spaceId)]);
    if (videoPath != null) form.files.add(MapEntry('video', await _file(videoPath)));
    return CaptureJob.fromJson(
      _object(
        await _send(
          () => _dio.post<Object?>(
            '/api/capture/room',
            data: form,
            onSendProgress: onSendProgress,
            options: Options(sendTimeout: const Duration(minutes: 10)),
          ),
        ),
      ),
    );
  }

  Future<CaptureJob> captureJob(String jobId) async =>
      CaptureJob.fromJson(_object(await _send(() => _dio.get<Object?>('/api/capture/jobs/$jobId'))));

  Future<Uint8List> samplePhoto() async {
    final data = await _send(
      () => _dio.get<List<int>>(
        '/api/capture/sample.jpg',
        queryParameters: {'seed': DateTime.now().millisecondsSinceEpoch % 1000},
        options: Options(responseType: ResponseType.bytes),
      ),
    );
    return Uint8List.fromList(data as List<int>);
  }

  /// Throws [ApiException] with status 501 when server speech is not configured.
  Future<String> speechToText(String audioPath) async {
    final form = FormData()..files.add(MapEntry('audio', await _file(audioPath)));
    final json = _object(await _send(() => _dio.post<Object?>('/api/voice/stt', data: form)));
    return json['text']?.toString().trim() ?? '';
  }

  /// Returns MPEG audio; throws [ApiException] with status 501 when not configured.
  Future<Uint8List> textToSpeech(String text) async {
    final data = await _send(
      () => _dio.post<List<int>>(
        '/api/voice/tts',
        data: {'text': text},
        options: Options(responseType: ResponseType.bytes),
      ),
    );
    return Uint8List.fromList(data as List<int>);
  }

  Stream<ChatStreamEvent> streamChat({
    required String siteId,
    required String sessionId,
    required String message,
    String? here,
    CancelToken? cancelToken,
  }) async* {
    final Response<ResponseBody> response;
    try {
      response = await _dio.post<ResponseBody>(
        '/api/sites/$siteId/chat',
        data: {'session_id': sessionId, 'message': message, 'here': ?here},
        cancelToken: cancelToken,
        options: Options(
          responseType: ResponseType.stream,
          receiveTimeout: const Duration(minutes: 3),
          headers: {'Accept': 'text/event-stream'},
          validateStatus: (_) => true,
        ),
      );
    } on DioException catch (error) {
      throw _exception(error);
    }
    final body = response.data;
    if (body == null) throw const ApiException('The assistant returned an empty response.');
    final status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      final bytes = await body.stream.fold<List<int>>(<int>[], (all, chunk) => all..addAll(chunk));
      throw ApiException(
        _detail(_tryDecode(utf8.decode(bytes, allowMalformed: true))) ?? 'The assistant failed ($status).',
        statusCode: status,
      );
    }
    final parser = SseParser();
    try {
      await for (final text in utf8.decoder.bind(body.stream)) {
        for (final event in parser.add(text)) {
          final parsed = parseChatEvent(event);
          if (parsed != null) yield parsed;
        }
      }
    } on DioException catch (error) {
      throw _exception(error);
    }
    for (final event in parser.close()) {
      final parsed = parseChatEvent(event);
      if (parsed != null) yield parsed;
    }
  }

  Future<Object?> _send(Future<Response<Object?>> Function() request) async {
    try {
      return (await request()).data;
    } on DioException catch (error) {
      throw _exception(error);
    }
  }

  ApiException _exception(DioException error) {
    final response = error.response;
    if (response != null) {
      final data = response.data;
      final decoded = data is List<int> ? _tryDecode(utf8.decode(data, allowMalformed: true)) : data;
      return ApiException(
        _detail(decoded) ?? 'Server error ${response.statusCode ?? ''}'.trim(),
        statusCode: response.statusCode,
      );
    }
    return switch (error.type) {
      DioExceptionType.connectionTimeout || DioExceptionType.connectionError => ApiException(
        'Cannot reach SiteTwin at ${config.apiBaseUrl}. Check that the server is running and this device is on the same network.',
      ),
      DioExceptionType.receiveTimeout ||
      DioExceptionType.sendTimeout => const ApiException('The server took too long to respond.'),
      DioExceptionType.cancel => const ApiException('Request cancelled.'),
      _ => ApiException(error.message ?? 'Network request failed.'),
    };
  }

  static Object? _tryDecode(String text) {
    try {
      return jsonDecode(text);
    } on FormatException {
      return text;
    }
  }

  static String? _detail(Object? data) {
    if (data is Map) {
      final detail = data['detail'];
      if (detail is String && detail.isNotEmpty) return detail;
      if (detail is List && detail.isNotEmpty) {
        return detail.map((item) => item is Map ? item['msg'] ?? item.toString() : item.toString()).join('; ');
      }
      return null;
    }
    if (data is String && data.trim().isNotEmpty && data.length <= 300) return data.trim();
    return null;
  }

  static Map<String, dynamic> _object(Object? data) {
    if (data is Map) return data.map((key, value) => MapEntry(key.toString(), value));
    throw const ApiException('Unexpected response from the server.');
  }

  static List<Map<String, dynamic>> _objects(Object? data) {
    if (data is! List) throw const ApiException('Unexpected response from the server.');
    return [
      for (final item in data)
        if (item is Map) item.map((key, value) => MapEntry(key.toString(), value)),
    ];
  }

  static Future<MultipartFile> _file(String path) =>
      MultipartFile.fromFile(path, filename: p.basename(path), contentType: _mediaType(path));

  static MediaType _mediaType(String path) => switch (p.extension(path).toLowerCase()) {
    '.jpg' || '.jpeg' => MediaType('image', 'jpeg'),
    '.png' => MediaType('image', 'png'),
    '.heic' => MediaType('image', 'heic'),
    '.mov' => MediaType('video', 'quicktime'),
    '.mp4' => MediaType('video', 'mp4'),
    '.m4a' => MediaType('audio', 'mp4'),
    _ => MediaType('application', 'octet-stream'),
  };
}
