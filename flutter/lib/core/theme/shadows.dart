import 'package:flutter/material.dart';

/// Liquid Glass の shadow 定義
class IroriShadows {
  IroriShadows._();

  /// shadow-lg shadow-black/[0.04] (Tailwind) 相当の柔らかい影
  static const List<BoxShadow> card = [
    BoxShadow(
      color: Color(0x0A000000), // 約 4% opacity
      blurRadius: 10,
      offset: Offset(0, 4),
    ),
  ];
}
