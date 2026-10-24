/// Backend location, supplied at build time:
/// `--dart-define=SITETWIN_API_URL=http://my-mac.local:8000`.
class AppConfig {
  AppConfig({String? apiBaseUrl})
    : apiBaseUri = _parseBaseUri(
        apiBaseUrl ?? const String.fromEnvironment('SITETWIN_API_URL', defaultValue: 'http://127.0.0.1:8000'),
      );

  final Uri apiBaseUri;

  String get apiBaseUrl => apiBaseUri.toString();

  Uri get webSocketUri =>
      apiBaseUri.replace(scheme: apiBaseUri.scheme == 'https' ? 'wss' : 'ws', path: '${apiBaseUri.path}/ws');

  /// Resolves backend-relative paths such as `/storage/...`; absolute URLs pass through.
  Uri resolve(String pathOrUrl) {
    final parsed = Uri.parse(pathOrUrl);
    if (parsed.hasScheme) return parsed;
    final path = pathOrUrl.startsWith('/') ? pathOrUrl : '/$pathOrUrl';
    return Uri.parse('$apiBaseUrl$path');
  }

  static Uri _parseBaseUri(String value) {
    final trimmed = value.trim().replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(trimmed);
    if (uri == null || !(uri.scheme == 'http' || uri.scheme == 'https') || uri.host.isEmpty) {
      throw ArgumentError.value(
        value,
        'SITETWIN_API_URL',
        'must be an absolute http(s) URL such as http://my-mac.local:8000',
      );
    }
    return uri;
  }
}
