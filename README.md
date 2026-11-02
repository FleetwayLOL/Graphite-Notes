# Graphite

Портативный редактор текста и заметок для Windows 10 / 11 (нативный C++ Win32 + WebView2), а также автономная однофайловая версия для браузера (`Graphite.html`).

---

## Скачать готовую версию (Windows 10 / 11)

Перейдите в раздел **[Releases](../../releases)** справа и скачайте архив **`Graphite-Portable-Windows.zip`**.

Установка не требуется: распакуйте архив в любую папку или на накопитель и запустите `Graphite.exe`. Все заметки, вкладки, подключённые шрифты и настройки сохраняются рядом с программой в папке `PortableData`.

---

## Основные возможности

- **Полная портативность (Zero Install)**: один исполняемый файл `Graphite.exe` без внешних DLL и без `.bat`-скриптов.
- **Строгий настраиваемый интерфейс**: режим окна `Блюр` (нативное размытие Windows DWM / Acrylic) и `Обычный` плотный режим, светлая и тёмная темы, `Полный` и `Компактный` виды интерфейса.
- **Работа с текстом, кодом и файлами**:
  - вкладки, папки, закрепление заметок, корзина и поиск с заменой (`Ctrl+F`);
  - форматированный текст (Rich Text), чистый текст / код с нумерацией строк и предпросмотр Markdown;
  - автоопределение и сохранение кодировок (`UTF-8`, `UTF-8 BOM`, `UTF-16 LE/BE`, `Windows-1251`);
  - опциональная регистрация в качестве замены стандартного Блокнота Windows с откатом в один клик.
- **Кастомные шрифты**:
  - 15 встроенных шрифтовых пресетов;
  - загрузка собственных файлов шрифтов (`.ttf`, `.otf`, `.woff`, `.woff2`) с сохранением в портативной базе;
  - подключение любого установленного в ОС шрифта по названию.
- **Сменные иконки приложения**: 8 цветовых вариантов иконки окна и панели задач + создание ярлыка `Graphite.lnk` на Рабочем столе.
- **Фоны и темы**: встроенные атмосферные фоны, загрузка собственных изображений/GIF, поиск широкоформатных обоев из сети и опциональная галерея игровых тем.
- **15 языков интерфейса**: автоматическое определение строго по языку интерфейса Windows (без привязки к региону) или ручной выбор во вкладке `Языки`.

---

## Сборка из исходного кода

Сборка выполняется на Linux (Ubuntu / Debian / WSL) или через GitHub Actions с помощью Python 3 и кросс-компилятора MinGW-w64:

```bash
sudo apt-get update
sudo apt-get install -y python3 mingw-w64

python3 src/build.py
```

После сборки в корне репозитория создаются:
- `Graphite.html` — автономная однофайловая веб-версия;
- `Graphite-Windows-Portable/Graphite.exe` — нативный исполняемый файл для Windows x64;
- `Graphite-Portable-Windows.zip` — готовый портативный архив для релиза.

---

## English Summary

**Graphite** is a clean, zero-install notepad and text/note editor for Windows 10/11 (native C++ Win32 + WebView2) paired with an offline single-file HTML edition (`Graphite.html`).

- **Download**: Grab `Graphite-Portable-Windows.zip` from **[Releases](../../releases)**, extract anywhere, and run `Graphite.exe`.
- **Features**: Multi-tab notes & folders, Rich Text + Plain Text/Code + Markdown preview, multi-encoding support (`UTF-8`, `UTF-16`, `Windows-1251`), optional Windows Notepad file-association toggle, custom font uploader (`.ttf`/`.otf`/`.woff2`) + OS font selector, 8 switchable app icons, custom wallpapers, and 15 UI languages with automatic Windows Display Language detection (ignoring OS region).
- **Build from source**: Install `python3` and `mingw-w64`, then run `python3 src/build.py`.

---

## Примечание об авторских правах / Credits & Disclaimer

- Код проекта распространяется по лицензии [MIT](LICENSE) (`By FleetwayLOL and AI`).
- Изображения и иллюстрации в опциональном разделе «Темы от FleetwayLOL» не принадлежат `FleetwayLOL` — все права на персонажей, игры и фан-арты принадлежат их оригинальным авторам и правообладателям.
