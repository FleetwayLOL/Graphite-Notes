/* ==========================================================================
   Graphite — Native Windows 10/11 Frameless + Real Screen Blur Host
   - Custom frameless titlebar (WM_NCCALCSIZE) with Win11 rounded corners & snap
   - Real OS Screen Blur (DWM Desktop Acrylic + SetWindowCompositionAttribute)
   - Full Windows Notepad Replacement:
     * CLI file & --ifeo (Image File Execution Options) argument opening
     * MS-NOTEPAD URL protocol handling
     * Single-instance WM_COPYDATA tab forwarding
     * Auto-detection & preservation of UTF-8, UTF-8 BOM, UTF-16LE/BE & ANSI
     * Direct Ctrl+S disk saving + native Win32 Open / Save As dialogs
   - Strictly uses User's Default Browser (never forces Microsoft Edge)
   - Portable storage in <exe_dir>\PortableData\notes_storage.json
   ========================================================================== */

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wininet.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <propsys.h>
#include <propkey.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>

#define WEBVIEW_STATIC
#include "webview/webview.h"
#include "embedded_app.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

std::mutex g_storageMutex;
std::wstring g_exeFullPath;
std::wstring g_exeDirPath;
std::wstring g_storageFilePath;

std::mutex g_filesMutex;
std::vector<std::string> g_pendingFileJsonItems;
std::function<void()> g_notifyFrontendFiles;
HWND g_mainAppHwnd = nullptr;

static constexpr ULONG_PTR kIpcOpenFileTag = 0x474E4F50ULL; /* 'GNOP' */
static constexpr ULONG_PTR kIpcFocusTag = 0x474E4643ULL;    /* 'GNFC' */
static const wchar_t *kIpcClassName = L"GraphitePortableIPCClass";
static const wchar_t *kIpcWindowTitle = L"GraphitePortableIPC_v1";

/* Undocumented Win10/11 SetWindowCompositionAttribute fallback structures */
struct ACCENT_POLICY {
  int AccentState;
  int AccentFlags;
  DWORD GradientColor;
  int AnimationId;
};

struct WINDOWCOMPOSITIONATTRIBDATA {
  int Attrib;
  PVOID pvData;
  SIZE_T cbData;
};

using SetWindowCompositionAttributeFn = BOOL(WINAPI *)(HWND, WINDOWCOMPOSITIONATTRIBDATA *);

std::wstring utf8ToWide(const std::string &s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (len <= 0) return L"";
  std::wstring out(static_cast<size_t>(len), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &out[0], len);
  return out;
}

std::string wideToUtf8(const std::wstring &w) {
  if (w.empty()) return "";
  int len = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (len <= 0) return "";
  std::string out(static_cast<size_t>(len), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), &out[0], len, nullptr, nullptr);
  return out;
}

std::wstring toLowerWide(std::wstring s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
  return s;
}

/* Detect the active Windows UI Display Language (e.g. "ru", "en", "de", "kk"),
   strictly ignoring Windows Country/Region (GeoID) and Regional Format (GetUserDefaultLCID). */
std::string extractPrimaryIsoLang(const std::wstring &tag) {
  std::string out;
  for (wchar_t wc : tag) {
    if (wc == L'-' || wc == L'_' || wc == L'\0') break;
    if (wc >= L'A' && wc <= L'Z') {
      out.push_back(static_cast<char>(wc - L'A' + 'a'));
    } else if (wc >= L'a' && wc <= L'z') {
      out.push_back(static_cast<char>(wc));
    } else {
      break;
    }
  }
  return out;
}

std::string detectWindowsDisplayLanguage() {
  ULONG numLangs = 0;
  ULONG cchBuf = 0;
  if (GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &numLangs, nullptr, &cchBuf) && cchBuf > 0) {
    std::vector<wchar_t> buf(cchBuf + 2, L'\0');
    if (GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &numLangs, buf.data(), &cchBuf) && numLangs > 0) {
      std::string primary = extractPrimaryIsoLang(std::wstring(buf.data()));
      if (!primary.empty()) return primary;
    }
  }
  LANGID uiLangId = GetUserDefaultUILanguage();
  wchar_t localeBuf[LOCALE_NAME_MAX_LENGTH] = {};
  if (LCIDToLocaleName(MAKELCID(uiLangId, SORT_DEFAULT), localeBuf, LOCALE_NAME_MAX_LENGTH, 0) > 0) {
    std::string primary = extractPrimaryIsoLang(std::wstring(localeBuf));
    if (!primary.empty()) return primary;
  }
  return "en";
}

std::string jsonEscape(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 32);
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char hex[8];
          std::snprintf(hex, sizeof(hex), "\\u%04x", static_cast<unsigned int>(c));
          out += hex;
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }
  out.push_back('"');
  return out;
}

std::string urlDecodeUtf8(const std::string &in) {
  std::string out;
  out.reserve(in.size());
  for (size_t i = 0; i < in.size(); ++i) {
    if (in[i] == '%' && i + 2 < in.size()) {
      auto hexVal = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
      };
      int hi = hexVal(in[i + 1]);
      int lo = hexVal(in[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    } else if (in[i] == '+') {
      out.push_back(' ');
      continue;
    }
    out.push_back(in[i]);
  }
  return out;
}

std::string urlEncodeUtf8(const std::string &in) {
  static const char *kHex = "0123456789ABCDEF";
  std::string out;
  out.reserve(in.size() * 3);
  for (unsigned char c : in) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<char>(c));
    } else if (c == ' ') {
      out.push_back('+');
    } else {
      out.push_back('%');
      out.push_back(kHex[(c >> 4) & 0x0F]);
      out.push_back(kHex[c & 0x0F]);
    }
  }
  return out;
}

std::string extractRequestPathAndQuery(const std::string &headers) {
  size_t lineEnd = headers.find("\r\n");
  std::string firstLine = (lineEnd == std::string::npos) ? headers : headers.substr(0, lineEnd);
  size_t sp1 = firstLine.find(' ');
  if (sp1 == std::string::npos) return "/";
  size_t sp2 = firstLine.find(' ', sp1 + 1);
  if (sp2 == std::string::npos) return firstLine.substr(sp1 + 1);
  return firstLine.substr(sp1 + 1, sp2 - sp1 - 1);
}

std::string extractQueryParam(const std::string &fullPath, const std::string &key) {
  size_t qPos = fullPath.find('?');
  if (qPos == std::string::npos) return "";
  std::string qs = fullPath.substr(qPos + 1);
  std::string prefix = key + "=";
  size_t pos = 0;
  while (pos < qs.size()) {
    size_t amp = qs.find('&', pos);
    std::string part = (amp == std::string::npos) ? qs.substr(pos) : qs.substr(pos, amp - pos);
    if (part.rfind(prefix, 0) == 0) {
      return urlDecodeUtf8(part.substr(prefix.size()));
    }
    if (amp == std::string::npos) break;
    pos = amp + 1;
  }
  return "";
}

bool fetchUrlWinInet(const std::string &urlUtf8, std::string &outBody,
                     std::string &outContentType, size_t maxBytes = 16 * 1024 * 1024) {
  outBody.clear();
  outContentType = "application/octet-stream";
  if (urlUtf8.rfind("http://", 0) != 0 && urlUtf8.rfind("https://", 0) != 0) {
    return false;
  }
  std::wstring wUrl = utf8ToWide(urlUtf8);
  if (wUrl.empty()) return false;

  HINTERNET hInet = InternetOpenW(
      L"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      INTERNET_OPEN_TYPE_PRECONFIG, nullptr, nullptr, 0);
  if (!hInet) return false;

  DWORD timeoutMs = 15000;
  InternetSetOptionW(hInet, INTERNET_OPTION_CONNECT_TIMEOUT, &timeoutMs, sizeof(timeoutMs));
  InternetSetOptionW(hInet, INTERNET_OPTION_RECEIVE_TIMEOUT, &timeoutMs, sizeof(timeoutMs));
  InternetSetOptionW(hInet, INTERNET_OPTION_SEND_TIMEOUT, &timeoutMs, sizeof(timeoutMs));

  DWORD flags = INTERNET_FLAG_RELOAD | INTERNET_FLAG_NO_CACHE_WRITE |
                INTERNET_FLAG_NO_UI | INTERNET_FLAG_KEEP_CONNECTION;
  if (urlUtf8.rfind("https://", 0) == 0) {
    flags |= INTERNET_FLAG_SECURE;
  }

  const wchar_t *hdrs = L"Accept: image/webp,image/apng,image/*,application/json,*/*;q=0.8\r\n";
  HINTERNET hUrl = InternetOpenUrlW(hInet, wUrl.c_str(), hdrs, static_cast<DWORD>(-1L), flags, 0);
  if (!hUrl) {
    InternetCloseHandle(hInet);
    return false;
  }

  DWORD statusCode = 0;
  DWORD scLen = sizeof(statusCode);
  if (HttpQueryInfoW(hUrl, HTTP_QUERY_STATUS_CODE | HTTP_QUERY_FLAG_NUMBER, &statusCode, &scLen, nullptr)) {
    if (statusCode >= 400) {
      InternetCloseHandle(hUrl);
      InternetCloseHandle(hInet);
      return false;
    }
  }

  char ctBuf[256] = {0};
  DWORD ctLen = sizeof(ctBuf) - 1;
  if (HttpQueryInfoA(hUrl, HTTP_QUERY_CONTENT_TYPE, ctBuf, &ctLen, nullptr) && ctBuf[0] != '\0') {
    outContentType = ctBuf;
  }

  char chunk[16384];
  DWORD bytesRead = 0;
  while (InternetReadFile(hUrl, chunk, sizeof(chunk), &bytesRead) && bytesRead > 0) {
    if (outBody.size() + bytesRead > maxBytes) {
      InternetCloseHandle(hUrl);
      InternetCloseHandle(hInet);
      return false;
    }
    outBody.append(chunk, bytesRead);
    bytesRead = 0;
  }

  InternetCloseHandle(hUrl);
  InternetCloseHandle(hInet);
  return !outBody.empty();
}

void initPortablePaths() {
  wchar_t exePath[MAX_PATH] = {0};
  GetModuleFileNameW(nullptr, exePath, MAX_PATH);
  g_exeFullPath = exePath;
  PathRemoveFileSpecW(exePath);
  g_exeDirPath = exePath;

  wchar_t dataDir[MAX_PATH] = {0};
  PathCombineW(dataDir, exePath, L"PortableData");
  if (!CreateDirectoryW(dataDir, nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
    wchar_t tempDir[MAX_PATH] = {0};
    GetTempPathW(MAX_PATH, tempDir);
    PathCombineW(dataDir, tempDir, L"Graphite_PortableData");
    CreateDirectoryW(dataDir, nullptr);
  }

  wchar_t dbFile[MAX_PATH] = {0};
  PathCombineW(dbFile, dataDir, L"notes_storage.json");
  g_storageFilePath = dbFile;
}

std::string loadPortableJson() {
  std::lock_guard<std::mutex> lock(g_storageMutex);
  if (g_storageFilePath.empty()) return "";

  HANDLE hFile = CreateFileW(
      g_storageFilePath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hFile == INVALID_HANDLE_VALUE) return "";

  LARGE_INTEGER sz{};
  if (!GetFileSizeEx(hFile, &sz) || sz.QuadPart <= 0 || sz.QuadPart > 64 * 1024 * 1024) {
    CloseHandle(hFile);
    return "";
  }

  std::string buffer(static_cast<size_t>(sz.QuadPart), '\0');
  DWORD bytesRead = 0;
  BOOL ok = ReadFile(hFile, &buffer[0], static_cast<DWORD>(buffer.size()), &bytesRead, nullptr);
  CloseHandle(hFile);
  if (!ok || bytesRead == 0) return "";
  buffer.resize(bytesRead);
  return buffer;
}

bool savePortableJson(const std::string &jsonUtf8) {
  std::lock_guard<std::mutex> lock(g_storageMutex);
  if (g_storageFilePath.empty() || jsonUtf8.empty()) return false;

  std::wstring tmpPath = g_storageFilePath + L".tmp";
  HANDLE hFile = CreateFileW(
      tmpPath.c_str(), GENERIC_WRITE, 0, nullptr,
      CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hFile == INVALID_HANDLE_VALUE) return false;

  DWORD written = 0;
  BOOL ok = WriteFile(hFile, jsonUtf8.data(), static_cast<DWORD>(jsonUtf8.size()), &written, nullptr);
  FlushFileBuffers(hFile);
  CloseHandle(hFile);

  if (!ok || written != jsonUtf8.size()) {
    DeleteFileW(tmpPath.c_str());
    return false;
  }

  return MoveFileExW(tmpPath.c_str(), g_storageFilePath.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
}

/* ==========================================================================
   Multi-Encoding Disk File Reader & Direct Saver
   Supports .inf .ini .log .ps1 .psd1 .psm1 .scp .txt .wtx .MS-NOTEPAD .json
   .bat .cmd .reg .md + all source code & config files (UTF-8, BOM, UTF-16, ANSI)
   ========================================================================== */

std::wstring normalizeFullPath(const std::wstring &raw) {
  if (raw.empty()) return L"";
  DWORD need = GetFullPathNameW(raw.c_str(), 0, nullptr, nullptr);
  if (need == 0) return raw;
  std::wstring full(static_cast<size_t>(need), L'\0');
  DWORD len = GetFullPathNameW(raw.c_str(), need, &full[0], nullptr);
  if (len == 0) return raw;
  full.resize(len);
  return full;
}

std::wstring extractFileName(const std::wstring &path) {
  const wchar_t *fn = PathFindFileNameW(path.c_str());
  return fn ? std::wstring(fn) : path;
}

std::wstring extractFileExt(const std::wstring &path) {
  const wchar_t *ext = PathFindExtensionW(path.c_str());
  return ext ? toLowerWide(std::wstring(ext)) : L"";
}

std::string buildDiskFileJson(const std::wstring &inputPath, bool &outOk) {
  outOk = false;
  std::wstring fullPath = normalizeFullPath(inputPath);
  if (fullPath.empty()) return "null";

  DWORD attrs = GetFileAttributesW(fullPath.c_str());
  if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    return "null";
  }

  std::wstring fileName = extractFileName(fullPath);
  std::wstring fileExt = extractFileExt(fullPath);

  /* Classic Notepad behavior: if file doesn't exist yet on CLI, open empty tab bound to fullPath */
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    outOk = true;
    return std::string("{") +
           "\"path\":" + jsonEscape(wideToUtf8(fullPath)) + "," +
           "\"name\":" + jsonEscape(wideToUtf8(fileName)) + "," +
           "\"ext\":" + jsonEscape(wideToUtf8(fileExt)) + "," +
           "\"encoding\":\"UTF-8\"," +
           "\"exists\":false," +
           "\"content\":\"\"}";
  }

  HANDLE hFile = CreateFileW(
      fullPath.c_str(), GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hFile == INVALID_HANDLE_VALUE) return "null";

  LARGE_INTEGER sz{};
  if (!GetFileSizeEx(hFile, &sz) || sz.QuadPart < 0 || sz.QuadPart > 32 * 1024 * 1024) {
    CloseHandle(hFile);
    return "null";
  }

  std::string raw(static_cast<size_t>(sz.QuadPart), '\0');
  DWORD bytesRead = 0;
  if (!raw.empty()) {
    BOOL rf = ReadFile(hFile, &raw[0], static_cast<DWORD>(raw.size()), &bytesRead, nullptr);
    if (!rf) {
      CloseHandle(hFile);
      return "null";
    }
    raw.resize(bytesRead);
  }
  CloseHandle(hFile);

  std::string encoding = "UTF-8";
  std::string utf8Text;

  const unsigned char *b = reinterpret_cast<const unsigned char *>(raw.data());
  size_t n = raw.size();

  if (n >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) {
    encoding = "UTF-8 BOM";
    utf8Text.assign(raw.data() + 3, n - 3);
  } else if (n >= 2 && b[0] == 0xFF && b[1] == 0xFE) {
    encoding = "UTF-16LE";
    size_t wlen = (n - 2) / 2;
    std::wstring ws(wlen, L'\0');
    if (wlen > 0) std::memcpy(&ws[0], raw.data() + 2, wlen * 2);
    for (wchar_t &wc : ws) {
      if (wc == L'\0') wc = L' ';
    }
    utf8Text = wideToUtf8(ws);
  } else if (n >= 2 && b[0] == 0xFE && b[1] == 0xFF) {
    encoding = "UTF-16BE";
    size_t wlen = (n - 2) / 2;
    std::wstring ws(wlen, L'\0');
    for (size_t i = 0; i < wlen; ++i) {
      unsigned char hi = b[2 + i * 2];
      unsigned char lo = b[2 + i * 2 + 1];
      wchar_t wc = static_cast<wchar_t>((static_cast<unsigned short>(hi) << 8) | lo);
      ws[i] = (wc == L'\0') ? L' ' : wc;
    }
    utf8Text = wideToUtf8(ws);
  } else if (n > 0) {
    int validUtf8 = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, raw.data(), static_cast<int>(n), nullptr, 0);
    if (validUtf8 > 0) {
      encoding = "UTF-8";
      utf8Text = raw;
    } else {
      encoding = "ANSI";
      int wlen = MultiByteToWideChar(CP_ACP, 0, raw.data(), static_cast<int>(n), nullptr, 0);
      if (wlen > 0) {
        std::wstring ws(static_cast<size_t>(wlen), L'\0');
        MultiByteToWideChar(CP_ACP, 0, raw.data(), static_cast<int>(n), &ws[0], wlen);
        for (wchar_t &wc : ws) {
          if (wc == L'\0') wc = L' ';
        }
        utf8Text = wideToUtf8(ws);
      } else {
        utf8Text = raw;
      }
    }
  }

  for (char &ch : utf8Text) {
    if (ch == '\0') ch = ' ';
  }

  outOk = true;
  return std::string("{") +
         "\"path\":" + jsonEscape(wideToUtf8(fullPath)) + "," +
         "\"name\":" + jsonEscape(wideToUtf8(fileName)) + "," +
         "\"ext\":" + jsonEscape(wideToUtf8(fileExt)) + "," +
         "\"encoding\":" + jsonEscape(encoding) + "," +
         "\"exists\":true," +
         "\"content\":" + jsonEscape(utf8Text) + "}";
}

bool writeDiskTextFile(const std::wstring &fullPath, const std::string &utf8Content, const std::string &encoding) {
  if (fullPath.empty()) return false;

  std::string outBytes;
  if (encoding == "UTF-8 BOM") {
    outBytes.assign("\xEF\xBB\xBF", 3);
    outBytes += utf8Content;
  } else if (encoding == "UTF-16LE") {
    std::wstring ws = utf8ToWide(utf8Content);
    outBytes.assign("\xFF\xFE", 2);
    if (!ws.empty()) {
      outBytes.append(reinterpret_cast<const char *>(ws.data()), ws.size() * sizeof(wchar_t));
    }
  } else if (encoding == "UTF-16BE") {
    std::wstring ws = utf8ToWide(utf8Content);
    outBytes.assign("\xFE\xFF", 2);
    for (wchar_t wc : ws) {
      unsigned short v = static_cast<unsigned short>(wc);
      outBytes.push_back(static_cast<char>((v >> 8) & 0xFF));
      outBytes.push_back(static_cast<char>(v & 0xFF));
    }
  } else if (encoding == "ANSI") {
    std::wstring ws = utf8ToWide(utf8Content);
    if (!ws.empty()) {
      int alen = WideCharToMultiByte(CP_ACP, 0, ws.data(), static_cast<int>(ws.size()), nullptr, 0, nullptr, nullptr);
      if (alen > 0) {
        outBytes.resize(static_cast<size_t>(alen));
        WideCharToMultiByte(CP_ACP, 0, ws.data(), static_cast<int>(ws.size()), &outBytes[0], alen, nullptr, nullptr);
      } else {
        outBytes = utf8Content;
      }
    }
  } else {
    outBytes = utf8Content;
  }

  HANDLE hFile = CreateFileW(
      fullPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
      nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hFile == INVALID_HANDLE_VALUE) return false;

  DWORD written = 0;
  BOOL ok = outBytes.empty()
      ? TRUE
      : WriteFile(hFile, outBytes.data(), static_cast<DWORD>(outBytes.size()), &written, nullptr);
  FlushFileBuffers(hFile);
  CloseHandle(hFile);
  return ok && written == outBytes.size();
}

void enqueueFilePathForFrontend(const std::wstring &path) {
  bool ok = false;
  std::string itemJson = buildDiskFileJson(path, ok);
  if (!ok) return;
  {
    std::lock_guard<std::mutex> lock(g_filesMutex);
    g_pendingFileJsonItems.push_back(std::move(itemJson));
  }
  if (g_notifyFrontendFiles) {
    g_notifyFrontendFiles();
  }
}

std::string drainPendingFilesJson() {
  std::lock_guard<std::mutex> lock(g_filesMutex);
  if (g_pendingFileJsonItems.empty()) return "[]";
  std::string arr = "[";
  for (size_t i = 0; i < g_pendingFileJsonItems.size(); ++i) {
    if (i > 0) arr.push_back(',');
    arr += g_pendingFileJsonItems[i];
  }
  arr.push_back(']');
  g_pendingFileJsonItems.clear();
  return arr;
}

/* Parse CLI arguments, IFEO notepad.exe arguments & ms-notepad: protocol URLs */
std::vector<std::wstring> parseCommandLineFiles(bool &forceBrowser) {
  forceBrowser = false;
  std::vector<std::wstring> result;

  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (!argv) return result;

  bool ifeoMode = false;
  bool skippedNotepadTarget = false;

  for (int i = 1; i < argc; ++i) {
    std::wstring arg = argv[i] ? argv[i] : L"";
    if (arg.empty()) continue;
    std::wstring low = toLowerWide(arg);

    if (low == L"--browser") {
      forceBrowser = true;
      continue;
    }
    if (low == L"--ifeo") {
      ifeoMode = true;
      continue;
    }

    /* When launched as IFEO Debugger for notepad.exe, arg right after --ifeo is "...\notepad.exe" */
    if (ifeoMode && !skippedNotepadTarget) {
      std::wstring base = toLowerWide(extractFileName(arg));
      if (base == L"notepad.exe" || base == L"notepad") {
        skippedNotepadTarget = true;
        continue;
      }
    }

    /* Classic notepad.exe switches (/A, /W, /P, /PT) */
    if (low == L"/a" || low == L"/w" || low == L"/p" || low == L"-a" || low == L"-w" || low == L"-p") {
      continue;
    }
    if (low == L"/pt") {
      /* /PT "filename" "printername" "driverdll" "port" -> grab filename if present */
      if (i + 1 < argc) {
        result.push_back(normalizeFullPath(argv[i + 1]));
      }
      break;
    }

    /* Handle ms-notepad: URL protocol */
    if (low.rfind(L"ms-notepad:", 0) == 0) {
      std::string restUtf8 = urlDecodeUtf8(wideToUtf8(arg.substr(11)));
      while (!restUtf8.empty() && (restUtf8.front() == '/' || restUtf8.front() == '?' || restUtf8.front() == ' ')) {
        restUtf8.erase(restUtf8.begin());
      }
      auto stripPrefix = [&](const char *pfx) {
        size_t plen = std::strlen(pfx);
        if (restUtf8.size() >= plen && _strnicmp(restUtf8.c_str(), pfx, plen) == 0) {
          restUtf8.erase(0, plen);
        }
      };
      stripPrefix("open/?path=");
      stripPrefix("open?path=");
      stripPrefix("path=");
      stripPrefix("file:///");
      stripPrefix("file://");
      if (!restUtf8.empty() && restUtf8.front() == '"' && restUtf8.back() == '"' && restUtf8.size() >= 2) {
        restUtf8 = restUtf8.substr(1, restUtf8.size() - 2);
      }
      std::wstring candidate = utf8ToWide(restUtf8);
      if (candidate.size() >= 2 && ((candidate[1] == L':') || (candidate[0] == L'\\' && candidate[1] == L'\\'))) {
        std::replace(candidate.begin(), candidate.end(), L'/', L'\\');
        result.push_back(normalizeFullPath(candidate));
      }
      continue;
    }

    /* Ignore unknown --flags */
    if (low.rfind(L"--", 0) == 0) continue;

    result.push_back(normalizeFullPath(arg));
  }

  LocalFree(argv);
  return result;
}

/* ==========================================================================
   Pure Win32 Registry Windows Notepad Replacement & File Association Engine
   (Zero .bat scripts — 100% native C++ inside Graphite.exe)
   Supports: .inf .ini .log .ps1 .psd1 .psm1 .scp .txt .wtx MS-NOTEPAD .json
   .bat .cmd .reg .md + all source code & plain-text config formats
   ========================================================================== */

static const wchar_t *const kAllSupportedExtensions[] = {
  /* Core Windows Notepad extensions */
  L".inf", L".ini", L".log", L".ps1", L".psd1", L".psm1", L".scp", L".txt", L".wtx", L".ms-notepad",
  /* JSON, Config & Structured Text */
  L".json", L".jsonc", L".md", L".markdown", L".xml", L".svg", L".yaml", L".yml", L".toml",
  L".cfg", L".conf", L".config", L".env", L".properties", L".csv", L".tsv", L".nfo", L".rst", L".tex",
  /* Batch, Shell & Scripts */
  L".bat", L".cmd", L".reg", L".vbs", L".sh", L".bash", L".sql",
  /* Source Code */
  L".py", L".js", L".mjs", L".cjs", L".ts", L".tsx", L".jsx",
  L".c", L".cpp", L".cc", L".cxx", L".h", L".hh", L".hpp",
  L".cs", L".java", L".kt", L".swift", L".go", L".rs", L".php", L".rb", L".lua",
  L".html", L".htm", L".css", L".scss", L".less", L".vue", L".svelte"
};

static const wchar_t *const kCoreOpenDefaultExtensions[] = {
  L".inf", L".ini", L".log", L".ps1", L".psd1", L".psm1", L".scp", L".txt", L".wtx", L".ms-notepad",
  L".json", L".md"
};

void regWriteSz(HKEY root, const wchar_t *subKey, const wchar_t *valName, const std::wstring &val) {
  HKEY hKey = nullptr;
  if (RegCreateKeyExW(root, subKey, 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
    RegSetValueExW(hKey, valName, 0, REG_SZ,
                   reinterpret_cast<const BYTE *>(val.c_str()),
                   static_cast<DWORD>((val.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(hKey);
  }
}

void regWriteNone(HKEY root, const wchar_t *subKey, const wchar_t *valName) {
  HKEY hKey = nullptr;
  if (RegCreateKeyExW(root, subKey, 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
    RegSetValueExW(hKey, valName, 0, REG_NONE, nullptr, 0);
    RegCloseKey(hKey);
  }
}

void regWriteDword(HKEY root, const wchar_t *subKey, const wchar_t *valName, DWORD val) {
  HKEY hKey = nullptr;
  if (RegCreateKeyExW(root, subKey, 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
    RegSetValueExW(hKey, valName, 0, REG_DWORD, reinterpret_cast<const BYTE *>(&val), sizeof(DWORD));
    RegCloseKey(hKey);
  }
}

void regDeleteValueSafe(HKEY root, const wchar_t *subKey, const wchar_t *valName) {
  HKEY hKey = nullptr;
  if (RegOpenKeyExW(root, subKey, 0, KEY_SET_VALUE, &hKey) == ERROR_SUCCESS) {
    RegDeleteValueW(hKey, valName);
    RegCloseKey(hKey);
  }
}

std::wstring regReadSzVal(HKEY root, const wchar_t *subKey, const wchar_t *valName) {
  HKEY hKey = nullptr;
  if (RegOpenKeyExW(root, subKey, 0, KEY_QUERY_VALUE, &hKey) != ERROR_SUCCESS) return L"";
  wchar_t buf[512]{};
  DWORD cb = sizeof(buf) - sizeof(wchar_t);
  DWORD type = 0;
  std::wstring res;
  if (RegQueryValueExW(hKey, valName, nullptr, &type, reinterpret_cast<LPBYTE>(buf), &cb) == ERROR_SUCCESS &&
      (type == REG_SZ || type == REG_EXPAND_SZ)) {
    res = buf;
  }
  RegCloseKey(hKey);
  return res;
}

void resolveAppIconInfo(const std::string &iconKey, WORD &outResId, int &outIconIdx) {
  if (iconKey == "blue") { outResId = 102; outIconIdx = 1; }
  else if (iconKey == "white") { outResId = 103; outIconIdx = 2; }
  else if (iconKey == "purple") { outResId = 104; outIconIdx = 3; }
  else if (iconKey == "yellow") { outResId = 105; outIconIdx = 4; }
  else if (iconKey == "red") { outResId = 106; outIconIdx = 5; }
  else if (iconKey == "green") { outResId = 107; outIconIdx = 6; }
  else if (iconKey == "pink") { outResId = 108; outIconIdx = 7; }
  else { outResId = 101; outIconIdx = 0; }
}

std::string getSavedAppIconKey() {
  std::wstring w = regReadSzVal(HKEY_CURRENT_USER, L"Software\\GraphitePortable", L"AppIcon");
  if (w.empty()) return "bw";
  return wideToUtf8(w);
}

bool createOrUpdateDesktopShortcut(const std::string &iconKey, bool onlyIfExisting) {
  if (g_exeFullPath.empty()) return false;
  wchar_t desktopDir[MAX_PATH]{};
  if (FAILED(SHGetFolderPathW(nullptr, CSIDL_DESKTOPDIRECTORY, nullptr, SHGFP_TYPE_CURRENT, desktopDir))) {
    return false;
  }
  std::wstring lnkPath = std::wstring(desktopDir) + L"\\Graphite.lnk";
  if (onlyIfExisting && GetFileAttributesW(lnkPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    return false;
  }

  WORD resId = 101;
  int iconIdx = 0;
  resolveAppIconInfo(iconKey, resId, iconIdx);

  HRESULT hrCo = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  IShellLinkW *pLink = nullptr;
  bool ok = false;
  if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW, reinterpret_cast<void **>(&pLink))) && pLink) {
    pLink->SetPath(g_exeFullPath.c_str());
    pLink->SetWorkingDirectory(g_exeDirPath.c_str());
    pLink->SetDescription(L"Graphite");
    pLink->SetIconLocation(g_exeFullPath.c_str(), iconIdx);

    IPersistFile *pFile = nullptr;
    if (SUCCEEDED(pLink->QueryInterface(IID_IPersistFile, reinterpret_cast<void **>(&pFile))) && pFile) {
      if (SUCCEEDED(pFile->Save(lnkPath.c_str(), TRUE))) {
        ok = true;
        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, lnkPath.c_str(), nullptr);
      }
      pFile->Release();
    }
    pLink->Release();
  }
  if (SUCCEEDED(hrCo)) CoUninitialize();
  return ok;
}

HICON g_hCurBigIcon = nullptr;
HICON g_hCurSmallIcon = nullptr;

void applyWindowAppIcon(HWND hwnd, const std::string &iconKey, bool persistAndSyncShell) {
  WORD resId = 101;
  int iconIdx = 0;
  resolveAppIconInfo(iconKey, resId, iconIdx);

  if (hwnd) {
    HINSTANCE hInst = GetModuleHandleW(nullptr);
    int cxBig = GetSystemMetrics(SM_CXICON);
    int cyBig = GetSystemMetrics(SM_CYICON);
    int cxSm = GetSystemMetrics(SM_CXSMICON);
    int cySm = GetSystemMetrics(SM_CYSMICON);

    HICON hBig = static_cast<HICON>(LoadImageW(hInst, MAKEINTRESOURCEW(resId), IMAGE_ICON, cxBig, cyBig, LR_DEFAULTCOLOR));
    HICON hSm = static_cast<HICON>(LoadImageW(hInst, MAKEINTRESOURCEW(resId), IMAGE_ICON, cxSm, cySm, LR_DEFAULTCOLOR));

    if (hBig) {
      SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(hBig));
      SetClassLongPtrW(hwnd, GCLP_HICON, reinterpret_cast<LONG_PTR>(hBig));
      if (g_hCurBigIcon && g_hCurBigIcon != hBig) DestroyIcon(g_hCurBigIcon);
      g_hCurBigIcon = hBig;
    }
    if (hSm) {
      SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(hSm));
      SetClassLongPtrW(hwnd, GCLP_HICONSM, reinterpret_cast<LONG_PTR>(hSm));
      if (g_hCurSmallIcon && g_hCurSmallIcon != hSm) DestroyIcon(g_hCurSmallIcon);
      g_hCurSmallIcon = hSm;
    }

    /* Update Windows 10/11 Taskbar button RelaunchIconResource + AppUserModelID so Taskbar refreshes too */
    if (!g_exeFullPath.empty()) {
      IPropertyStore *pps = nullptr;
      if (SUCCEEDED(SHGetPropertyStoreForWindow(hwnd, IID_IPropertyStore, reinterpret_cast<void **>(&pps))) && pps) {
        std::wstring iconRes = g_exeFullPath + L",-" + std::to_wstring(resId);
        std::wstring appId = L"FleetwayLOL.Graphite.AppV2." + utf8ToWide(iconKey);
        PROPVARIANT pvIcon{};
        pvIcon.vt = VT_LPWSTR;
        pvIcon.pwszVal = const_cast<LPWSTR>(iconRes.c_str());
        pps->SetValue(PKEY_AppUserModel_RelaunchIconResource, pvIcon);
        PROPVARIANT pvId{};
        pvId.vt = VT_LPWSTR;
        pvId.pwszVal = const_cast<LPWSTR>(appId.c_str());
        pps->SetValue(PKEY_AppUserModel_ID, pvId);
        pps->Commit();
        pps->Release();
      }
    }
    RedrawWindow(hwnd, nullptr, nullptr, RDW_FRAME | RDW_INVALIDATE);
  }

  if (persistAndSyncShell && !g_exeFullPath.empty()) {
    std::string prev = getSavedAppIconKey();
    regWriteSz(HKEY_CURRENT_USER, L"Software\\GraphitePortable", L"AppIcon", utf8ToWide(iconKey));
    if (prev != iconKey) {
      std::wstring iconVal = L"\"" + g_exeFullPath + L"\"," + std::to_wstring(iconIdx);
      if (!regReadSzVal(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Document\\DefaultIcon", nullptr).empty()) {
        regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Document\\DefaultIcon", nullptr, iconVal);
        regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Protocol\\DefaultIcon", nullptr, iconVal);
        regWriteSz(HKEY_CURRENT_USER, L"Software\\GraphitePortable\\Capabilities", L"ApplicationIcon", iconVal);
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
      }
      createOrUpdateDesktopShortcut(iconKey, true);
    }
  }
}

/* Registers Graphite in Windows Settings -> Apps -> Default Apps (no Admin needed) */
void registerCapabilitiesInHkcu() {
  if (g_exeFullPath.empty()) return;
  WORD resId = 101;
  int iconIdx = 0;
  resolveAppIconInfo(getSavedAppIconKey(), resId, iconIdx);
  std::wstring iconVal = L"\"" + g_exeFullPath + L"\"," + std::to_wstring(iconIdx);
  std::wstring openCmd = L"\"" + g_exeFullPath + L"\" \"%1\"";

  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Document", nullptr, L"Graphite Text & Code Document");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Document\\DefaultIcon", nullptr, iconVal);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Document\\shell\\open\\command", nullptr, openCmd);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Document\\shell\\edit\\command", nullptr, openCmd);

  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Protocol", nullptr, L"URL:ms-notepad Protocol");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Protocol", L"URL Protocol", L"");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Protocol\\DefaultIcon", nullptr, iconVal);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\Graphite.Protocol\\shell\\open\\command", nullptr, openCmd);

  regWriteSz(HKEY_CURRENT_USER, L"Software\\GraphitePortable\\Capabilities", L"ApplicationName", L"Graphite");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\GraphitePortable\\Capabilities", L"ApplicationDescription",
             L"Graphite — Умный портативный блокнот (замена Блокноту Windows)");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\GraphitePortable\\Capabilities", L"ApplicationIcon", iconVal);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\GraphitePortable\\Capabilities\\URLAssociations", L"ms-notepad", L"Graphite.Protocol");

  for (const wchar_t *ext : kAllSupportedExtensions) {
    regWriteSz(HKEY_CURRENT_USER, L"Software\\GraphitePortable\\Capabilities\\FileAssociations", ext, L"Graphite.Document");
    std::wstring owp = std::wstring(L"Software\\Classes\\") + ext + L"\\OpenWithProgids";
    regWriteNone(HKEY_CURRENT_USER, owp.c_str(), L"Graphite.Document");
  }

  regWriteSz(HKEY_CURRENT_USER, L"Software\\RegisteredApplications", L"GraphitePortable",
             L"Software\\GraphitePortable\\Capabilities");
}

void setWin11StoreNotepadAliasEnabled(bool enabled) {
  const wchar_t *aliasKey =
      L"Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData\\"
      L"Microsoft.WindowsNotepad_8wekyb3d8bbwe\\Aliases\\notepad.exe";
  HKEY hKey = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, aliasKey, 0, KEY_SET_VALUE, &hKey) == ERROR_SUCCESS) {
    DWORD v = enabled ? 1 : 0;
    RegSetValueExW(hKey, L"Enabled", 0, REG_DWORD, reinterpret_cast<const BYTE *>(&v), sizeof(v));
    RegCloseKey(hKey);
  }
}

void applyDefaultNotepadHkcu() {
  if (g_exeFullPath.empty()) return;
  registerCapabilitiesInHkcu();

  WORD resId = 101;
  int iconIdx = 0;
  resolveAppIconInfo(getSavedAppIconKey(), resId, iconIdx);
  std::wstring iconVal = L"\"" + g_exeFullPath + L"\"," + std::to_wstring(iconIdx);
  std::wstring openCmd = L"\"" + g_exeFullPath + L"\" \"%1\"";

  /* Direct HKCU handlers for core Notepad extensions & ms-notepad protocol */
  for (const wchar_t *ext : kCoreOpenDefaultExtensions) {
    std::wstring k = std::wstring(L"Software\\Classes\\") + ext;
    regWriteSz(HKEY_CURRENT_USER, k.c_str(), nullptr, L"Graphite.Document");
  }
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\ms-notepad", nullptr, L"URL:ms-notepad Protocol");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\ms-notepad", L"URL Protocol", L"");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\ms-notepad\\DefaultIcon", nullptr, iconVal);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\ms-notepad\\shell\\open\\command", nullptr, openCmd);

  /* Set Edit verb on .bat / .cmd / .reg / .vbs while preserving double-click script execution */
  const wchar_t *scriptExts[] = {L".bat", L".cmd", L".reg", L".vbs"};
  for (const wchar_t *se : scriptExts) {
    std::wstring sfa = std::wstring(L"Software\\Classes\\SystemFileAssociations\\") + se + L"\\shell\\edit\\command";
    regWriteSz(HKEY_CURRENT_USER, sfa.c_str(), nullptr, openCmd);
  }
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\batfile\\shell\\edit\\command", nullptr, openCmd);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\cmdfile\\shell\\edit\\command", nullptr, openCmd);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\regfile\\shell\\edit\\command", nullptr, openCmd);

  /* Universal Explorer right-click item "Открыть в Graphite" for any file */
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\*\\shell\\Graphite", nullptr, L"Открыть в Graphite");
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\*\\shell\\Graphite", L"Icon", iconVal);
  regWriteSz(HKEY_CURRENT_USER, L"Software\\Classes\\*\\shell\\Graphite\\command", nullptr, openCmd);

  setWin11StoreNotepadAliasEnabled(false);
}

void restoreDefaultNotepadHkcu() {
  for (const wchar_t *ext : kCoreOpenDefaultExtensions) {
    std::wstring k = std::wstring(L"Software\\Classes\\") + ext;
    regDeleteValueSafe(HKEY_CURRENT_USER, k.c_str(), nullptr);
  }
  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\ms-notepad");
  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\*\\shell\\Graphite");

  const wchar_t *scriptExts[] = {L".bat", L".cmd", L".reg", L".vbs"};
  for (const wchar_t *se : scriptExts) {
    std::wstring sfa = std::wstring(L"Software\\Classes\\SystemFileAssociations\\") + se + L"\\shell\\edit";
    RegDeleteTreeW(HKEY_CURRENT_USER, sfa.c_str());
  }
  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\batfile\\shell\\edit");
  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\cmdfile\\shell\\edit");
  RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\regfile\\shell\\edit");

  /* Clear any Explorer UserChoice pointing to Graphite.* so Windows Notepad takes over */
  for (const wchar_t *ext : kAllSupportedExtensions) {
    std::wstring ucKey = std::wstring(L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\") + ext + L"\\UserChoice";
    HKEY hUc = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, ucKey.c_str(), 0, KEY_READ, &hUc) == ERROR_SUCCESS) {
      wchar_t progId[256] = {0};
      DWORD cb = sizeof(progId);
      LONG rc = RegQueryValueExW(hUc, L"ProgId", nullptr, nullptr, reinterpret_cast<LPBYTE>(progId), &cb);
      RegCloseKey(hUc);
      if (rc == ERROR_SUCCESS && wcsncmp(progId, L"Graphite.", 9) == 0) {
        RegDeleteTreeW(HKEY_CURRENT_USER, ucKey.c_str());
      }
    }
  }
  const wchar_t *urlUc = L"Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\ms-notepad\\UserChoice";
  HKEY hUrlUc = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, urlUc, 0, KEY_READ, &hUrlUc) == ERROR_SUCCESS) {
    wchar_t progId[256] = {0};
    DWORD cb = sizeof(progId);
    LONG rc = RegQueryValueExW(hUrlUc, L"ProgId", nullptr, nullptr, reinterpret_cast<LPBYTE>(progId), &cb);
    RegCloseKey(hUrlUc);
    if (rc == ERROR_SUCCESS && wcsncmp(progId, L"Graphite.", 9) == 0) {
      RegDeleteTreeW(HKEY_CURRENT_USER, urlUc);
    }
  }

  setWin11StoreNotepadAliasEnabled(true);
}

bool applyDefaultNotepadHklmElevated() {
  if (g_exeFullPath.empty()) return false;
  const wchar_t *ifeoSub = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\notepad.exe";
  HKEY hKey = nullptr;
  if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, ifeoSub, 0, nullptr, REG_OPTION_NON_VOLATILE,
                      KEY_READ | KEY_SET_VALUE, nullptr, &hKey, nullptr) != ERROR_SUCCESS) {
    return false;
  }

  DWORD existingBackup = 0;
  DWORD cb = sizeof(existingBackup);
  if (RegQueryValueExW(hKey, L"Graphite_Backup_UseFilter", nullptr, nullptr,
                       reinterpret_cast<LPBYTE>(&existingBackup), &cb) != ERROR_SUCCESS) {
    DWORD curUseFilter = 0;
    cb = sizeof(curUseFilter);
    if (RegQueryValueExW(hKey, L"UseFilter", nullptr, nullptr,
                         reinterpret_cast<LPBYTE>(&curUseFilter), &cb) == ERROR_SUCCESS) {
      RegSetValueExW(hKey, L"Graphite_Backup_UseFilter", 0, REG_DWORD,
                     reinterpret_cast<const BYTE *>(&curUseFilter), sizeof(curUseFilter));
    }
  }

  DWORD zero = 0;
  RegSetValueExW(hKey, L"UseFilter", 0, REG_DWORD, reinterpret_cast<const BYTE *>(&zero), sizeof(zero));
  std::wstring dbg = L"\"" + g_exeFullPath + L"\" --ifeo";
  LONG rc = RegSetValueExW(hKey, L"Debugger", 0, REG_SZ,
                           reinterpret_cast<const BYTE *>(dbg.c_str()),
                           static_cast<DWORD>((dbg.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(hKey);

  regWriteSz(HKEY_LOCAL_MACHINE, L"SOFTWARE\\RegisteredApplications", L"GraphitePortable",
             L"Software\\GraphitePortable\\Capabilities");
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
  return rc == ERROR_SUCCESS;
}

bool restoreDefaultNotepadHklmElevated() {
  const wchar_t *ifeoSub = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\notepad.exe";
  HKEY hKey = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, ifeoSub, 0, KEY_READ | KEY_SET_VALUE, &hKey) != ERROR_SUCCESS) {
    return false;
  }

  RegDeleteValueW(hKey, L"Debugger");

  DWORD backupFilter = 0;
  DWORD cb = sizeof(backupFilter);
  if (RegQueryValueExW(hKey, L"Graphite_Backup_UseFilter", nullptr, nullptr,
                       reinterpret_cast<LPBYTE>(&backupFilter), &cb) == ERROR_SUCCESS) {
    RegSetValueExW(hKey, L"UseFilter", 0, REG_DWORD,
                   reinterpret_cast<const BYTE *>(&backupFilter), sizeof(backupFilter));
    RegDeleteValueW(hKey, L"Graphite_Backup_UseFilter");
  } else {
    HKEY hSub0 = nullptr;
    if (RegOpenKeyExW(hKey, L"0", 0, KEY_READ, &hSub0) == ERROR_SUCCESS) {
      RegCloseKey(hSub0);
      DWORD one = 1;
      RegSetValueExW(hKey, L"UseFilter", 0, REG_DWORD, reinterpret_cast<const BYTE *>(&one), sizeof(one));
    } else {
      RegDeleteValueW(hKey, L"UseFilter");
    }
  }

  RegCloseKey(hKey);
  regDeleteValueSafe(HKEY_LOCAL_MACHINE, L"SOFTWARE\\RegisteredApplications", L"GraphitePortable");
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
  return true;
}

bool spawnElevatedSelfSwitch(const wchar_t *flag) {
  if (g_exeFullPath.empty()) return false;
  SHELLEXECUTEINFOW sei{};
  sei.cbSize = sizeof(sei);
  sei.fMask = SEE_MASK_NOCLOSEPROCESS;
  sei.hwnd = g_mainAppHwnd;
  sei.lpVerb = L"runas";
  sei.lpFile = g_exeFullPath.c_str();
  sei.lpParameters = flag;
  sei.nShow = SW_HIDE;
  if (!ShellExecuteExW(&sei)) return false;
  if (sei.hProcess) {
    WaitForSingleObject(sei.hProcess, 8000);
    CloseHandle(sei.hProcess);
  }
  return true;
}

bool isGraphiteDefaultNotepad() {
  HKEY hKey = nullptr;
  if (RegOpenKeyExW(
          HKEY_LOCAL_MACHINE,
          L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\notepad.exe",
          0, KEY_READ, &hKey) == ERROR_SUCCESS) {
    wchar_t buf[1024] = {0};
    DWORD cb = sizeof(buf);
    DWORD type = 0;
    LONG rc = RegQueryValueExW(hKey, L"Debugger", nullptr, &type, reinterpret_cast<LPBYTE>(buf), &cb);
    RegCloseKey(hKey);
    if (rc == ERROR_SUCCESS && (type == REG_SZ || type == REG_EXPAND_SZ)) {
      std::wstring low = toLowerWide(buf);
      if (low.find(L"graphite") != std::wstring::npos) return true;
    }
  }
  HKEY hTxt = nullptr;
  if (RegOpenKeyExW(
          HKEY_CURRENT_USER,
          L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt\\UserChoice",
          0, KEY_READ, &hTxt) == ERROR_SUCCESS) {
    wchar_t progId[256] = {0};
    DWORD cb = sizeof(progId);
    LONG rc = RegQueryValueExW(hTxt, L"ProgId", nullptr, nullptr, reinterpret_cast<LPBYTE>(progId), &cb);
    RegCloseKey(hTxt);
    if (rc == ERROR_SUCCESS && wcsncmp(progId, L"Graphite.", 9) == 0) return true;
  }
  return false;
}

bool setGraphiteAsDefaultNotepad(bool openWinDefaultAppsPage) {
  applyDefaultNotepadHkcu();
  if (!applyDefaultNotepadHklmElevated()) {
    spawnElevatedSelfSwitch(L"--elevate-set-default");
  }
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
  if (openWinDefaultAppsPage) {
    ShellExecuteW(nullptr, L"open", L"ms-settings:defaultapps?registeredAppUser=GraphitePortable",
                  nullptr, nullptr, SW_SHOWNORMAL);
  }
  return true;
}

bool restoreWindowsNotepadDefault() {
  restoreDefaultNotepadHkcu();
  if (!restoreDefaultNotepadHklmElevated()) {
    spawnElevatedSelfSwitch(L"--elevate-restore-default");
  }
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);
  return true;
}

/* Single-Instance IPC Hidden Window so opening multiple files opens tabs in 1 window */
LRESULT CALLBACK ipcWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_COPYDATA && lp != 0) {
    const COPYDATASTRUCT *cds = reinterpret_cast<const COPYDATASTRUCT *>(lp);
    if (g_mainAppHwnd) {
      if (IsIconic(g_mainAppHwnd)) ShowWindow(g_mainAppHwnd, SW_RESTORE);
      SetForegroundWindow(g_mainAppHwnd);
    }
    if (cds->dwData == kIpcOpenFileTag && cds->lpData && cds->cbData > 0) {
      std::string pathUtf8(reinterpret_cast<const char *>(cds->lpData), cds->cbData);
      while (!pathUtf8.empty() && pathUtf8.back() == '\0') pathUtf8.pop_back();
      if (!pathUtf8.empty()) {
        enqueueFilePathForFrontend(utf8ToWide(pathUtf8));
      }
    }
    return 1;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

HWND createSingleInstanceIpcWindow() {
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = ipcWndProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kIpcClassName;
  RegisterClassExW(&wc);
  return CreateWindowExW(
      0, kIpcClassName, kIpcWindowTitle, 0,
      0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
}

/* ==========================================================================
   Frameless Window Drag & Native DWM Blur
   ========================================================================== */

static WNDPROC g_origWndProc = nullptr;
static constexpr UINT_PTR kDragTimerId = 0x474E;
static bool g_isDraggingWindow = false;
static POINT g_dragStartCursor = {0, 0};
static RECT g_dragStartWndRect = {0, 0, 0, 0};
static int g_lastMovedX = -999999;
static int g_lastMovedY = -999999;
static std::atomic<bool> g_hasUnsavedChanges{false};
static std::atomic<bool> g_forceCloseWindow{false};
static std::function<void()> g_requestCloseFrontend;

void stopSmoothWindowDrag(HWND hwnd) {
  if (!g_isDraggingWindow) return;
  g_isDraggingWindow = false;
  if (hwnd) {
    KillTimer(hwnd, kDragTimerId);
    if (GetCapture() == hwnd) {
      ReleaseCapture();
    }
  }
}

void updateSmoothWindowDrag(HWND hwnd) {
  if (!g_isDraggingWindow || !hwnd) return;
  if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) {
    stopSmoothWindowDrag(hwnd);
    return;
  }

  POINT cur{};
  if (!GetCursorPos(&cur)) return;

  int dx = cur.x - g_dragStartCursor.x;
  int dy = cur.y - g_dragStartCursor.y;

  if (IsZoomed(hwnd)) {
    if (std::abs(dx) < 6 && std::abs(dy) < 6) return;
    RECT maxRect{};
    GetWindowRect(hwnd, &maxRect);
    int maxW = std::max(1, static_cast<int>(maxRect.right - maxRect.left));
    double ratio = std::clamp(static_cast<double>(cur.x - maxRect.left) / maxW, 0.08, 0.92);

    ShowWindow(hwnd, SW_RESTORE);
    RECT restRect{};
    GetWindowRect(hwnd, &restRect);
    int restW = restRect.right - restRect.left;

    g_dragStartCursor = cur;
    g_dragStartWndRect.left = cur.x - static_cast<int>(restW * ratio);
    g_dragStartWndRect.top = cur.y - 18;
    dx = 0;
    dy = 0;
  }

  int targetX = g_dragStartWndRect.left + dx;
  int targetY = g_dragStartWndRect.top + dy;
  if (targetX != g_lastMovedX || targetY != g_lastMovedY) {
    g_lastMovedX = targetX;
    g_lastMovedY = targetY;
    SetWindowPos(hwnd, nullptr, targetX, targetY, 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  }
}

void startSmoothWindowDrag(HWND hwnd) {
  if (!hwnd || !(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) return;
  GetCursorPos(&g_dragStartCursor);
  GetWindowRect(hwnd, &g_dragStartWndRect);
  g_lastMovedX = g_dragStartWndRect.left;
  g_lastMovedY = g_dragStartWndRect.top;
  g_isDraggingWindow = true;
  ReleaseCapture();
  SetCapture(hwnd);
  SetTimer(hwnd, kDragTimerId, 4, nullptr);
}

LRESULT CALLBACK customDragHookWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_CLOSE && g_hasUnsavedChanges.load() && !g_forceCloseWindow.load()) {
    stopSmoothWindowDrag(hwnd);
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
    SetForegroundWindow(hwnd);
    if (g_requestCloseFrontend) g_requestCloseFrontend();
    return 0;
  }
  if (g_isDraggingWindow) {
    if (msg == WM_MOUSEMOVE) {
      updateSmoothWindowDrag(hwnd);
      return 0;
    }
    if (msg == WM_TIMER && wp == kDragTimerId) {
      updateSmoothWindowDrag(hwnd);
      return 0;
    }
    if (msg == WM_LBUTTONUP || msg == WM_RBUTTONDOWN || msg == WM_CAPTURECHANGED || msg == WM_KILLFOCUS) {
      stopSmoothWindowDrag(hwnd);
    }
  }
  return CallWindowProcW(g_origWndProc, hwnd, msg, wp, lp);
}

void setAcrylicComposition(HWND hwnd, int accentState, bool isDark) {
  static SetWindowCompositionAttributeFn pSetWca = reinterpret_cast<SetWindowCompositionAttributeFn>(
      GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetWindowCompositionAttribute"));
  if (!hwnd || !pSetWca) return;

  ACCENT_POLICY policy{};
  policy.AccentState = accentState;
  policy.AccentFlags = 0;
  policy.GradientColor = isDark ? 0x2210131A : 0x22F2F5FA;
  WINDOWCOMPOSITIONATTRIBDATA data{19 /* WCA_ACCENT_POLICY */, &policy, sizeof(policy)};
  pSetWca(hwnd, &data);
}

void applyNativeWindowStyle(HWND hwnd, bool enableOsScreenBlur, bool isDark) {
  if (!hwnd) return;

  if (!g_origWndProc) {
    g_origWndProc = reinterpret_cast<WNDPROC>(GetWindowLongPtrW(hwnd, GWLP_WNDPROC));
    if (g_origWndProc) {
      SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(customDragHookWndProc));
    }
  }

  /* 1. Windows 11 native rounded corners */
  int cornerPref = 2; /* DWMWCP_ROUND */
  DwmSetWindowAttribute(hwnd, 33, &cornerPref, sizeof(cornerPref));

  /* 2. Dark / Light system frame attribute */
  BOOL darkVal = isDark ? TRUE : FALSE;
  if (FAILED(DwmSetWindowAttribute(hwnd, 20, &darkVal, sizeof(darkVal)))) {
    DwmSetWindowAttribute(hwnd, 19, &darkVal, sizeof(darkVal));
  }

  /* 3. Extend DWM sheet across entire window */
  MARGINS margins = {-1, -1, -1, -1};
  DwmExtendFrameIntoClientArea(hwnd, &margins);

  /* 4. Only enable OS desktop-behind Acrylic when scene == "win_screen" */
  if (enableOsScreenBlur) {
    setAcrylicComposition(hwnd, 0 /* ACCENT_DISABLED */, isDark);
    int acrylicBackdrop = 3; /* DWMSBT_TRANSIENTWINDOW (Native Win11 Rounded Acrylic, zero drag lag) */
    if (FAILED(DwmSetWindowAttribute(hwnd, 38, &acrylicBackdrop, sizeof(acrylicBackdrop)))) {
      /* Fallback for Windows 10 */
      setAcrylicComposition(hwnd, 4 /* ACCENT_ENABLE_ACRYLICBLURBEHIND */, isDark);
    }
  } else {
    int noneBackdrop = 1; /* DWMSBT_NONE */
    DwmSetWindowAttribute(hwnd, 38, &noneBackdrop, sizeof(noneBackdrop));
    setAcrylicComposition(hwnd, 0 /* ACCENT_DISABLED */, isDark);
  }
}

/* Queries Windows Registry via AssocQueryStringW for the User's Default Browser */
void openUrlInUsersDefaultBrowser(const std::wstring &url, bool preferAppWindow) {
  if (url.empty()) return;

  if (preferAppWindow) {
    wchar_t browserExe[MAX_PATH] = {0};
    DWORD cch = MAX_PATH;
    if (SUCCEEDED(AssocQueryStringW(ASSOCF_NONE, ASSOCSTR_EXECUTABLE, L"https", L"open", browserExe, &cch)) &&
        browserExe[0] != L'\0') {
      std::wstring lowerExe = toLowerWide(browserExe);

      /* If the user's own default browser is Chrome, Yandex, Brave, Vivaldi, or Opera (NOT Edge unless default) */
      bool isChromiumAppCapable =
          lowerExe.find(L"chrome.exe") != std::wstring::npos ||
          lowerExe.find(L"browser.exe") != std::wstring::npos || /* Yandex Browser */
          lowerExe.find(L"brave.exe") != std::wstring::npos ||
          lowerExe.find(L"vivaldi.exe") != std::wstring::npos ||
          lowerExe.find(L"opera.exe") != std::wstring::npos;

      if (isChromiumAppCapable) {
        std::wstring args = L"--app=" + url;
        HINSTANCE r = ShellExecuteW(nullptr, L"open", browserExe, args.c_str(), nullptr, SW_SHOWNORMAL);
        if (reinterpret_cast<INT_PTR>(r) > 32) return;
      }
    }
  }

  /* Standard Windows Default Browser launch */
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

/* Native Win32 Open File Dialog (supports multi-select & all text/code/config extensions) */
std::string showNativeOpenFileDialog(HWND owner, const std::string &lang) {
  std::vector<wchar_t> fileBuf(32768, L'\0');
  const wchar_t *filterRu =
      L"Все поддерживаемые текстовые файлы и код\0"
      L"*.txt;*.inf;*.ini;*.log;*.ps1;*.psd1;*.psm1;*.scp;*.wtx;*.ms-notepad;*.json;*.jsonc;*.bat;*.cmd;*.reg;*.vbs;"
      L"*.md;*.markdown;*.xml;*.yaml;*.yml;*.toml;*.cfg;*.conf;*.config;*.env;*.properties;*.csv;*.tsv;*.sql;*.sh;"
      L"*.py;*.js;*.mjs;*.cjs;*.ts;*.tsx;*.jsx;*.c;*.cpp;*.cc;*.h;*.hpp;*.cs;*.java;*.go;*.rs;*.php;*.rb;*.lua;*.html;*.htm;*.css;*.scss\0"
      L"Файлы Блокнота (*.txt;*.inf;*.ini;*.log;*.ps1;*.psd1;*.psm1;*.scp;*.wtx;*.ms-notepad)\0"
      L"*.txt;*.inf;*.ini;*.log;*.ps1;*.psd1;*.psm1;*.scp;*.wtx;*.ms-notepad\0"
      L"Скрипты, JSON и код (*.json;*.bat;*.cmd;*.ps1;*.py;*.js;*.ts;*.cpp;*.cs;*.html;*.css)\0"
      L"*.json;*.jsonc;*.bat;*.cmd;*.reg;*.ps1;*.py;*.js;*.ts;*.c;*.cpp;*.h;*.cs;*.go;*.rs;*.java;*.php;*.sh;*.sql;*.xml;*.yaml;*.yml;*.toml;*.html;*.css\0"
      L"Все файлы (*.*)\0*.*\0\0";

  const wchar_t *filterEn =
      L"All Supported Text, Config & Code Files\0"
      L"*.txt;*.inf;*.ini;*.log;*.ps1;*.psd1;*.psm1;*.scp;*.wtx;*.ms-notepad;*.json;*.jsonc;*.bat;*.cmd;*.reg;*.vbs;"
      L"*.md;*.markdown;*.xml;*.yaml;*.yml;*.toml;*.cfg;*.conf;*.config;*.env;*.properties;*.csv;*.tsv;*.sql;*.sh;"
      L"*.py;*.js;*.mjs;*.cjs;*.ts;*.tsx;*.jsx;*.c;*.cpp;*.cc;*.h;*.hpp;*.cs;*.java;*.go;*.rs;*.php;*.rb;*.lua;*.html;*.htm;*.css;*.scss\0"
      L"Notepad Files (*.txt;*.inf;*.ini;*.log;*.ps1;*.psd1;*.psm1;*.scp;*.wtx;*.ms-notepad)\0"
      L"*.txt;*.inf;*.ini;*.log;*.ps1;*.psd1;*.psm1;*.scp;*.wtx;*.ms-notepad\0"
      L"Scripts, JSON & Code (*.json;*.bat;*.cmd;*.ps1;*.py;*.js;*.ts;*.cpp;*.cs;*.html;*.css)\0"
      L"*.json;*.jsonc;*.bat;*.cmd;*.reg;*.ps1;*.py;*.js;*.ts;*.c;*.cpp;*.h;*.cs;*.go;*.rs;*.java;*.php;*.sh;*.sql;*.xml;*.yaml;*.yml;*.toml;*.html;*.css\0"
      L"All Files (*.*)\0*.*\0\0";

  OPENFILENAMEW ofn{};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = owner;
  ofn.lpstrFilter = (lang == "en") ? filterEn : filterRu;
  ofn.lpstrFile = fileBuf.data();
  ofn.nMaxFile = static_cast<DWORD>(fileBuf.size());
  ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY |
              OFN_ALLOWMULTISELECT | OFN_EXPLORER | OFN_NOCHANGEDIR;

  if (!GetOpenFileNameW(&ofn)) return "[]";

  std::vector<std::wstring> selectedPaths;
  const wchar_t *p = fileBuf.data();
  std::wstring first = p;
  p += first.size() + 1;
  if (*p == L'\0') {
    selectedPaths.push_back(first);
  } else {
    while (*p != L'\0') {
      std::wstring name = p;
      wchar_t combined[MAX_PATH * 2] = {0};
      PathCombineW(combined, first.c_str(), name.c_str());
      selectedPaths.push_back(combined);
      p += name.size() + 1;
    }
  }

  std::string arr = "[";
  bool any = false;
  for (const auto &sp : selectedPaths) {
    bool ok = false;
    std::string js = buildDiskFileJson(sp, ok);
    if (ok) {
      if (any) arr.push_back(',');
      arr += js;
      any = true;
    }
  }
  arr.push_back(']');
  return arr;
}

/* Native Win32 Save As Dialog */
std::string showNativeSaveAsDialog(HWND owner, const std::string &suggestedName,
                                   const std::string &content, const std::string &encoding,
                                   const std::string &lang) {
  std::vector<wchar_t> fileBuf(4096, L'\0');
  std::wstring wSuggested = utf8ToWide(suggestedName);
  if (wSuggested.size() < fileBuf.size() - 1) {
    std::memcpy(fileBuf.data(), wSuggested.data(), wSuggested.size() * sizeof(wchar_t));
  }

  const wchar_t *filterRu =
      L"Текстовый документ (*.txt)\0*.txt\0"
      L"Markdown (*.md)\0*.md\0"
      L"Конфигурация / Лог (*.ini;*.inf;*.log;*.scp;*.wtx)\0*.ini;*.inf;*.log;*.scp;*.wtx\0"
      L"JSON (*.json)\0*.json\0"
      L"PowerShell / Batch (*.ps1;*.psd1;*.psm1;*.bat;*.cmd)\0*.ps1;*.psd1;*.psm1;*.bat;*.cmd\0"
      L"Все файлы (*.*)\0*.*\0\0";

  const wchar_t *filterEn =
      L"Text Document (*.txt)\0*.txt\0"
      L"Markdown (*.md)\0*.md\0"
      L"Config / Log (*.ini;*.inf;*.log;*.scp;*.wtx)\0*.ini;*.inf;*.log;*.scp;*.wtx\0"
      L"JSON (*.json)\0*.json\0"
      L"PowerShell / Batch (*.ps1;*.psd1;*.psm1;*.bat;*.cmd)\0*.ps1;*.psd1;*.psm1;*.bat;*.cmd\0"
      L"All Files (*.*)\0*.*\0\0";

  std::wstring ext = extractFileExt(wSuggested);
  DWORD filterIdx = 6; /* Default to All Files (*.*) if custom extension already present */
  if (ext.empty() || ext == L".txt") filterIdx = 1;
  else if (ext == L".md" || ext == L".markdown") filterIdx = 2;
  else if (ext == L".ini" || ext == L".inf" || ext == L".log" || ext == L".scp" || ext == L".wtx") filterIdx = 3;
  else if (ext == L".json") filterIdx = 4;
  else if (ext == L".ps1" || ext == L".psd1" || ext == L".psm1" || ext == L".bat" || ext == L".cmd") filterIdx = 5;

  OPENFILENAMEW ofn{};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = owner;
  ofn.lpstrFilter = (lang == "en") ? filterEn : filterRu;
  ofn.nFilterIndex = filterIdx;
  ofn.lpstrFile = fileBuf.data();
  ofn.nMaxFile = static_cast<DWORD>(fileBuf.size());
  ofn.lpstrDefExt = L"txt";
  ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY | OFN_EXPLORER | OFN_NOCHANGEDIR;

  if (!GetSaveFileNameW(&ofn)) return "{\"ok\":false,\"cancelled\":true}";

  std::wstring chosenPath = normalizeFullPath(fileBuf.data());
  std::string enc = encoding.empty() ? "UTF-8" : encoding;
  bool ok = writeDiskTextFile(chosenPath, content, enc);
  if (!ok) return "{\"ok\":false}";

  return std::string("{\"ok\":true,") +
         "\"path\":" + jsonEscape(wideToUtf8(chosenPath)) + "," +
         "\"name\":" + jsonEscape(wideToUtf8(extractFileName(chosenPath))) + "," +
         "\"ext\":" + jsonEscape(wideToUtf8(extractFileExt(chosenPath))) + "," +
         "\"encoding\":" + jsonEscape(enc) + "}";
}

/* Loopback HTTP server */
class LoopbackServer {
public:
  bool start() {
    WSADATA wsa{};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;

    m_listenSock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (m_listenSock == INVALID_SOCKET) return false;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;

    if (bind(m_listenSock, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == SOCKET_ERROR) {
      closesocket(m_listenSock);
      m_listenSock = INVALID_SOCKET;
      return false;
    }

    int len = sizeof(addr);
    if (getsockname(m_listenSock, reinterpret_cast<sockaddr *>(&addr), &len) == SOCKET_ERROR) {
      closesocket(m_listenSock);
      m_listenSock = INVALID_SOCKET;
      return false;
    }
    m_port = ntohs(addr.sin_port);

    if (listen(m_listenSock, SOMAXCONN) == SOCKET_ERROR) {
      closesocket(m_listenSock);
      m_listenSock = INVALID_SOCKET;
      return false;
    }

    m_running = true;
    m_thread = std::thread([this]() { acceptLoop(); });
    return true;
  }

  void stop() {
    m_running = false;
    if (m_listenSock != INVALID_SOCKET) {
      closesocket(m_listenSock);
      m_listenSock = INVALID_SOCKET;
    }
    if (m_thread.joinable()) m_thread.join();
    WSACleanup();
  }

  unsigned short port() const { return m_port; }

private:
  SOCKET m_listenSock = INVALID_SOCKET;
  unsigned short m_port = 0;
  std::atomic<bool> m_running{false};
  std::thread m_thread;

  static void sendAll(SOCKET s, const char *data, size_t total) {
    size_t sent = 0;
    while (sent < total) {
      int n = send(s, data + sent, static_cast<int>(total - sent), 0);
      if (n <= 0) break;
      sent += static_cast<size_t>(n);
    }
  }

  static void handleClient(SOCKET client) {
    DWORD timeoutMs = 4000;
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&timeoutMs), sizeof(timeoutMs));

    std::string req;
    req.reserve(8192);
    char buf[4096];
    size_t headerEnd = std::string::npos;

    while (headerEnd == std::string::npos && req.size() < 65536) {
      int n = recv(client, buf, sizeof(buf), 0);
      if (n <= 0) break;
      req.append(buf, static_cast<size_t>(n));
      headerEnd = req.find("\r\n\r\n");
    }

    if (headerEnd == std::string::npos) {
      closesocket(client);
      return;
    }

    std::string headers = req.substr(0, headerEnd);
    size_t contentLen = 0;
    size_t clPos = headers.find("Content-Length:");
    if (clPos == std::string::npos) clPos = headers.find("content-length:");
    if (clPos != std::string::npos) {
      contentLen = static_cast<size_t>(std::strtoul(headers.c_str() + clPos + 15, nullptr, 10));
    }

    size_t bodyStart = headerEnd + 4;
    while (req.size() - bodyStart < contentLen && contentLen < 32 * 1024 * 1024) {
      int n = recv(client, buf, sizeof(buf), 0);
      if (n <= 0) break;
      req.append(buf, static_cast<size_t>(n));
    }

    bool isGetStorage = headers.rfind("GET /api/storage", 0) == 0;
    bool isPostStorage = headers.rfind("POST /api/storage", 0) == 0;
    bool isGetOsUiLang = headers.rfind("GET /api/os-ui-lang", 0) == 0;
    bool isGetPendingFiles = headers.rfind("GET /api/pending-files", 0) == 0;
    bool isPostSaveDirect = headers.rfind("POST /api/save-direct", 0) == 0;
    bool isGetNetSearch = headers.rfind("GET /api/net-search", 0) == 0;
    bool isGetNetImage = headers.rfind("GET /api/net-image", 0) == 0;

    if (isGetNetSearch) {
      std::string fullPath = extractRequestPathAndQuery(headers);
      std::string q = extractQueryParam(fullPath, "q");
      std::string mode = extractQueryParam(fullPath, "mode");
      if (q.empty()) q = "Sonic the Hedgehog";
      std::string apiUrl = (mode == "any")
          ? ("https://wallhaven.cc/api/v1/search?q=" + urlEncodeUtf8(q) +
             "&purity=100&sorting=relevance")
          : ("https://wallhaven.cc/api/v1/search?q=" + urlEncodeUtf8(q) +
             "&purity=100&atleast=1920x1080&ratios=16x9,16x10&sorting=favorites");
      std::string body, ct;
      if (fetchUrlWinInet(apiUrl, body, ct, 4 * 1024 * 1024)) {
        std::string resp =
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Cache-Control: no-store\r\n"
            "Connection: close\r\n"
            "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n";
        sendAll(client, resp.data(), resp.size());
        sendAll(client, body.data(), body.size());
      } else {
        std::string errJson = "{\"data\":[]}";
        std::string resp =
            "HTTP/1.1 502 Bad Gateway\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: close\r\n"
            "Content-Length: " + std::to_string(errJson.size()) + "\r\n\r\n" + errJson;
        sendAll(client, resp.data(), resp.size());
      }
    } else if (isGetNetImage) {
      std::string fullPath = extractRequestPathAndQuery(headers);
      std::string targetUrl = extractQueryParam(fullPath, "url");
      std::string body, ct;
      if (!targetUrl.empty() && fetchUrlWinInet(targetUrl, body, ct, 16 * 1024 * 1024)) {
        std::string resp =
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: " + ct + "\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Cache-Control: max-age=3600\r\n"
            "Connection: close\r\n"
            "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n";
        sendAll(client, resp.data(), resp.size());
        sendAll(client, body.data(), body.size());
      } else {
        std::string msg = "Failed to fetch URL";
        std::string resp =
            "HTTP/1.1 502 Bad Gateway\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: close\r\n"
            "Content-Length: " + std::to_string(msg.size()) + "\r\n\r\n" + msg;
        sendAll(client, resp.data(), resp.size());
      }
    } else if (isGetOsUiLang) {
      std::string langJson = "{\"lang\":" + jsonEscape(detectWindowsDisplayLanguage()) + "}";
      std::string resp =
          "HTTP/1.1 200 OK\r\n"
          "Content-Type: application/json; charset=utf-8\r\n"
          "Cache-Control: no-store\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(langJson.size()) + "\r\n\r\n" + langJson;
      sendAll(client, resp.data(), resp.size());
    } else if (isGetStorage) {
      std::string data = loadPortableJson();
      if (data.empty()) data = "{}";
      std::string resp =
          "HTTP/1.1 200 OK\r\n"
          "Content-Type: application/json; charset=utf-8\r\n"
          "Cache-Control: no-store\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(data.size()) + "\r\n\r\n";
      sendAll(client, resp.data(), resp.size());
      sendAll(client, data.data(), data.size());
    } else if (isPostStorage) {
      std::string body = req.substr(bodyStart, contentLen);
      bool ok = savePortableJson(body);
      std::string jsonResp = ok ? "{\"ok\":true}" : "{\"ok\":false}";
      std::string resp =
          "HTTP/1.1 200 OK\r\n"
          "Content-Type: application/json; charset=utf-8\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(jsonResp.size()) + "\r\n\r\n" + jsonResp;
      sendAll(client, resp.data(), resp.size());
    } else if (isGetPendingFiles) {
      std::string arr = drainPendingFilesJson();
      std::string resp =
          "HTTP/1.1 200 OK\r\n"
          "Content-Type: application/json; charset=utf-8\r\n"
          "Cache-Control: no-store\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(arr.size()) + "\r\n\r\n" + arr;
      sendAll(client, resp.data(), resp.size());
    } else if (isPostSaveDirect) {
      std::string body = req.substr(bodyStart, contentLen);
      std::string pathStr = webview::detail::json_parse(body, "path", 0);
      std::string contentStr = webview::detail::json_parse(body, "content", 0);
      std::string encStr = webview::detail::json_parse(body, "encoding", 0);
      bool ok = writeDiskTextFile(utf8ToWide(pathStr), contentStr, encStr.empty() ? "UTF-8" : encStr);
      std::string jsonResp = ok ? "{\"ok\":true}" : "{\"ok\":false}";
      std::string resp =
          "HTTP/1.1 200 OK\r\n"
          "Content-Type: application/json; charset=utf-8\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(jsonResp.size()) + "\r\n\r\n" + jsonResp;
      sendAll(client, resp.data(), resp.size());
    } else {
      const char *htmlPtr = reinterpret_cast<const char *>(EMBEDDED_APP_HTML);
      size_t htmlLen = EMBEDDED_APP_HTML_LEN;
      std::string resp =
          "HTTP/1.1 200 OK\r\n"
          "Content-Type: text/html; charset=utf-8\r\n"
          "Cache-Control: no-store\r\n"
          "Connection: close\r\n"
          "Content-Length: " + std::to_string(htmlLen) + "\r\n\r\n";
      sendAll(client, resp.data(), resp.size());
      sendAll(client, htmlPtr, htmlLen);
    }

    closesocket(client);
  }

  void acceptLoop() {
    while (m_running) {
      SOCKET client = accept(m_listenSock, nullptr, nullptr);
      if (client == INVALID_SOCKET) break;
      std::thread(&LoopbackServer::handleClient, client).detach();
    }
  }
};

} // namespace

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  initPortablePaths();

  /* Handle silent elevated registry helper switches inside the .exe itself (zero .bat files) */
  {
    std::wstring cmdLow = toLowerWide(GetCommandLineW() ? GetCommandLineW() : L"");
    if (cmdLow.find(L"--elevate-set-default") != std::wstring::npos) {
      return applyDefaultNotepadHklmElevated() ? 0 : 1;
    }
    if (cmdLow.find(L"--elevate-restore-default") != std::wstring::npos) {
      return restoreDefaultNotepadHklmElevated() ? 0 : 1;
    }
  }

  /* Automatically register Capabilities in HKCU so Graphite appears in Windows Default Apps */
  registerCapabilitiesInHkcu();

  bool forceDefaultBrowser = false;
  std::vector<std::wstring> cliFiles = parseCommandLineFiles(forceDefaultBrowser);

  /* If an instance of Graphite.exe is already running, forward CLI files to its tabs */
  if (!forceDefaultBrowser) {
    HWND existingIpc = FindWindowW(kIpcClassName, kIpcWindowTitle);
    if (existingIpc != nullptr) {
      DWORD_PTR ipcRes = 0;
      if (!cliFiles.empty()) {
        for (const auto &fp : cliFiles) {
          std::string utf8Path = wideToUtf8(fp);
          COPYDATASTRUCT cds{};
          cds.dwData = kIpcOpenFileTag;
          cds.cbData = static_cast<DWORD>(utf8Path.size() + 1);
          cds.lpData = const_cast<char *>(utf8Path.c_str());
          SendMessageTimeoutW(existingIpc, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds),
                              SMTO_ABORTIFHUNG, 1500, &ipcRes);
        }
      } else {
        COPYDATASTRUCT cds{};
        cds.dwData = kIpcFocusTag;
        SendMessageTimeoutW(existingIpc, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds),
                            SMTO_ABORTIFHUNG, 1500, &ipcRes);
      }
      return 0;
    }
  }

  for (const auto &fp : cliFiles) {
    enqueueFilePathForFrontend(fp);
  }

  HWND ipcWnd = createSingleInstanceIpcWindow();

  LoopbackServer server;
  if (!server.start()) {
    if (ipcWnd) DestroyWindow(ipcWnd);
    MessageBoxW(nullptr, L"Не удалось запустить локальный движок Graphite.", L"Graphite", MB_ICONERROR);
    return 1;
  }

  std::string url = "http://127.0.0.1:" + std::to_string(server.port()) + "/";
  std::wstring wurl = utf8ToWide(url);

  if (!forceDefaultBrowser) {
    try {
      webview::webview w(false, nullptr);
      w.set_title("Graphite");
      w.set_size(1160, 740, WEBVIEW_HINT_NONE);
      w.set_size(400, 380, WEBVIEW_HINT_MIN);

      HWND hwnd = nullptr;
      auto wndRes = w.window();
      if (wndRes.ok()) {
        hwnd = static_cast<HWND>(wndRes.value());
        g_mainAppHwnd = hwnd;
        applyNativeWindowStyle(hwnd, false, true);
        applyWindowAppIcon(hwnd, getSavedAppIconKey(), false);
      }

      g_notifyFrontendFiles = [&w]() {
        w.dispatch([&w]() {
          w.eval("if (typeof window.__gnPullPendingFiles === 'function') window.__gnPullPendingFiles();");
        });
      };

      g_requestCloseFrontend = [&w]() {
        w.dispatch([&w]() {
          w.eval("if (typeof window.__gnRequestAppClose === 'function') window.__gnRequestAppClose();");
        });
      };

      w.bind("__gnNativeSetDirty", [](const std::string &req) -> std::string {
        bool dirty = (req.find("1") != std::string::npos || req.find("true") != std::string::npos);
        g_hasUnsavedChanges.store(dirty);
        return "true";
      });

      w.bind("__gnNativeLoad", [](const std::string &) -> std::string {
        std::string data = loadPortableJson();
        return data.empty() ? "null" : data;
      });

      w.bind("__gnNativeSave", [](const std::string &req) -> std::string {
        if (req.size() > 2 && req.front() == '[' && req.back() == ']') {
          savePortableJson(req.substr(1, req.size() - 2));
        }
        return "true";
      });

      /* Pull CLI or single-instance IPC files to open in tabs */
      w.bind("__gnNativePullFiles", [](const std::string &) -> std::string {
        return drainPendingFilesJson();
      });

      /* Direct Ctrl+S save back to diskPath preserving encoding */
      w.bind("__gnNativeSaveDirect", [](const std::string &req) -> std::string {
        std::string pathStr = webview::detail::json_parse(req, "", 0);
        std::string contentStr = webview::detail::json_parse(req, "", 1);
        std::string encStr = webview::detail::json_parse(req, "", 2);
        bool ok = writeDiskTextFile(utf8ToWide(pathStr), contentStr, encStr.empty() ? "UTF-8" : encStr);
        return ok ? "{\"ok\":true}" : "{\"ok\":false}";
      });

      /* Native Win32 Open File Dialog (async via UI dispatch) */
      w.bind(
          "__gnNativeOpenDialog",
          [&w, hwnd](const std::string &id, const std::string &req, void *) {
            std::string lang = webview::detail::json_parse(req, "", 0);
            w.dispatch([&w, hwnd, id, lang]() {
              std::string res = showNativeOpenFileDialog(hwnd, lang);
              w.resolve(id, 0, res);
            });
          },
          nullptr);

      /* Native Win32 Save As Dialog (async via UI dispatch) */
      w.bind(
          "__gnNativeSaveAsDialog",
          [&w, hwnd](const std::string &id, const std::string &req, void *) {
            std::string suggestedName = webview::detail::json_parse(req, "", 0);
            std::string content = webview::detail::json_parse(req, "", 1);
            std::string enc = webview::detail::json_parse(req, "", 2);
            std::string lang = webview::detail::json_parse(req, "", 3);
            w.dispatch([&w, hwnd, id, suggestedName, content, enc, lang]() {
              std::string res = showNativeSaveAsDialog(hwnd, suggestedName, content, enc, lang);
              w.resolve(id, 0, res);
            });
          },
          nullptr);

      /* Native Default Windows Notepad replacement (100% pure Win32 C++, zero .bat scripts) */
      w.bind(
          "__gnNativeNotepadAssoc",
          [&w](const std::string &id, const std::string &req, void *) {
            std::string action = webview::detail::json_parse(req, "", 0);
            if (action == "set") {
              w.dispatch([&w, id]() {
                setGraphiteAsDefaultNotepad(true);
                bool active = isGraphiteDefaultNotepad();
                w.resolve(id, 0, active ? "{\"ok\":true,\"isDefault\":true}" : "{\"ok\":true,\"isDefault\":false}");
              });
              return;
            }
            if (action == "restore") {
              w.dispatch([&w, id]() {
                restoreWindowsNotepadDefault();
                bool active = isGraphiteDefaultNotepad();
                w.resolve(id, 0, active ? "{\"ok\":true,\"isDefault\":true}" : "{\"ok\":true,\"isDefault\":false}");
              });
              return;
            }
            bool active = isGraphiteDefaultNotepad();
            w.resolve(id, 0, active ? "{\"isDefault\":true}" : "{\"isDefault\":false}");
          },
          nullptr);

      /* Sync Dark/Light backdrop */
      w.bind("__gnNativeSetWindowStyle", [hwnd](const std::string &req) -> std::string {
        bool isDark = req.find("dark") != std::string::npos;
        applyNativeWindowStyle(hwnd, false, isDark);
        return "true";
      });

      /* Live Windows Taskbar + Alt-Tab + File Association Icon Switcher */
      w.bind(
          "__gnNativeSetAppIcon",
          [&w, hwnd](const std::string &id, const std::string &req, void *) {
            std::string iconKey = webview::detail::json_parse(req, "", 0);
            if (iconKey.empty()) iconKey = "blue";
            w.dispatch([&w, hwnd, id, iconKey]() {
              applyWindowAppIcon(hwnd, iconKey, true);
              w.resolve(id, 0, "{\"ok\":true}");
            });
          },
          nullptr);

      /* Create / Update Desktop Shortcut (Graphite.lnk) with selected icon */
      w.bind(
          "__gnNativeCreateShortcut",
          [&w](const std::string &id, const std::string &req, void *) {
            std::string iconKey = webview::detail::json_parse(req, "", 0);
            if (iconKey.empty()) iconKey = "blue";
            w.dispatch([&w, id, iconKey]() {
              bool ok = createOrUpdateDesktopShortcut(iconKey, false);
              w.resolve(id, 0, ok ? "{\"ok\":true}" : "{\"ok\":false}");
            });
          },
          nullptr);

      /* Custom frameless titlebar actions (smooth direct drag — no Win11 Snap Bar popup!) */
      w.bind("__gnWinCmd", [hwnd](const std::string &req) -> std::string {
        if (!hwnd) return "false";
        if (req.find("drag") != std::string::npos) {
          startSmoothWindowDrag(hwnd);
        } else if (req.find("min") != std::string::npos) {
          ShowWindow(hwnd, SW_MINIMIZE);
        } else if (req.find("toggleMax") != std::string::npos) {
          stopSmoothWindowDrag(hwnd);
          ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
        } else if (req.find("forceClose") != std::string::npos) {
          g_forceCloseWindow.store(true);
          stopSmoothWindowDrag(hwnd);
          PostMessageW(hwnd, WM_CLOSE, 0, 0);
        } else if (req.find("close") != std::string::npos) {
          stopSmoothWindowDrag(hwnd);
          PostMessageW(hwnd, WM_CLOSE, 0, 0);
        } else if (req.find("isMax") != std::string::npos) {
          return IsZoomed(hwnd) ? "true" : "false";
        }
        return "true";
      });

      /* 8-direction native OS resize borders for frameless window */
      w.bind("__gnWinResize", [hwnd](const std::string &req) -> std::string {
        if (!hwnd || IsZoomed(hwnd)) return "false";
        WPARAM ht = 0;
        if (req.find("\"nw\"") != std::string::npos) ht = HTTOPLEFT;
        else if (req.find("\"ne\"") != std::string::npos) ht = HTTOPRIGHT;
        else if (req.find("\"sw\"") != std::string::npos) ht = HTBOTTOMLEFT;
        else if (req.find("\"se\"") != std::string::npos) ht = HTBOTTOMRIGHT;
        else if (req.find("\"n\"") != std::string::npos) ht = HTTOP;
        else if (req.find("\"s\"") != std::string::npos) ht = HTBOTTOM;
        else if (req.find("\"w\"") != std::string::npos) ht = HTLEFT;
        else if (req.find("\"e\"") != std::string::npos) ht = HTRIGHT;
        if (ht != 0) {
          POINT pt{};
          GetCursorPos(&pt);
          ReleaseCapture();
          PostMessageW(hwnd, WM_NCLBUTTONDOWN, ht, MAKELPARAM(pt.x, pt.y));
        }
        return "true";
      });

      /* Open external URL or full app in User's Default Browser (never forces Edge!) */
      w.bind("__gnOpenExternal", [wurl](const std::string &req) -> std::string {
        std::string target = webview::detail::json_parse(req, "", 0);
        if (target == "__APP__") {
          openUrlInUsersDefaultBrowser(wurl, true);
        } else if (!target.empty()) {
          openUrlInUsersDefaultBrowser(utf8ToWide(target), false);
        }
        return "true";
      });

      std::string winUiLang = detectWindowsDisplayLanguage();
      w.init("window.__GN_WIN_UI_LANG = \"" + winUiLang + "\";");

      w.navigate(url);
      w.run();

      g_notifyFrontendFiles = nullptr;
      g_requestCloseFrontend = nullptr;
      g_mainAppHwnd = nullptr;
      if (ipcWnd) DestroyWindow(ipcWnd);
      server.stop();
      return 0;
    } catch (...) {
      g_notifyFrontendFiles = nullptr;
      g_requestCloseFrontend = nullptr;
      g_mainAppHwnd = nullptr;
      /* Fall through to user's Default Browser */
    }
  }

  if (ipcWnd) DestroyWindow(ipcWnd);

  /* Launch in User's Default Browser (Chrome, Yandex, Firefox, Brave, Opera, etc.) */
  openUrlInUsersDefaultBrowser(wurl, true);
  MessageBoxW(
      nullptr,
      L"Graphite открыт в вашем браузере по умолчанию (автосохранение в PortableData активно).\n"
      L"Нажмите ОК после завершения работы, чтобы закрыть фоновое сохранение.",
      L"Graphite",
      MB_OK | MB_ICONINFORMATION);

  server.stop();
  return 0;
}
