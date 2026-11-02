#!/usr/bin/env python3
"""
Builds Graphite (Portable Edition):
1. Standalone single-file Graphite.html
2. Native Windows 10/11 Portable executable Graphite-Windows-Portable/Graphite.exe
3. Distributable ZIP archive Graphite-Portable-Windows.zip
"""

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "src" / "ui"
WIN_DIR = ROOT / "src" / "native-win32"
DIST_DIR = ROOT / "Graphite-Windows-Portable"
HTML_OUT = ROOT / "Graphite.html"
ZIP_OUT = ROOT / "Graphite-Portable-Windows.zip"


def build_standalone_html() -> bytes:
    css = (UI_DIR / "styles.css").read_text(encoding="utf-8")
    i18n = (UI_DIR / "i18n.js").read_text(encoding="utf-8")
    flowery_wp = (UI_DIR / "flowery_wallpaper.js").read_text(encoding="utf-8")
    dr_wp = (UI_DIR / "deltarune_wallpapers.js").read_text(encoding="utf-8")
    app = (UI_DIR / "app.js").read_text(encoding="utf-8")
    tpl = (UI_DIR / "template.html").read_text(encoding="utf-8")

    # Use literal str.replace so any $ or \ sequences are preserved verbatim
    html = (
        tpl.replace("/*__INLINE_CSS__*/", css)
        .replace("/*__INLINE_I18N__*/", i18n)
        .replace("/*__INLINE_FLOWERY_WP__*/", flowery_wp)
        .replace("/*__INLINE_DR_WP__*/", dr_wp)
        .replace("/*__INLINE_APP__*/", app)
    )
    HTML_OUT.write_text(html, encoding="utf-8")
    print(f"[OK] Built {HTML_OUT} ({HTML_OUT.stat().st_size:,} bytes)")
    return html.encode("utf-8")


def write_embedded_header(html_bytes: bytes):
    header_lines = [
        "#pragma once",
        "#include <cstddef>",
        f"static const size_t EMBEDDED_APP_HTML_LEN = {len(html_bytes)}ULL;",
        'extern "C" const unsigned char EMBEDDED_APP_HTML[];',
    ]
    header_path = WIN_DIR / "embedded_app.h"
    header_path.write_text("\n".join(header_lines) + "\n", encoding="utf-8")

    asm_lines = [
        '\t.section .rdata,"dr"',
        "\t.globl EMBEDDED_APP_HTML",
        "\t.align 8",
        "EMBEDDED_APP_HTML:",
        f'\t.incbin "{HTML_OUT.as_posix()}"',
        "\t.byte 0",
    ]
    asm_path = WIN_DIR / "embedded_app.S"
    asm_path.write_text("\n".join(asm_lines) + "\n", encoding="utf-8")
    print(f"[OK] Generated {header_path} + {asm_path} ({len(html_bytes):,} embedded bytes)")


def build_windows_exe():
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Generate multi-res .ico
    subprocess.run([sys.executable, str(WIN_DIR / "generate_icon.py")], check=True)

    # 2. Compile .rc -> app_res.o
    res_obj = WIN_DIR / "app_res.o"
    subprocess.run(
        ["x86_64-w64-mingw32-windres", "app.rc", "-O", "coff", "-o", str(res_obj)],
        cwd=str(WIN_DIR),
        check=True,
    )

    # 3. Compile native portable .exe (zero external runtime DLLs)
    exe_out = DIST_DIR / "Graphite.exe"
    cmd = [
        "x86_64-w64-mingw32-g++-posix",
        "-std=c++17",
        "-O2",
        "-mwindows",
        "-static",
        "-static-libgcc",
        "-static-libstdc++",
        f"-I{WIN_DIR}",
        f"-I{WIN_DIR / 'include'}",
        str(WIN_DIR / "main.cpp"),
        str(WIN_DIR / "embedded_app.S"),
        str(res_obj),
        "-o",
        str(exe_out),
        "-lws2_32",
        "-lwininet",
        "-lcomdlg32",
        "-ldwmapi",
        "-lgdi32",
        "-lole32",
        "-loleaut32",
        "-lshell32",
        "-lshlwapi",
        "-luser32",
        "-ladvapi32",
        "-lversion",
        "-luuid",
    ]
    subprocess.run(cmd, check=True)
    subprocess.run(["x86_64-w64-mingw32-strip", "--strip-unneeded", str(exe_out)], check=True)
    print(f"[OK] Compiled {exe_out} ({exe_out.stat().st_size:,} bytes)")


def write_readme_and_zip():
    shutil.copy2(HTML_OUT, DIST_DIR / "Graphite.html")

    readme = """========================================================================
Graphite — Портативный редактор заметок и текста для Windows 10 / 11
15 языков интерфейса (автоопределение по языку интерфейса ОС)
========================================================================

[РУССКИЙ]
Портативная версия не требует установки и не оставляет мусора в системе.

Как запускать:
1. На Windows 10 / 11:
   Запустите файл «Graphite.exe» из любой папки или с USB-флешки.
   Рядом с программой автоматически создастся папка «PortableData», в которой
   хранятся все ваши заметки, папки, вкладки, кастомные шрифты и настройки
   (файл PortableData\\notes_storage.json).

2. Замена стандартного Блокнота Windows (по желанию):
   - Откройте «Параметры» внутри Graphite -> раздел «Замена Блокнота Windows»
     и нажмите «Сделать по умолчанию».
   - Кнопка «Вернуть Блокнот Windows» в любой момент возвращает стандартный
     Блокнот обратно по умолчанию.

Поддерживаемые типы файлов и кодировки:
   .txt .md .json .ini .cfg .conf .log .ps1 .bat .cmd .reg .xml .yaml .toml
   .csv .sql .py .js .ts .c .cpp .h .cs .go .rs .java .php .html .css и др.
   Автоопределение кодировок UTF-8, UTF-8 BOM, UTF-16LE/BE, Windows-1251
   и прямое сохранение на диск по Ctrl+S.

3. Автономная веб-версия (любая ОС):
   Откройте файл «Graphite.html» в любом браузере (работает полностью офлайн).

------------------------------------------------------------------------

[ENGLISH]
100% Portable — No installation required.

How to use:
1. Windows 10 / 11 Native App:
   Run "Graphite.exe" from any folder or USB drive.
   All notes, tabs, folders, custom fonts, and settings are saved automatically
   right next to the executable inside "PortableData\\notes_storage.json".

2. Optional Default Windows Notepad Replacement:
   Open Settings inside Graphite -> "Default Windows Notepad" -> "Set as Default".
   Click "Restore Windows Notepad" anytime to revert.

3. Standalone Offline Web Edition:
   Open "Graphite.html" in any desktop or mobile browser offline.
"""
    (DIST_DIR / "README-RU-EN.txt").write_text(readme.replace("\n", "\r\n"), encoding="utf-8")

    with zipfile.ZipFile(ZIP_OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for item in sorted(DIST_DIR.iterdir()):
            if item.is_file():
                zf.write(item, arcname=f"Graphite-Portable/{item.name}")

    print(f"[OK] Packaged {ZIP_OUT} ({ZIP_OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    html_bytes = build_standalone_html()
    write_embedded_header(html_bytes)
    build_windows_exe()
    write_readme_and_zip()
