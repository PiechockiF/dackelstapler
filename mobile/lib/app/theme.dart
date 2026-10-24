import 'package:flutter/material.dart';

abstract final class AppColors {
  static const background = Color(0xFF05070D);
  static const backgroundElevated = Color(0xFF070B14);
  static const panel = Color(0xE60B1220);
  static const panelSolid = Color(0xFF0B1220);
  static const surface = Color(0xFF101A2C);
  static const surfaceHover = Color(0xFF172238);
  static const border = Color(0x14FFFFFF);
  static const borderStrong = Color(0x26FFFFFF);
  static const text = Color(0xFFE2E8F0);
  static const textMuted = Color(0xFF94A3B8);
  static const textDim = Color(0xFF64748B);
  static const accent = Color(0xFF38BDF8);
  static const accentSoft = Color(0x3338BDF8);
  static const accent2 = Color(0xFFA78BFA);
  static const ok = Color(0xFF34D399);
  static const warn = Color(0xFFFBBF24);
  static const danger = Color(0xFFF87171);
  static const booked = Color(0xFF3B82F6);

  static const roomPalette = <String, Color>{
    'office': Color(0xFF6F8FE0),
    'meeting_room': Color(0xFFA68BE8),
    'seminar_room': Color(0xFFA68BE8),
    'lecture_hall': Color(0xFF9479E0),
    'library': Color(0xFF9A86D8),
    'lab': Color(0xFF3CB8CF),
    'quality_lab': Color(0xFF3CB8CF),
    'makerspace': Color(0xFF45C4B0),
    'production_zone': Color(0xFFD9A55A),
    'assembly_zone': Color(0xFFD4B062),
    'additive_zone': Color(0xFFE0975E),
    'warehouse_zone': Color(0xFFC4875A),
    'logistics_zone': Color(0xFFC99A63),
    'storage': Color(0xFFA98568),
    'corridor': Color(0xFF2C3550),
    'lobby': Color(0xFF38446A),
    'hall': Color(0xFF34405F),
    'toilet': Color(0xFF5FBFAE),
    'bathroom': Color(0xFF5FBFAE),
    'locker_room': Color(0xFF5AA99B),
    'kitchen': Color(0xFF86B860),
    'canteen': Color(0xFF86B860),
    'server_room': Color(0xFFD9677E),
    'technical_room': Color(0xFFC46C86),
    'print_room': Color(0xFFB77A9A),
    'stairwell': Color(0xFF8B95C9),
    'lift': Color(0xFF8B95C9),
    'generic_room': Color(0xFF5B6FA6),
  };
}

ThemeData buildAppTheme() {
  const colorScheme = ColorScheme.dark(
    primary: AppColors.accent,
    onPrimary: AppColors.background,
    secondary: AppColors.accent2,
    onSecondary: AppColors.background,
    surface: AppColors.panelSolid,
    onSurface: AppColors.text,
    error: AppColors.danger,
    onError: AppColors.background,
  );
  final textTheme = ThemeData.dark().textTheme.apply(
    fontFamily: 'Inter',
    bodyColor: AppColors.text,
    displayColor: Colors.white,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    fontFamily: 'Inter',
    colorScheme: colorScheme,
    scaffoldBackgroundColor: AppColors.background,
    canvasColor: AppColors.background,
    textTheme: textTheme.copyWith(
      headlineSmall: textTheme.headlineSmall?.copyWith(fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: -0.5),
      titleLarge: textTheme.titleLarge?.copyWith(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: -0.3),
      titleMedium: textTheme.titleMedium?.copyWith(fontSize: 15, fontWeight: FontWeight.w600, letterSpacing: -0.15),
      bodyLarge: textTheme.bodyLarge?.copyWith(fontSize: 15, height: 1.45),
      bodyMedium: textTheme.bodyMedium?.copyWith(fontSize: 13, height: 1.4),
      labelSmall: textTheme.labelSmall?.copyWith(fontSize: 10, letterSpacing: 0.35, color: AppColors.textMuted),
    ),
    splashFactory: InkSparkle.splashFactory,
    dividerColor: AppColors.border,
    iconTheme: const IconThemeData(color: AppColors.textMuted, size: 20),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      foregroundColor: AppColors.text,
      elevation: 0,
      centerTitle: false,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: const Color(0xB30F172A),
      hintStyle: const TextStyle(color: AppColors.textDim, fontSize: 13),
      labelStyle: const TextStyle(color: AppColors.textMuted, fontSize: 12),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.accent, width: 1.2),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.danger),
      ),
    ),
    sliderTheme: const SliderThemeData(
      activeTrackColor: AppColors.accent,
      inactiveTrackColor: AppColors.borderStrong,
      thumbColor: Color(0xFFE0F2FE),
      overlayColor: AppColors.accentSoft,
      trackHeight: 3,
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: AppColors.accent,
      linearTrackColor: AppColors.border,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColors.surfaceHover,
      contentTextStyle: textTheme.bodyMedium?.copyWith(color: AppColors.text),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: AppColors.borderStrong),
      ),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: Colors.transparent,
      modalBackgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
    ),
    visualDensity: VisualDensity.standard,
  );
}
