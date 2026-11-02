/* ==========================================================================
   Graphite — Clean Native Desktop Logic
   ========================================================================== */

(function () {
  "use strict";

  var STORAGE_KEY = "graphite_portable_v2";
  var memoryStore = null;
  var linkedFileHandle = null;
  var serverSyncAvailable = false;
  var isNativeExe = typeof window.__gnNativeLoad === "function";
  var saveTimer = null;
  var contextTargetNoteId = null;

  /* -------------------- Safe Storage -------------------- */
  function safeLocalGet() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return memoryStore;
    }
  }

  function safeLocalSet(data) {
    memoryStore = data;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  /* -------------------- System UI Language Detection (Ignores Region) -------------------- */
  function normalizePrimaryLangCode(rawTag) {
    if (!rawTag || typeof rawTag !== "string") return "";
    /* Extract ONLY the primary ISO-639 language subtag before '-' or '_',
       strictly ignoring any OS/browser country or region subtag (e.g. 'en-RU' -> 'en', 'ru-US' -> 'ru'). */
    return rawTag.trim().split(/[-_]/)[0].toLowerCase();
  }

  function detectSystemUiLanguage() {
    var dicts = window.GRAPHITE_I18N || {};
    if (typeof window.__GN_WIN_UI_LANG === "string" && window.__GN_WIN_UI_LANG.trim()) {
      var winCode = normalizePrimaryLangCode(window.__GN_WIN_UI_LANG);
      if (winCode && dicts[winCode]) return winCode;
    }
    var navList = [];
    if (typeof navigator !== "undefined") {
      if (Array.isArray(navigator.languages) && navigator.languages.length) {
        navList = navigator.languages.slice();
      } else if (navigator.language) {
        navList = [navigator.language];
      }
    }
    for (var i = 0; i < navList.length; i++) {
      var code = normalizePrimaryLangCode(navList[i]);
      if (code && dicts[code]) return code;
    }
    return dicts.en ? "en" : "ru";
  }

  /* -------------------- Default State -------------------- */
  function createDefaultState() {
    var lang = detectSystemUiLanguage();
    var starter = window.GRAPHITE_STARTER_NOTES(lang);
    return {
      version: 2,
      settings: {
        langMode: "auto",     // "auto" (Windows Display Language, ignoring Region) | "manual"
        lang: lang,
        material: "blur",     // "blur" | "solid"
        themeMode: "dark",    // "light" | "dark" | "auto"
        accent: "sapphire",
        customAccent: "#3b82f6",
        appIcon: "bw",
        blurPx: 22,
        glassOpacity: 48,
        scene: "web_galaxy",
        lastNormalScene: "web_galaxy",
        wallpaperDataUrl: "",
        wallpaperAnimated: true,
        importedThemes: [],
        customThemeFolders: [],
        customFonts: [],
        fontFamily: "sans",
        fontSize: 15,
        viewLayout: "full",
        wideMode: false,
        sidebarCollapsed: false,
        showFolders: true,
        lineNumbers: true,
        wordWrap: true,
        mdPreview: false,
        fleetwayThemesEnabled: false,
        easterEggsEnabled: false,
        floweyUnlocked: false
      },
      folders: [
        { id: "work", name: "", builtinKey: "work" },
        { id: "personal", name: "", builtinKey: "personal" }
      ],
      notes: starter,
      openTabs: starter.map(function (n) { return n.id; }),
      activeNoteId: starter[0].id,
      activeFilter: "all"
    };
  }

  var state = createDefaultState();

  /* -------------------- Localization & Helpers -------------------- */
  function t(key) {
    var lang = (state.settings && state.settings.lang) || "ru";
    var dict = window.GRAPHITE_I18N[lang] || window.GRAPHITE_I18N.ru;
    if (dict && dict[key] !== undefined) return dict[key];
    var fb = window.GRAPHITE_I18N.en || window.GRAPHITE_I18N.ru;
    return (fb && fb[key] !== undefined) ? fb[key] : key;
  }

  function getFolderDisplayName(folder) {
    if (folder.builtinKey && !folder.name) {
      var lang = state.settings.lang || "ru";
      var dict = window.GRAPHITE_I18N[lang] || window.GRAPHITE_I18N.ru;
      var defs = dict && dict.defaultFolders;
      return (defs && defs[folder.builtinKey]) || folder.id;
    }
    return folder.name || folder.id;
  }

  function uid(prefix) {
    return (prefix || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hexToRgbString(hex) {
    var clean = String(hex || "#3b82f6").replace("#", "");
    if (clean.length === 3) clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
    var num = parseInt(clean, 16);
    if (isNaN(num)) return "59, 130, 246";
    return ((num >> 16) & 255) + ", " + ((num >> 8) & 255) + ", " + (num & 255);
  }

  function formatShortDate(ts) {
    if (!ts) return "";
    if (Date.now() - ts < 45000) return t("justNow");
    try {
      var d = new Date(ts);
      var now = new Date();
      var loc = state.settings.lang === "en" ? "en-US" : "ru-RU";
      if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleDateString(loc, { day: "2-digit", month: "short" });
    } catch (e) {
      return "";
    }
  }

  function showToast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.classList.remove("show");
    }, 1800);
  }

  /* -------------------- HTML <-> Markdown / Plain -------------------- */
  function htmlToMarkdown(html) {
    if (!html) return "";
    var tmp = document.createElement("div");
    tmp.innerHTML = html;

    function walk(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return "";
      var tag = node.tagName.toUpperCase();

      if (node.classList && node.classList.contains("todo-row")) {
        var checked = node.getAttribute("data-checked") === "true";
        var txtNode = node.querySelector(".todo-text");
        var txt = txtNode ? txtNode.innerText.trim() : node.innerText.trim();
        return "- [" + (checked ? "x" : " ") + "] " + txt + "\n";
      }

      var inner = "";
      for (var i = 0; i < node.childNodes.length; i++) inner += walk(node.childNodes[i]);

      switch (tag) {
        case "H1": return "# " + inner.trim() + "\n\n";
        case "H2": return "## " + inner.trim() + "\n\n";
        case "H3": return "### " + inner.trim() + "\n\n";
        case "P":
        case "DIV": return inner.trim() ? inner + (inner.endsWith("\n") ? "" : "\n\n") : "\n";
        case "BR": return "\n";
        case "B":
        case "STRONG": return "**" + inner + "**";
        case "I":
        case "EM": return "*" + inner + "*";
        case "S":
        case "STRIKE":
        case "DEL": return "~~" + inner + "~~";
        case "CODE":
          if (node.parentElement && node.parentElement.tagName.toUpperCase() === "PRE") return inner;
          return "`" + inner + "`";
        case "PRE": return "```\n" + node.innerText.replace(/\n+$/, "") + "\n```\n\n";
        case "BLOCKQUOTE":
          return inner.trim().split("\n").map(function (l) { return "> " + l; }).join("\n") + "\n\n";
        case "LI":
          var pTag = node.parentElement ? node.parentElement.tagName.toUpperCase() : "UL";
          if (pTag === "OL") {
            var idx = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
            return idx + ". " + inner.trim() + "\n";
          }
          return "- " + inner.trim() + "\n";
        case "UL":
        case "OL": return inner + "\n";
        case "HR": return "---\n\n";
        default: return inner;
      }
    }

    return walk(tmp).replace(/\n{3,}/g, "\n\n").trim();
  }

  function renderInlineMd(escapedLine) {
    return escapedLine
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function markdownToHtml(md) {
    if (!md) return "";
    var lines = String(md).replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var inCode = false;
    var codeBuf = [];
    var inUl = false;
    var inOl = false;

    function closeLists() {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (raw.trim().indexOf("```") === 0) {
        closeLists();
        if (!inCode) { inCode = true; codeBuf = []; }
        else { out.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>"); inCode = false; }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }

      var trimmed = raw.trim();
      if (!trimmed) { closeLists(); continue; }
      if (/^---+$/.test(trimmed)) { closeLists(); out.push("<hr>"); continue; }

      var mCheck = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (mCheck) {
        closeLists();
        var done = mCheck[1].toLowerCase() === "x";
        out.push(
          '<div class="todo-row" data-checked="' + (done ? "true" : "false") + '">' +
          '<span class="todo-box" contenteditable="false"></span>' +
          '<div class="todo-text">' + renderInlineMd(escapeHtml(mCheck[2])) + "</div></div>"
        );
        continue;
      }

      var mH = raw.match(/^(#{1,3})\s+(.*)$/);
      if (mH) {
        closeLists();
        var lvl = mH[1].length;
        out.push("<h" + lvl + ">" + renderInlineMd(escapeHtml(mH[2])) + "</h" + lvl + ">");
        continue;
      }

      if (raw.indexOf("> ") === 0) {
        closeLists();
        out.push("<blockquote>" + renderInlineMd(escapeHtml(raw.slice(2))) + "</blockquote>");
        continue;
      }

      var mUl = raw.match(/^\s*[-*+]\s+(.*)$/);
      if (mUl) {
        if (inOl) { out.push("</ol>"); inOl = false; }
        if (!inUl) { out.push("<ul>"); inUl = true; }
        out.push("<li>" + renderInlineMd(escapeHtml(mUl[1])) + "</li>");
        continue;
      }

      var mOl = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (mOl) {
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (!inOl) { out.push("<ol>"); inOl = true; }
        out.push("<li>" + renderInlineMd(escapeHtml(mOl[1])) + "</li>");
        continue;
      }

      closeLists();
      out.push("<p>" + renderInlineMd(escapeHtml(raw)) + "</p>");
    }

    if (inCode) out.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
    closeLists();
    return out.join("");
  }

  function getNotePlainText(note) {
    if (!note) return "";
    if (note.mode === "txt") return note.plain || "";
    var tmp = document.createElement("div");
    tmp.innerHTML = note.html || "";
    return tmp.innerText || tmp.textContent || "";
  }

  /* -------------------- Portable Sync -------------------- */
  function updatePortableStatusLabel() {
    var statusEl = document.getElementById("portableStatusText");
    if (!statusEl) return;
    var n = typeof getActiveNote === "function" ? getActiveNote() : null;
    if (n && n.diskPath) {
      var shortDisk = String(n.diskPath).split(/[\\/]/).pop() || n.diskPath;
      statusEl.textContent = shortDisk;
      statusEl.title = n.diskPath;
    } else {
      statusEl.title = "";
      if (isNativeExe) statusEl.textContent = t("statusPortableExe");
      else if (linkedFileHandle) statusEl.textContent = t("statusPortableLinked");
      else statusEl.textContent = t("statusSaved");
    }
  }

  function scheduleSave() {
    safeLocalSet(state);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPortableSave, 260);
  }

  function flushPortableSave() {
    var payload = JSON.stringify(state, null, 2);

    if (isNativeExe && typeof window.__gnNativeSave === "function") {
      try { window.__gnNativeSave(state); } catch (e) {}
    } else if (serverSyncAvailable) {
      try {
        fetch("/api/storage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload
        }).catch(function () {});
      } catch (e) {}
    }

    if (linkedFileHandle && linkedFileHandle.createWritable) {
      linkedFileHandle.createWritable().then(function (w) {
        return w.write(payload).then(function () { return w.close(); });
      }).catch(function () {});
    }
  }

  var LEGACY_SCENE_MAP = {
    "default": "web_galaxy",
    "neutral": "web_alps",
    "sky": "web_ocean",
    "warm": "web_sakura",
    "forest": "web_alps",
    "space_nebula": "web_galaxy",
    "space_planet": "web_galaxy",
    "nature_forest": "web_alps",
    "nature_aurora": "web_aurora",
    "nature_sunset": "web_sakura",
    "nature_ocean": "web_ocean",
    "nature_dawn": "web_alps",
    "dr_kris": "dr_photo_kris",
    "dr_susie": "dr_photo_susie",
    "dr_ralsei": "dr_photo_ralsei",
    "dr_noelle": "dr_photo_noelle",
    "dr_spamton": "dr_photo_spamton",
    "dr_jevil": "dr_photo_jevil",
    "dr_queen": "dr_photo_queen",
    "dr5_tenna": "dr5_flowery",
    "dr5_kingdom": "dr5_flowery",
    "dr5_flowery_ralsei": "dr5_flowery",
    "rk_slash": "dr5_knight",
    "rk_crimson": "dr5_knight",
    "rk_stance": "dr5_knight",
    "ut_wings": "dr5_asgore",
    "dr5_bouquet": "dr5_seven_flowers",
    "dr5_seth_aqua": "dr5_seth",
    "win_screen": "web_galaxy"
  };

  var VALID_SCENES = {
    "flowey_garden": 1,
    "dr5_flowery": 1,
    "dr5_seven_flowers": 1,
    "dr5_pink": 1,
    "dr5_aqua": 1,
    "dr5_seth": 1,
    "dr5_knight": 1,
    "rk_fountain": 1,
    "dr5_asgore": 1,
    "dr5_noelle_ch5": 1,
    "gm_hornet": 1,
    "gm_v1": 1,
    "gm_omori": 1,
    "gm_niko": 1,
    "gm_cuphead": 1,
    "gm_joker": 1,
    "gm_2b": 1,
    "gm_madeline": 1,
    "gm_zagreus": 1,
    "gm_doom": 1,
    "gm_link": 1,
    "gm_geralt": 1,
    "gm_furina": 1,
    "gm_lucy": 1,
    "sn_sonic": 1,
    "sn_shadow": 1,
    "sn_tails": 1,
    "sn_knuckles": 1,
    "sn_silver": 1,
    "sn_amy": 1,
    "sn_metalsonic": 1,
    "sn_supersonic": 1,
    "sn_eggman": 1,
    "sn_darksonic": 1,
    "sn_forces": 1,
    "sn_shadowdark": 1,
    "dr_photo_kris": 1,
    "dr_photo_susie": 1,
    "dr_photo_ralsei": 1,
    "dr_photo_noelle": 1,
    "dr_photo_spamton": 1,
    "dr_photo_jevil": 1,
    "dr_photo_queen": 1,
    "dr_photo_cyber": 1,
    "ut_sans": 1,
    "ut_gaster_sans": 1,
    "ut_waterfall": 1,
    "web_galaxy": 1,
    "web_aurora": 1,
    "web_cyberpunk": 1,
    "web_sakura": 1,
    "web_ocean": 1,
    "web_alps": 1,
    "web_retro": 1,
    "web_hollow": 1
  };

  var VALID_THEME_MODES = {
    "light": 1,
    "dark": 1,
    "auto": 1,
    "flowey": 1
  };

  function getImportedThemeById(sceneId) {
    if (!sceneId || typeof sceneId !== "string" || sceneId.indexOf("imp_") !== 0) return null;
    var list = Array.isArray(state.settings.importedThemes) ? state.settings.importedThemes : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === sceneId) return list[i];
    }
    return null;
  }

  function hydrateState(loaded) {
    if (!loaded || typeof loaded !== "object" || !Array.isArray(loaded.notes)) return false;
    var def = createDefaultState();
    state.version = 2;
    state.settings = Object.assign({}, def.settings, loaded.settings || {});
    if (!Array.isArray(state.settings.importedThemes)) {
      state.settings.importedThemes = [];
    } else {
      state.settings.importedThemes = state.settings.importedThemes.filter(function (it) {
        return it && typeof it.id === "string" && typeof it.dataUrl === "string" && it.dataUrl.length > 0;
      });
    }
    if (!Array.isArray(state.settings.customThemeFolders)) {
      state.settings.customThemeFolders = [];
    }
    if (!Array.isArray(state.settings.customFonts)) {
      state.settings.customFonts = [];
    }
    if (state.settings.viewLayout !== "compact" && state.settings.viewLayout !== "full") {
      state.settings.viewLayout = "full";
    }
    if (state.settings.material !== "blur" && state.settings.material !== "solid") {
      state.settings.material = "blur";
    }
    var validIcons = { blue: 1, bw: 1, white: 1, purple: 1, yellow: 1, red: 1, green: 1, pink: 1 };
    if (!validIcons[state.settings.appIcon]) {
      state.settings.appIcon = "bw";
    }
    state.settings.langMode = (loaded.settings && loaded.settings.langMode === "manual") ? "manual" : "auto";
    if (state.settings.langMode !== "manual") {
      state.settings.lang = detectSystemUiLanguage();
    } else if (!state.settings.lang || !window.GRAPHITE_I18N || !window.GRAPHITE_I18N[state.settings.lang]) {
      state.settings.langMode = "auto";
      state.settings.lang = detectSystemUiLanguage();
    }
    state.settings.fleetwayThemesEnabled = Boolean(state.settings.fleetwayThemesEnabled);
    state.settings.easterEggsEnabled = Boolean(state.settings.easterEggsEnabled);
    if (!state.settings.easterEggsEnabled) {
      if (state.settings.themeMode === "flowey") {
        state.settings.themeMode = "dark";
      }
      if (state.settings.scene === "flowey_garden") {
        state.settings.scene = state.settings.lastNormalScene || "web_galaxy";
      }
    }
    if (!state.settings.fleetwayThemesEnabled && state.settings.scene !== "flowey_garden") {
      if (!getImportedThemeById(state.settings.scene) && getBuiltInCategoryForScene(state.settings.scene) !== "atmos") {
        state.settings.scene = "web_galaxy";
      }
    }
    if (typeof state.settings.themeMode === "string" && state.settings.themeMode.indexOf("dr_") === 0) {
      var mappedDr = LEGACY_SCENE_MAP[state.settings.themeMode];
      if (mappedDr) state.settings.scene = mappedDr;
      state.settings.themeMode = "dark";
    } else if (!VALID_THEME_MODES[state.settings.themeMode]) {
      state.settings.themeMode = "dark";
    }
    if (LEGACY_SCENE_MAP[state.settings.scene]) {
      state.settings.scene = LEGACY_SCENE_MAP[state.settings.scene];
    } else if (!VALID_SCENES[state.settings.scene] && !getImportedThemeById(state.settings.scene)) {
      state.settings.scene = "web_galaxy";
    }
    state.folders = Array.isArray(loaded.folders) ? loaded.folders : def.folders;
    state.notes = loaded.notes.length ? loaded.notes : def.notes;
    state.notes.forEach(function (n) { if (n) n.isDirty = false; });
    state.openTabs = Array.isArray(loaded.openTabs) && loaded.openTabs.length
      ? loaded.openTabs.filter(function (id) { return state.notes.some(function (n) { return n.id === id; }); })
      : [state.notes[0].id];
    if (!state.openTabs.length) state.openTabs = [state.notes[0].id];
    state.activeNoteId = state.notes.some(function (n) { return n.id === loaded.activeNoteId; })
      ? loaded.activeNoteId
      : state.openTabs[0];
    state.activeFilter = loaded.activeFilter || "all";
    return true;
  }

  /* -------------------- HD Space & Nature Wallpaper Engine -------------------- */
  var lastRenderedScene = "";
  var lastStaticCustomUrl = "";
  var cachedCustomImg = null;

  function drawCoverImageOnCanvas(img) {
    var canvas = document.getElementById("bgWallpaperCanvas");
    if (!canvas || !img || !img.naturalWidth || !img.naturalHeight) return;
    var W = 1600;
    var H = 900;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    var dw = img.naturalWidth * scale;
    var dh = img.naturalHeight * scale;
    var dx = (W - dw) * 0.5;
    var dy = (H - dh) * 0.5;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function renderStaticCustomWallpaper(dataUrl) {
    if (!dataUrl) return;
    if (lastStaticCustomUrl === dataUrl && cachedCustomImg && cachedCustomImg.complete) {
      lastRenderedScene = "__custom_static__";
      drawCoverImageOnCanvas(cachedCustomImg);
      return;
    }
    lastStaticCustomUrl = dataUrl;
    cachedCustomImg = new Image();
    cachedCustomImg.onload = function () {
      if (state.settings.wallpaperDataUrl === dataUrl && state.settings.wallpaperAnimated === false) {
        lastRenderedScene = "__custom_static__";
        drawCoverImageOnCanvas(cachedCustomImg);
      }
    };
    cachedCustomImg.src = dataUrl;
  }

  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function ridgeHeight(xNorm, seed, octaves, amp) {
    var y = 0;
    var freq = 1.6;
    var weight = amp;
    for (var o = 0; o < octaves; o++) {
      y += Math.sin(xNorm * freq * Math.PI * 2 + seed * (o + 1.37)) * weight;
      y += Math.cos(xNorm * freq * 1.73 * Math.PI * 2 - seed * (o + 2.11)) * (weight * 0.48);
      freq *= 2.15;
      weight *= 0.47;
    }
    return y;
  }

  function drawStarfield(ctx, W, H, count, maxY, seed) {
    var rnd = makeRng(seed);
    var starColors = ["#ffffff", "#e0f2fe", "#bae6fd", "#fef3c7", "#ddd6fe"];
    for (var i = 0; i < count; i++) {
      var sx = rnd() * W;
      var sy = rnd() * maxY;
      var sr = rnd() < 0.86 ? (0.45 + rnd() * 0.95) : (1.35 + rnd() * 1.45);
      var alpha = 0.25 + rnd() * 0.75;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = starColors[Math.floor(rnd() * starColors.length)];
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();

      if (sr > 2.25) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.strokeStyle = "#e0f2fe";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx - sr * 4.5, sy);
        ctx.lineTo(sx + sr * 4.5, sy);
        ctx.moveTo(sx, sy - sr * 4.5);
        ctx.lineTo(sx, sy + sr * 4.5);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawGlowOrb(ctx, cx, cy, radius, innerStop, outerStop) {
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, innerStop);
    g.addColorStop(0.45, outerStop);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawMountainLayer(ctx, W, H, baseY, amp, seed, fillTop, fillBot, withPines) {
    var grad = ctx.createLinearGradient(0, baseY - amp, 0, H);
    grad.addColorStop(0, fillTop);
    grad.addColorStop(1, fillBot);
    ctx.fillStyle = grad;

    var pts = [];
    var steps = 160;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (var i = 0; i <= steps; i++) {
      var xn = i / steps;
      var px = xn * W;
      var py = baseY + ridgeHeight(xn, seed, 5, amp);
      pts.push({ x: px, y: py });
      ctx.lineTo(px, py);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    if (withPines) {
      var rnd = makeRng(Math.floor(seed * 997));
      ctx.fillStyle = fillTop;
      for (var j = 0; j < pts.length - 1; j++) {
        var count = 2 + Math.floor(rnd() * 3);
        for (var k = 0; k < count; k++) {
          var t = rnd();
          var tx = pts[j].x + (pts[j + 1].x - pts[j].x) * t;
          var ty = pts[j].y + (pts[j + 1].y - pts[j].y) * t;
          var th = 14 + rnd() * 24;
          var tw = 4.5 + rnd() * 5.5;
          ctx.beginPath();
          ctx.moveTo(tx, ty - th);
          ctx.lineTo(tx - tw, ty + 3);
          ctx.lineTo(tx + tw, ty + 3);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }

  function renderWallpaperScene(sceneId) {
    var canvas = document.getElementById("bgWallpaperCanvas");
    if (!canvas) return;
    if (lastRenderedScene === sceneId) return;
    lastRenderedScene = sceneId;

    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var W = canvas.width;
    var H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (sceneId === "space_nebula") {
      var bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#030511");
      bg.addColorStop(0.5, "#090d24");
      bg.addColorStop(1, "#040714");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      drawGlowOrb(ctx, W * 0.24, H * 0.32, 540, "rgba(124, 58, 237, 0.56)", "rgba(79, 70, 229, 0.22)");
      drawGlowOrb(ctx, W * 0.74, H * 0.64, 580, "rgba(14, 165, 233, 0.50)", "rgba(37, 99, 235, 0.20)");
      drawGlowOrb(ctx, W * 0.54, H * 0.44, 430, "rgba(236, 72, 153, 0.38)", "rgba(168, 85, 247, 0.16)");
      drawGlowOrb(ctx, W * 0.82, H * 0.22, 340, "rgba(45, 212, 191, 0.30)", "rgba(14, 165, 233, 0.10)");
      drawGlowOrb(ctx, W * 0.18, H * 0.78, 380, "rgba(59, 130, 246, 0.34)", "rgba(30, 58, 138, 0.12)");
      ctx.restore();

      drawStarfield(ctx, W, H, 680, H, 104729);
      return;
    }

    if (sceneId === "space_planet") {
      var bgP = ctx.createLinearGradient(0, 0, 0, H);
      bgP.addColorStop(0, "#02040a");
      bgP.addColorStop(0.65, "#071226");
      bgP.addColorStop(1, "#0c2442");
      ctx.fillStyle = bgP;
      ctx.fillRect(0, 0, W, H);

      drawGlowOrb(ctx, W * 0.22, H * 0.26, 460, "rgba(99, 102, 241, 0.26)", "rgba(30, 64, 175, 0.10)");
      drawStarfield(ctx, W, H, 560, H * 0.82, 22193);

      var pCx = W * 0.52;
      var pCy = H * 2.18;
      var pR = H * 1.62;

      var atmo = ctx.createRadialGradient(pCx, pCy, pR * 0.96, pCx, pCy, pR * 1.11);
      atmo.addColorStop(0, "rgba(56, 189, 248, 0.85)");
      atmo.addColorStop(0.28, "rgba(14, 165, 233, 0.45)");
      atmo.addColorStop(0.62, "rgba(59, 130, 246, 0.14)");
      atmo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = atmo;
      ctx.beginPath();
      ctx.arc(pCx, pCy, pR * 1.11, 0, Math.PI * 2);
      ctx.fill();

      drawGlowOrb(ctx, W * 0.64, H * 0.58, 320, "rgba(255, 255, 255, 0.88)", "rgba(56, 189, 248, 0.34)");

      var planetBody = ctx.createRadialGradient(W * 0.62, H * 0.58, 30, pCx, pCy, pR);
      planetBody.addColorStop(0, "#153e63");
      planetBody.addColorStop(0.16, "#081629");
      planetBody.addColorStop(0.45, "#030711");
      planetBody.addColorStop(1, "#010308");
      ctx.fillStyle = planetBody;
      ctx.beginPath();
      ctx.arc(pCx, pCy, pR, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(186, 230, 253, 0.82)";
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(pCx, pCy, pR, Math.PI * 1.32, Math.PI * 1.68);
      ctx.stroke();
      return;
    }

    if (sceneId === "nature_forest") {
      var skyF = ctx.createLinearGradient(0, 0, 0, H * 0.72);
      skyF.addColorStop(0, "#0b2938");
      skyF.addColorStop(0.42, "#195664");
      skyF.addColorStop(0.78, "#5ea8a7");
      skyF.addColorStop(1, "#cffafe");
      ctx.fillStyle = skyF;
      ctx.fillRect(0, 0, W, H);

      drawGlowOrb(ctx, W * 0.72, H * 0.28, 420, "rgba(254, 249, 195, 0.72)", "rgba(153, 246, 228, 0.25)");

      drawMountainLayer(ctx, W, H, H * 0.44, 68, 1.4, "#3b7680", "#76b5b8", false);
      drawGlowOrb(ctx, W * 0.5, H * 0.55, 580, "rgba(207, 250, 254, 0.28)", "rgba(207, 250, 254, 0.05)");
      drawMountainLayer(ctx, W, H, H * 0.55, 62, 2.9, "#245560", "#458188", false);
      drawMountainLayer(ctx, W, H, H * 0.66, 52, 4.3, "#153c47", "#23535d", true);
      drawMountainLayer(ctx, W, H, H * 0.78, 42, 6.1, "#0a2229", "#0f2e36", true);
      return;
    }

    if (sceneId === "nature_aurora") {
      var skyA = ctx.createLinearGradient(0, 0, 0, H);
      skyA.addColorStop(0, "#020617");
      skyA.addColorStop(0.55, "#061b2e");
      skyA.addColorStop(1, "#082f49");
      ctx.fillStyle = skyA;
      ctx.fillRect(0, 0, W, H);

      drawStarfield(ctx, W, H, 420, H * 0.68, 7731);

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      for (var band = 0; band < 3; band++) {
        for (var x = 0; x < W; x += 8) {
          var xn = x / W;
          var wave = Math.sin(xn * 5.2 + band * 1.7) * 65 + Math.cos(xn * 9.1 - band) * 32;
          var topY = H * (0.10 + band * 0.07) + wave;
          var curtainH = 190 + Math.sin(xn * 11 + band * 2) * 65;
          var ag = ctx.createLinearGradient(0, topY, 0, topY + curtainH);
          ag.addColorStop(0, "rgba(16, 185, 129, 0)");
          ag.addColorStop(0.35, band === 1 ? "rgba(168, 85, 247, 0.14)" : "rgba(45, 212, 191, 0.16)");
          ag.addColorStop(0.72, "rgba(16, 185, 129, 0.34)");
          ag.addColorStop(0.92, "rgba(110, 231, 183, 0.42)");
          ag.addColorStop(1, "rgba(16, 185, 129, 0)");
          ctx.fillStyle = ag;
          ctx.fillRect(x, topY, 10, curtainH);
        }
      }
      ctx.restore();

      drawMountainLayer(ctx, W, H, H * 0.62, 82, 3.7, "#0f293c", "#071320", false);
      drawMountainLayer(ctx, W, H, H * 0.72, 48, 8.2, "#06131f", "#030912", true);

      var lake = ctx.createLinearGradient(0, H * 0.79, 0, H);
      lake.addColorStop(0, "#062833");
      lake.addColorStop(0.45, "#0d4a4d");
      lake.addColorStop(1, "#04131c");
      ctx.fillStyle = lake;
      ctx.fillRect(0, H * 0.80, W, H * 0.20);
      return;
    }

    if (sceneId === "nature_sunset") {
      var skyS = ctx.createLinearGradient(0, 0, 0, H * 0.76);
      skyS.addColorStop(0, "#17133a");
      skyS.addColorStop(0.30, "#581c5c");
      skyS.addColorStop(0.58, "#be185d");
      skyS.addColorStop(0.80, "#f97316");
      skyS.addColorStop(1, "#fde047");
      ctx.fillStyle = skyS;
      ctx.fillRect(0, 0, W, H);

      drawStarfield(ctx, W, H, 140, H * 0.34, 4491);
      drawGlowOrb(ctx, W * 0.56, H * 0.52, 360, "rgba(254, 240, 138, 0.85)", "rgba(249, 115, 22, 0.32)");

      ctx.fillStyle = "rgba(255, 250, 220, 0.92)";
      ctx.beginPath();
      ctx.arc(W * 0.56, H * 0.50, 56, 0, Math.PI * 2);
      ctx.fill();

      drawMountainLayer(ctx, W, H, H * 0.54, 66, 2.2, "#6d285f", "#451a4c", false);
      drawMountainLayer(ctx, W, H, H * 0.65, 58, 5.4, "#3b1745", "#240f31", false);
      drawMountainLayer(ctx, W, H, H * 0.77, 45, 7.8, "#1b0b26", "#0d0514", true);
      return;
    }

    if (sceneId === "nature_ocean") {
      var skyO = ctx.createLinearGradient(0, 0, 0, H * 0.58);
      skyO.addColorStop(0, "#040d21");
      skyO.addColorStop(0.45, "#0c264e");
      skyO.addColorStop(0.82, "#155e75");
      skyO.addColorStop(1, "#38bdf8");
      ctx.fillStyle = skyO;
      ctx.fillRect(0, 0, W, H * 0.58);

      drawStarfield(ctx, W, H, 280, H * 0.45, 9913);
      var moonX = W * 0.65;
      var moonY = H * 0.30;
      drawGlowOrb(ctx, moonX, moonY, 260, "rgba(224, 242, 254, 0.58)", "rgba(56, 189, 248, 0.18)");
      ctx.fillStyle = "#f0f9ff";
      ctx.beginPath();
      ctx.arc(moonX, moonY, 36, 0, Math.PI * 2);
      ctx.fill();

      var sea = ctx.createLinearGradient(0, H * 0.56, 0, H);
      sea.addColorStop(0, "#0e4d6c");
      sea.addColorStop(0.35, "#08314b");
      sea.addColorStop(1, "#031322");
      ctx.fillStyle = sea;
      ctx.fillRect(0, H * 0.56, W, H * 0.44);

      var rndO = makeRng(6123);
      for (var wy = H * 0.565; wy < H; wy += 3.6) {
        var prog = (wy - H * 0.56) / (H * 0.44);
        var spread = 36 + prog * 310;
        var rx = moonX + (rndO() - 0.5) * spread;
        var rw = 18 + rndO() * (45 + prog * 140);
        ctx.fillStyle = "rgba(186, 230, 253, " + (0.48 - prog * 0.30).toFixed(2) + ")";
        ctx.fillRect(rx - rw / 2, wy, rw, 1.8 + prog * 1.4);
      }

      drawMountainLayer(ctx, W, H, H * 0.56, 24, 9.1, "#071e32", "#071e32", false);
      return;
    }

    if (sceneId === "nature_dawn") {
      var skyD = ctx.createLinearGradient(0, 0, W, H);
      skyD.addColorStop(0, "#ffffff");
      skyD.addColorStop(0.35, "#e0f2fe");
      skyD.addColorStop(0.70, "#fce7f3");
      skyD.addColorStop(1, "#fef3c7");
      ctx.fillStyle = skyD;
      ctx.fillRect(0, 0, W, H);

      drawGlowOrb(ctx, W * 0.72, H * 0.28, 380, "rgba(255, 255, 255, 0.95)", "rgba(254, 215, 170, 0.40)");
      drawGlowOrb(ctx, W * 0.24, H * 0.36, 360, "rgba(186, 230, 253, 0.65)", "rgba(224, 231, 255, 0.25)");

      drawMountainLayer(ctx, W, H, H * 0.56, 56, 1.9, "#cbd5e1", "#e2e8f0", false);
      drawMountainLayer(ctx, W, H, H * 0.68, 48, 3.8, "#94a3b8", "#cbd5e1", false);
      drawMountainLayer(ctx, W, H, H * 0.80, 38, 6.4, "#64748b", "#94a3b8", false);
      return;
    }

    if (sceneId === "flowey_garden") {
      /* Warm sunset base layer beneath the Deltarune Sunset Rooftop GIF/static wallpaper */
      var bgFl = ctx.createLinearGradient(0, 0, 0, H);
      bgFl.addColorStop(0, "#f472b6");
      bgFl.addColorStop(0.50, "#fde047");
      bgFl.addColorStop(1, "#3b1812");
      ctx.fillStyle = bgFl;
      ctx.fillRect(0, 0, W, H);
      return;
    }
  }

  function hexLuminance(hex) {
    var clean = String(hex || "").replace("#", "");
    if (clean.length !== 6) return 0.2;
    var r = parseInt(clean.slice(0, 2), 16) / 255;
    var g = parseInt(clean.slice(2, 4), 16) / 255;
    var b = parseInt(clean.slice(4, 6), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  var APP_FAVICON_COLORS = {
    bw:     { bg: "%231b1e25", hex1: "#282b34", hex2: "#14161b", inkHex: "#f8fafc", ink: "%23f8fafc", stroke: "rgba(255,255,255,0.34)" },
    blue:   { bg: "%231e4aa8", hex1: "#265cc7", hex2: "#17388a", inkHex: "#f8fafc", ink: "%23f8fafc", stroke: "rgba(255,255,255,0.34)" },
    white:  { bg: "%23eef2f6", hex1: "#fafbfc", hex2: "#dde3ec", inkHex: "#161921", ink: "%23161921", stroke: "rgba(15,23,42,0.28)" },
    purple: { bg: "%234b2999", hex1: "#5e36b8", hex2: "#381c78", inkHex: "#f8fafc", ink: "%23f8fafc", stroke: "rgba(255,255,255,0.34)" },
    yellow: { bg: "%23de9f1a", hex1: "#f2ba26", hex2: "#c9870f", inkHex: "#161921", ink: "%23161921", stroke: "rgba(15,23,42,0.28)" },
    red:    { bg: "%23a1202b", hex1: "#c42936", hex2: "#7d1420", inkHex: "#f8fafc", ink: "%23f8fafc", stroke: "rgba(255,255,255,0.34)" },
    green:  { bg: "%23146d4e", hex1: "#198761", hex2: "#0d523a", inkHex: "#f8fafc", ink: "%23f8fafc", stroke: "rgba(255,255,255,0.34)" },
    pink:   { bg: "%239c2564", hex1: "#bf307a", hex2: "#78194e", inkHex: "#f8fafc", ink: "%23f8fafc", stroke: "rgba(255,255,255,0.34)" }
  };
  var lastSyncedNativeIcon = "";

  function syncAppIconEverywhere(iconKey) {
    var key = APP_FAVICON_COLORS[iconKey] ? iconKey : "bw";
    var c = APP_FAVICON_COLORS[key];
    var fav = document.getElementById("appFavicon");
    if (fav) {
      fav.setAttribute(
        "href",
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='1' y='1' width='62' height='62' rx='11' fill='" +
          c.bg +
          "'/%3E%3Cpath d='M48.59 19.12A21 21 0 1 0 52.93 30.34H31.49v6.78h12.78A13.3 13.3 0 1 1 42.51 23.85z' fill='" +
          c.ink +
          "'/%3E%3C/svg%3E"
      );
    }
    var winMark = document.getElementById("winAppMark");
    if (winMark) {
      winMark.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 64 64"><defs><linearGradient id="wmGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' +
        c.hex1 +
        '"/><stop offset="100%" stop-color="' +
        c.hex2 +
        '"/></linearGradient></defs><rect x="1.5" y="1.5" width="61" height="61" rx="11" fill="url(#wmGrad)" stroke="' +
        c.stroke +
        '" stroke-width="1.8"/><path d="M48.59 19.12A21 21 0 1 0 52.93 30.34H31.49v6.78h12.78A13.3 13.3 0 1 1 42.51 23.85z" fill="' +
        c.inkHex +
        '"/></svg>';
    }
    document.querySelectorAll("#appIconGroup [data-app-icon]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-app-icon") === key);
    });
    if (typeof window.__gnNativeSetAppIcon === "function" && lastSyncedNativeIcon !== key) {
      lastSyncedNativeIcon = key;
      try {
        window.__gnNativeSetAppIcon(key);
      } catch (e) {}
    }
  }

  var BUILTIN_FONT_MAP = {
    sans: "var(--font-sans)",
    calibri: "Calibri, 'Carlito', 'Segoe UI', sans-serif",
    verdana: "Verdana, Geneva, 'DejaVu Sans', sans-serif",
    tahoma: "Tahoma, Geneva, 'Segoe UI', sans-serif",
    trebuchet: "'Trebuchet MS', 'Lucida Sans Unicode', sans-serif",
    bahnschrift: "Bahnschrift, 'DIN Alternate', 'Franklin Gothic Medium', 'Arial Narrow', sans-serif",
    serif: "var(--font-serif)",
    cambria: "Cambria, Georgia, 'Times New Roman', serif",
    times: "'Times New Roman', Times, 'Liberation Serif', serif",
    palatino: "'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
    mono: "var(--font-mono)",
    courier: "'Courier New', Courier, 'Liberation Mono', monospace",
    handwriting: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', cursive",
    script: "'Segoe Script', 'Snell Roundhand', 'Brush Script MT', cursive",
    comic: "'Comic Sans MS', 'Comic Neue', Chalkboard, cursive"
  };

  function syncCustomFontsDomAndSelect() {
    var list = Array.isArray(state.settings.customFonts) ? state.settings.customFonts : [];
    var styleEl = document.getElementById("gnCustomFontsStyle");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "gnCustomFontsStyle";
      var parent = document.head || document.documentElement;
      if (parent && parent.appendChild) parent.appendChild(styleEl);
    }
    var cssRules = [];
    list.forEach(function (cf) {
      if (cf && cf.id && cf.dataUrl) {
        cssRules.push(
          '@font-face { font-family: "' +
            cf.id.replace(/[^a-zA-Z0-9_-]/g, "") +
            '"; src: url("' +
            cf.dataUrl.replace(/"/g, "") +
            '"); font-display: swap; }'
        );
      }
    });
    styleEl.textContent = cssRules.join("\n");

    var sel = document.getElementById("fontFamilySelect");
    if (sel && sel.querySelectorAll) {
      sel.querySelectorAll("option[data-custom-font]").forEach(function (o) {
        if (o.parentNode) o.parentNode.removeChild(o);
      });
      list.forEach(function (cf) {
        if (!cf || !cf.id || !cf.name) return;
        var opt = document.createElement("option");
        opt.value = cf.id;
        opt.setAttribute("data-custom-font", "1");
        opt.textContent = cf.name;
        var fam = cf.dataUrl ? ('"' + cf.id + '"') : ('"' + cf.name.replace(/"/g, "") + '"');
        opt.style.fontFamily = fam + ", var(--font-sans)";
        sel.appendChild(opt);
      });
    }

    var chips = document.getElementById("customFontsChips");
    if (chips) {
      chips.innerHTML = "";
      list.forEach(function (cf) {
        if (!cf || !cf.id || !cf.name) return;
        var chip = document.createElement("div");
        chip.className = "custom-font-chip" + (state.settings.fontFamily === cf.id ? " active" : "");
        chip.setAttribute("data-select-cfont", cf.id);
        var fam = cf.dataUrl ? ('"' + cf.id + '"') : ('"' + cf.name.replace(/"/g, "") + '"');
        chip.style.fontFamily = fam + ", var(--font-sans)";
        chip.innerHTML =
          "<span>" +
          escapeHtml(cf.name) +
          '</span><button type="button" class="custom-font-chip-del" data-del-cfont="' +
          escapeHtml(cf.id) +
          '" title="✕">✕</button>';
        chips.appendChild(chip);
      });
    }
  }

  function resolveEditorFontCss(fontId) {
    if (BUILTIN_FONT_MAP[fontId]) return BUILTIN_FONT_MAP[fontId];
    var list = Array.isArray(state.settings.customFonts) ? state.settings.customFonts : [];
    for (var i = 0; i < list.length; i++) {
      var cf = list[i];
      if (cf && cf.id === fontId) {
        if (cf.dataUrl) {
          return '"' + cf.id.replace(/[^a-zA-Z0-9_-]/g, "") + '", var(--font-sans)';
        }
        return '"' + String(cf.name || "").replace(/"/g, "") + '", var(--font-sans)';
      }
    }
    return BUILTIN_FONT_MAP.sans;
  }

  /* -------------------- Appearance & Theme -------------------- */
  function resolveEffectiveTheme() {
    var mode = state.settings.themeMode || "dark";
    if (mode === "flowey" && !state.settings.easterEggsEnabled) {
      return "dark";
    }
    if (mode === "auto") {
      try {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      } catch (e) { return "dark"; }
    }
    return mode;
  }

  function applyAppearance() {
    var root = document.documentElement;
    var s = state.settings;
    var effTheme = resolveEffectiveTheme();
    var sceneId = (VALID_SCENES[s.scene] || getImportedThemeById(s.scene)) ? s.scene : "web_galaxy";
    var vLayout = s.viewLayout === "compact" ? "compact" : "full";

    root.setAttribute("data-theme", effTheme);
    root.setAttribute("data-view", vLayout);
    root.setAttribute("data-material", s.material === "solid" ? "solid" : "blur");
    root.setAttribute("data-scene", sceneId);
    root.setAttribute("data-easter-eggs", s.easterEggsEnabled ? "true" : "false");
    root.setAttribute("data-flowey-unlocked", (s.easterEggsEnabled && s.floweyUnlocked) ? "true" : "false");
    root.setAttribute("lang", s.lang || "ru");
    if (isNativeExe) {
      root.setAttribute("data-native-exe", "true");
    }

    if (s.accent === "custom") {
      var cHex = s.customAccent || "#3b82f6";
      root.setAttribute("data-accent", "custom");
      root.style.setProperty("--accent", cHex);
      root.style.setProperty("--accent-rgb", hexToRgbString(cHex));
      root.style.setProperty("--accent-fg", hexLuminance(cHex) > 0.68 ? "#0f172a" : "#ffffff");
    } else {
      root.setAttribute("data-accent", s.accent || "sapphire");
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-rgb");
      root.style.removeProperty("--accent-fg");
    }

    var blurVal = typeof s.blurPx === "number" ? s.blurPx : 22;
    var opVal = typeof s.glassOpacity === "number" ? s.glassOpacity : 48;
    root.style.setProperty("--user-blur", blurVal + "px");
    root.style.setProperty("--user-glass-alpha", (opVal / 100).toFixed(2));

    syncCustomFontsDomAndSelect();
    var resolvedFontCss = resolveEditorFontCss(s.fontFamily);
    if (!BUILTIN_FONT_MAP[s.fontFamily] && resolvedFontCss === BUILTIN_FONT_MAP.sans) {
      s.fontFamily = "sans";
    }
    root.style.setProperty("--editor-font", resolvedFontCss);
    root.style.setProperty("--editor-font-size", (s.fontSize || 15) + "px");

    /* Flowery's animated wallpaper belongs strictly to the Flowery theme */
    if (effTheme !== "flowey" && sceneId === "flowey_garden") {
      sceneId = s.lastNormalScene || "web_galaxy";
      if (!VALID_SCENES[sceneId] && !getImportedThemeById(sceneId)) sceneId = "web_galaxy";
      root.setAttribute("data-scene", sceneId);
    }

    /* Render Internet Photo Theme, User-Imported Internet Theme, Flowery Wallpaper, or OS Screen */
    var isFloweryTheme = effTheme === "flowey";
    var isAnim = isFloweryTheme && (s.wallpaperAnimated !== false);
    var wp = document.getElementById("desktopWallpaper");
    var backdropEl = document.getElementById("desktopBackdrop");
    var impTheme = getImportedThemeById(sceneId);

    if (s.wallpaperDataUrl) {
      /* Outside Flowery, wallpapers never animate — render custom image statically on canvas */
      if (isFloweryTheme && isAnim) {
        if (wp) {
          wp.style.backgroundImage = "url(" + s.wallpaperDataUrl + ")";
          wp.classList.add("has-image");
        }
        if (backdropEl) backdropEl.classList.add("has-custom-wp");
      } else {
        renderStaticCustomWallpaper(s.wallpaperDataUrl);
        if (wp) {
          wp.style.backgroundImage = "";
          wp.classList.remove("has-image");
        }
        if (backdropEl) backdropEl.classList.remove("has-custom-wp");
      }
    } else if (isFloweryTheme && sceneId === "flowey_garden" && window.FLOWERY_WALLPAPER) {
      renderWallpaperScene(sceneId);
      var floweryWpUrl = isAnim ? window.FLOWERY_WALLPAPER.animated : window.FLOWERY_WALLPAPER.static;
      if (wp) {
        wp.style.backgroundImage = "url(" + floweryWpUrl + ")";
        wp.classList.add("has-image");
      }
      if (backdropEl) backdropEl.classList.add("has-custom-wp");
    } else if (impTheme && impTheme.dataUrl) {
      if (wp) {
        wp.style.backgroundImage = "url(\"" + impTheme.dataUrl.replace(/"/g, "%22") + "\")";
        wp.classList.add("has-image");
      }
      if (backdropEl) backdropEl.classList.add("has-custom-wp");
    } else if (window.DELTARUNE_WALLPAPERS && window.DELTARUNE_WALLPAPERS[sceneId]) {
      if (wp) {
        wp.style.backgroundImage = "url(" + window.DELTARUNE_WALLPAPERS[sceneId] + ")";
        wp.classList.add("has-image");
      }
      if (backdropEl) backdropEl.classList.add("has-custom-wp");
    } else {
      renderWallpaperScene(sceneId);
      if (wp) {
        wp.style.backgroundImage = "";
        wp.classList.remove("has-image");
      }
      if (backdropEl) backdropEl.classList.remove("has-custom-wp");
    }

    /* Sync Native Win32 Real Screen Blur & Dark/Light Backdrop */
    if (typeof window.__gnNativeSetWindowStyle === "function") {
      try {
        var activeScene = s.wallpaperDataUrl ? "custom_img" : sceneId;
        var winTheme = effTheme === "light" ? "light" : "dark";
        window.__gnNativeSetWindowStyle((s.material === "solid" ? "solid" : "blur") + ":" + winTheme + ":" + activeScene);
      } catch (e) {}
    }
    syncAppIconEverywhere(s.appIcon || "bw");

    /* Quick Topbar Controls */
    var langBtn = document.getElementById("btnQuickLang");
    if (langBtn) langBtn.textContent = (s.lang || "ru").toUpperCase();
    var quickViewBtn = document.getElementById("btnQuickView");
    if (quickViewBtn) quickViewBtn.classList.toggle("active", vLayout === "compact");

    /* Settings Dialog Sync */
    document.querySelectorAll("#setViewLayoutGroup .seg-opt").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view-layout") === vLayout);
    });

    var themeIconWrap = document.getElementById("themeIconWrap");
    if (themeIconWrap) {
      if (effTheme === "flowey") {
        themeIconWrap.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffe629" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>';
      } else {
        themeIconWrap.innerHTML = effTheme === "dark"
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      }
    }

    /* Settings Dialog Sync */
    var activeCardKey = s.langMode === "manual" ? s.lang : "auto";
    document.querySelectorAll("#langCardsGrid [data-lang-card]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-lang-card") === activeCardKey);
    });
    var showFld = s.showFolders !== false;
    document.querySelectorAll("#setFoldersGroup .seg-opt").forEach(function (b) {
      b.classList.toggle("active", (b.getAttribute("data-folders") === "on") === showFld);
    });
    var fwEnabled = !!s.fleetwayThemesEnabled;
    document.querySelectorAll("#setFleetwayThemesGroup .seg-opt").forEach(function (b) {
      b.classList.toggle("active", (b.getAttribute("data-fleetway-themes") === "on") === fwEnabled);
    });
    var eeEnabled = !!s.easterEggsEnabled;
    document.querySelectorAll("#setEasterEggsGroup .seg-opt").forEach(function (b) {
      b.classList.toggle("active", (b.getAttribute("data-easter-eggs") === "on") === eeEnabled);
    });
    var tabMainFw = document.getElementById("tabMainFleetwayBtn");
    if (tabMainFw) {
      tabMainFw.textContent = fwEnabled ? t("tabFleetway") : t("catAtmos");
    }
    document.querySelectorAll("#setThemeGroup .seg-opt").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-theme-mode") === s.themeMode);
    });
    document.querySelectorAll("#setMaterialGroup .seg-opt").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-mat") === s.material);
    });
    document.querySelectorAll("#accentsSwatches .swatch").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-accent") === s.accent);
    });
    document.querySelectorAll(".wp-grid .wp-card").forEach(function (b) {
      b.classList.toggle("active", !s.wallpaperDataUrl && b.getAttribute("data-scene") === sceneId);
    });
    document.querySelectorAll("#setWpAnimGroup .seg-opt").forEach(function (b) {
      b.classList.toggle("active", (b.getAttribute("data-wp-anim") === "on") === (s.wallpaperAnimated !== false));
    });

    document.getElementById("blurRange").value = blurVal;
    document.getElementById("blurValLabel").textContent = blurVal + "px";
    document.getElementById("opacityRange").value = opVal;
    document.getElementById("opacityValLabel").textContent = opVal + "%";
    document.getElementById("fontFamilySelect").value = s.fontFamily || "sans";
    document.getElementById("fontSizeVal").textContent = (s.fontSize || 15) + "px";

    var glassGroup = document.getElementById("glassSettingsGroup");
    if (glassGroup) glassGroup.style.opacity = s.material === "solid" ? "0.45" : "1";

    /* Layout & TXT Options */
    var appShell = document.getElementById("appShell");
    appShell.classList.toggle("sidebar-collapsed", !!s.sidebarCollapsed);
    appShell.classList.toggle("folders-hidden", !showFld);
    document.getElementById("editorSheet").classList.toggle("full-width", !!s.wideMode);
    document.getElementById("lineNumbers").classList.toggle("hidden", !s.lineNumbers);
    document.getElementById("btnLineNumbers").classList.toggle("active", !!s.lineNumbers);
    document.getElementById("plainTextarea").classList.toggle("nowrap", !s.wordWrap);
    document.getElementById("mdPreviewPane").classList.toggle("visible", !!s.mdPreview);
    document.getElementById("btnMdPreview").classList.toggle("active", !!s.mdPreview);
  }

  function applyLocalization() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
    document.getElementById("richEditor").setAttribute("data-placeholder", t("richPlaceholder"));
    var tabMainFw = document.getElementById("tabMainFleetwayBtn");
    if (tabMainFw) {
      tabMainFw.textContent = state.settings.fleetwayThemesEnabled ? t("tabFleetway") : t("catAtmos");
    }

    updatePortableStatusLabel();
    renderFolders();
    renderNotesList();
    renderTabs();
    syncEditorModeLabels();
    updateStats();
  }

  /* -------------------- Notes & Folders -------------------- */
  function getNoteById(id) {
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === id) return state.notes[i];
    }
    return null;
  }

  function getActiveNote() {
    return getNoteById(state.activeNoteId);
  }

  function getUnsavedNotes() {
    return state.notes.filter(function (n) {
      return n && !n.trashed && !!n.isDirty;
    });
  }

  function syncNativeDirtyFlag() {
    if (isNativeExe && typeof window.__gnNativeSetDirty === "function") {
      try {
        window.__gnNativeSetDirty(getUnsavedNotes().length > 0 ? "1" : "0");
      } catch (e) {}
    }
  }

  function markNoteDirty(n, isDirty) {
    if (!n) return;
    var next = !!isDirty;
    if (!!n.isDirty !== next) {
      n.isDirty = next;
      syncNativeDirtyFlag();
      renderTabs();
    }
  }

  function getFilteredNotes() {
    var q = (document.getElementById("searchInput").value || "").trim().toLowerCase();
    var filter = state.activeFilter || "all";

    var list = state.notes.filter(function (n) {
      if (filter === "trash") {
        if (!n.trashed) return false;
      } else {
        if (n.trashed) return false;
        if (filter === "favorites" && !n.pinned) return false;
        if (filter.indexOf("folder:") === 0 && n.folderId !== filter.slice(7)) return false;
      }

      if (q) {
        var inTitle = (n.title || "").toLowerCase().indexOf(q) !== -1;
        var inBody = getNotePlainText(n).toLowerCase().indexOf(q) !== -1;
        return inTitle || inBody;
      }
      return true;
    });

    list.sort(function (a, b) {
      if (a.pinned !== b.pinned && filter !== "trash") return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return list;
  }

  function renderFolders() {
    var wrap = document.getElementById("foldersList");
    var allCnt = state.notes.filter(function (n) { return !n.trashed; }).length;
    var favCnt = state.notes.filter(function (n) { return !n.trashed && n.pinned; }).length;
    var trashCnt = state.notes.filter(function (n) { return !!n.trashed; }).length;

    var folderIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    var notesIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var starIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    var trashIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

    var html = "";
    function row(fKey, label, svg, count, delId) {
      var act = state.activeFilter === fKey ? " active" : "";
      return (
        '<div class="folder-row' + act + '" data-filter="' + escapeHtml(fKey) + '" role="button" tabindex="0">' +
        '<span class="folder-row-left">' + svg + "<span>" + escapeHtml(label) + "</span></span>" +
        '<span class="folder-row-right">' +
        (delId ? '<button type="button" class="folder-del" data-del-folder="' + escapeHtml(delId) + '">✕</button>' : "") +
        '<span class="folder-cnt">' + (count > 0 ? count : "") + "</span>" +
        "</span></div>"
      );
    }

    html += row("all", t("allNotes"), notesIcon, allCnt, null);
    if (favCnt > 0 || state.activeFilter === "favorites") {
      html += row("favorites", t("favorites"), starIcon, favCnt, null);
    }
    state.folders.forEach(function (f) {
      var cnt = state.notes.filter(function (n) { return !n.trashed && n.folderId === f.id; }).length;
      html += row("folder:" + f.id, getFolderDisplayName(f), folderIcon, cnt, f.id);
    });
    if (trashCnt > 0 || state.activeFilter === "trash") {
      html += row("trash", t("trash"), trashIcon, trashCnt, null);
    }

    wrap.innerHTML = html;

    var sel = document.getElementById("noteFolderSelect");
    var opts = '<option value="">' + escapeHtml(t("noFolder")) + "</option>";
    state.folders.forEach(function (f) {
      opts += '<option value="' + escapeHtml(f.id) + '">' + escapeHtml(getFolderDisplayName(f)) + "</option>";
    });
    sel.innerHTML = opts;
    var cur = getActiveNote();
    if (cur) sel.value = cur.folderId || "";
  }

  function renderNotesList() {
    var wrap = document.getElementById("notesList");
    var items = getFilteredNotes();
    var hasQ = !!(document.getElementById("searchInput").value || "").trim();

    if (!items.length) {
      wrap.innerHTML = '<div class="empty-notes">' + escapeHtml(hasQ ? t("emptySearch") : t("emptyNotes")) + "</div>";
      return;
    }

    wrap.innerHTML = items.map(function (n) {
      var act = n.id === state.activeNoteId ? " active" : "";
      var title = (n.title || "").trim() || t("untitled");
      var preview = getNotePlainText(n).replace(/\s+/g, " ").trim() || t("noContent");
      var pin = n.pinned
        ? '<span class="note-pin-mark"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></span>'
        : "";
      return (
        '<div class="note-row' + act + '" data-note-id="' + escapeHtml(n.id) + '">' +
        '<div class="note-row-top"><span class="note-row-title">' + escapeHtml(title) + "</span>" + pin + "</div>" +
        '<div class="note-row-sub"><span class="note-row-date">' + escapeHtml(formatShortDate(n.updatedAt)) + '</span><span class="note-row-preview">' + escapeHtml(preview.slice(0, 75)) + "</span></div>" +
        "</div>"
      );
    }).join("");
  }

  function renderTabs() {
    var strip = document.getElementById("tabsStrip");
    strip.innerHTML = state.openTabs.map(function (id) {
      var n = getNoteById(id);
      if (!n) return "";
      var act = id === state.activeNoteId ? " active" : "";
      var title = (n.title || "").trim() || t("untitled");
      var dirtyDot = (!n.trashed && n.isDirty) ? '<span class="tab-dirty-dot" aria-hidden="true"></span>' : "";
      return (
        '<div class="tab' + act + '" data-tab-id="' + escapeHtml(id) + '" title="' + escapeHtml(title) + '">' +
        dirtyDot +
        '<span class="tab-label">' + escapeHtml(title) + "</span>" +
        (state.openTabs.length > 1
          ? '<button type="button" class="tab-x" data-close-tab="' + escapeHtml(id) + '">✕</button>'
          : "") +
        "</div>"
      );
    }).join("");
  }

  /* -------------------- Editor Loading & Sync -------------------- */
  function syncEditorModeLabels() {
    var n = getActiveNote();
    if (!n) return;
    var isTxt = n.mode === "txt";
    var label = isTxt ? t("modeTxtShort") : t("modeRichShort");
    document.getElementById("btnModeToggle").textContent = label;
    var extBadge = (isTxt && n.fileExt) ? (label + " (" + n.fileExt.toUpperCase() + ")") : label;
    document.getElementById("statusModeLabel").textContent = extBadge;

    var encEl = document.getElementById("statusEncodingLabel");
    if (encEl) encEl.textContent = n.encoding || "UTF-8";

    var pinBtn = document.getElementById("btnPinNote");
    var pinSvg = document.getElementById("pinSvg");
    pinBtn.classList.toggle("active", !!n.pinned);
    pinSvg.setAttribute("fill", n.pinned ? "currentColor" : "none");

    document.getElementById("noteFolderSelect").value = n.folderId || "";
    document.getElementById("trashBanner").classList.toggle("visible", !!n.trashed);
    updatePortableStatusLabel();
  }

  function loadActiveNoteIntoEditor() {
    var n = getActiveNote();
    if (!n) return;

    document.getElementById("noteTitleInput").value = n.title || "";
    syncEditorModeLabels();

    var richEd = document.getElementById("richEditor");
    var plainStage = document.getElementById("plainStage");
    var plainTa = document.getElementById("plainTextarea");
    var richTools = document.getElementById("richToolsGroup");
    var txtTools = document.getElementById("txtToolsGroup");

    if (n.mode === "txt") {
      richEd.style.display = "none";
      plainStage.classList.add("active");
      richTools.style.display = "none";
      txtTools.style.display = "flex";
      plainTa.value = n.plain || "";
      updateLineNumbers();
      updateMarkdownPreview();
    } else {
      plainStage.classList.remove("active");
      richEd.style.display = "block";
      txtTools.style.display = "none";
      richTools.style.display = "flex";
      richEd.innerHTML = n.html || "";
    }
    updateStats();
  }

  function updateLineNumbers() {
    var ta = document.getElementById("plainTextarea");
    var ln = document.getElementById("lineNumbers");
    var count = (ta.value.match(/\n/g) || []).length + 1;
    var arr = [];
    for (var i = 1; i <= count; i++) arr.push(i);
    ln.textContent = arr.join("\n");
    ln.scrollTop = ta.scrollTop;
  }

  function updateMarkdownPreview() {
    if (!state.settings.mdPreview) return;
    document.getElementById("mdPreviewPane").innerHTML = markdownToHtml(document.getElementById("plainTextarea").value);
  }

  function updateStats() {
    var n = getActiveNote();
    var text = getNotePlainText(n);
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;
    var lines = text ? text.split(/\r\n|\r|\n/).length : 1;
    document.getElementById("statLinesVal").textContent = lines;
    document.getElementById("statWordsVal").textContent = words;
    document.getElementById("statCharsVal").textContent = text.length;
  }

  /* -------------------- Note Operations -------------------- */
  function openNote(id) {
    if (!getNoteById(id)) return;
    if (state.openTabs.indexOf(id) === -1) state.openTabs.push(id);
    state.activeNoteId = id;
    renderTabs();
    renderNotesList();
    loadActiveNoteIntoEditor();
    scheduleSave();
    if (window.innerWidth <= 780) {
      state.settings.sidebarCollapsed = true;
      applyAppearance();
    }
  }

  function createNewNote(opts) {
    opts = opts || {};
    var folderId = opts.folderId !== undefined
      ? opts.folderId
      : (state.activeFilter && state.activeFilter.indexOf("folder:") === 0 ? state.activeFilter.slice(7) : "");

    var now = Date.now();
    var note = {
      id: uid("note"),
      title: opts.title || "",
      mode: opts.mode || "rich",
      folderId: folderId,
      pinned: state.activeFilter === "favorites",
      trashed: false,
      createdAt: now,
      updatedAt: now,
      html: opts.html || "",
      plain: opts.plain || "",
      diskPath: opts.diskPath || "",
      fileExt: opts.fileExt || "",
      encoding: opts.encoding || "UTF-8"
    };

    if (state.activeFilter === "trash") state.activeFilter = "all";
    state.notes.unshift(note);
    state.openTabs.push(note.id);
    state.activeNoteId = note.id;

    renderFolders();
    renderNotesList();
    renderTabs();
    loadActiveNoteIntoEditor();
    scheduleSave();

    if (!opts.title) document.getElementById("noteTitleInput").focus();
  }

  function closeTab(id) {
    if (state.openTabs.length <= 1) return;
    var idx = state.openTabs.indexOf(id);
    if (idx === -1) return;
    state.openTabs.splice(idx, 1);
    if (state.activeNoteId === id) {
      state.activeNoteId = state.openTabs[Math.max(0, idx - 1)];
      loadActiveNoteIntoEditor();
    }
    renderTabs();
    renderNotesList();
    scheduleSave();
  }

  function toggleEditorMode() {
    var n = getActiveNote();
    if (!n) return;
    if (n.mode === "txt") {
      n.html = markdownToHtml(n.plain || "");
      n.mode = "rich";
    } else {
      n.plain = htmlToMarkdown(n.html || "");
      n.mode = "txt";
    }
    n.updatedAt = Date.now();
    loadActiveNoteIntoEditor();
    renderNotesList();
    scheduleSave();
  }

  function moveNoteToTrash(targetId) {
    var n = getNoteById(targetId || state.activeNoteId);
    if (!n) return;
    n.trashed = true;
    n.updatedAt = Date.now();
    showToast(t("toastMovedTrash"));
    var rem = state.notes.filter(function (x) { return !x.trashed; });
    if (!rem.length) createNewNote();
    else if (state.activeNoteId === n.id) openNote(rem[0].id);
    renderFolders();
    renderNotesList();
    scheduleSave();
  }

  function duplicateNoteById(targetId) {
    var n = getNoteById(targetId || state.activeNoteId);
    if (!n) return;
    createNewNote({
      title: (n.title || t("untitled")) + " (2)",
      mode: n.mode,
      folderId: n.folderId,
      html: n.html,
      plain: n.plain
    });
  }

  function insertChecklistRow() {
    var n = getActiveNote();
    if (!n || n.mode !== "rich") return;
    var ed = document.getElementById("richEditor");
    ed.focus();

    var row = document.createElement("div");
    row.className = "todo-row";
    row.setAttribute("data-checked", "false");
    row.innerHTML = '<span class="todo-box" contenteditable="false"></span><div class="todo-text">' + escapeHtml(t("checkItemDefault")) + "</div>";

    var sel = window.getSelection();
    if (sel && sel.rangeCount && ed.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      var r = sel.getRangeAt(0);
      r.collapse(false);
      r.insertNode(row);
    } else {
      ed.appendChild(row);
    }

    var txtEl = row.querySelector(".todo-text");
    if (txtEl && sel) {
      var r2 = document.createRange();
      r2.selectNodeContents(txtEl);
      sel.removeAllRanges();
      sel.addRange(r2);
    }

    n.html = ed.innerHTML;
    n.updatedAt = Date.now();
    updateStats();
    scheduleSave();
  }

  function insertTimestamp() {
    var loc = state.settings.lang === "en" ? "en-US" : "ru-RU";
    var stamp = new Date().toLocaleString(loc, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    });
    var n = getActiveNote();
    if (!n) return;
    if (n.mode === "txt") {
      var ta = document.getElementById("plainTextarea");
      var s = ta.selectionStart || 0;
      var e = ta.selectionEnd || 0;
      ta.value = ta.value.slice(0, s) + stamp + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + stamp.length;
      n.plain = ta.value;
      updateLineNumbers();
      updateMarkdownPreview();
    } else {
      var ed = document.getElementById("richEditor");
      ed.focus();
      document.execCommand("insertText", false, stamp);
      n.html = ed.innerHTML;
    }
    n.updatedAt = Date.now();
    markNoteDirty(n, true);
    updateStats();
    scheduleSave();
  }

  /* -------------------- Find & Replace -------------------- */
  var findIdx = 0;

  function runFind(dir) {
    var q = document.getElementById("findInput").value;
    var countEl = document.getElementById("findCount");
    var cs = document.getElementById("btnFindCase").classList.contains("active");
    if (!q) { countEl.textContent = "0/0"; return; }

    var n = getActiveNote();
    var text = getNotePlainText(n);
    var hay = cs ? text : text.toLowerCase();
    var needle = cs ? q : q.toLowerCase();
    var matches = [];
    var pos = 0;
    while (needle.length) {
      var i = hay.indexOf(needle, pos);
      if (i === -1) break;
      matches.push(i);
      pos = i + needle.length;
    }
    if (!matches.length) { countEl.textContent = "0/0"; return; }

    if (dir === "next") findIdx = (findIdx + 1) % matches.length;
    else if (dir === "prev") findIdx = (findIdx - 1 + matches.length) % matches.length;
    else if (findIdx >= matches.length) findIdx = 0;

    countEl.textContent = (findIdx + 1) + "/" + matches.length;
    if (n.mode === "txt") {
      var ta = document.getElementById("plainTextarea");
      ta.focus();
      ta.setSelectionRange(matches[findIdx], matches[findIdx] + q.length);
    } else if (typeof window.find === "function") {
      window.find(q, cs, dir === "prev", true, false, false, false);
    }
  }

  function runReplace(all) {
    var q = document.getElementById("findInput").value;
    var repl = document.getElementById("replaceInput").value;
    var cs = document.getElementById("btnFindCase").classList.contains("active");
    if (!q) return;

    var n = getActiveNote();
    var rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), cs ? (all ? "g" : "") : (all ? "gi" : "i"));

    if (n.mode === "txt") {
      var ta = document.getElementById("plainTextarea");
      ta.value = ta.value.replace(rx, repl);
      n.plain = ta.value;
      updateLineNumbers();
      updateMarkdownPreview();
    } else {
      var ed = document.getElementById("richEditor");
      var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null, false);
      var doneOne = false;
      var node;
      while ((node = walker.nextNode())) {
        if (!all && doneOne) break;
        if (rx.test(node.nodeValue)) {
          node.nodeValue = node.nodeValue.replace(rx, repl);
          doneOne = true;
        }
      }
      n.html = ed.innerHTML;
    }
    n.updatedAt = Date.now();
    markNoteDirty(n, true);
    renderNotesList();
    updateStats();
    runFind("stay");
    scheduleSave();
  }

  /* -------------------- File Import & Export -------------------- */
  function downloadBlob(name, content, mime) {
    var blob = new Blob([content], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 180);
  }

  function safeFilename(title, ext) {
    var raw = (title || t("untitled")).replace(/[\\/:*?"<>|]+/g, "_").trim() || "note";
    if (ext && raw.toLowerCase().slice(-ext.length) === ext.toLowerCase()) {
      return raw.slice(0, 80);
    }
    return raw.slice(0, 64) + (ext || ".txt");
  }

  function getVerbatimSaveText(n) {
    if (!n) return "";
    if (n.mode === "txt") return String(n.plain || "");
    if (n.fileExt === ".md" || n.fileExt === ".markdown") return htmlToMarkdown(n.html || "");
    return getNotePlainText(n);
  }

  function openDiskFileObject(fObj) {
    if (!fObj || typeof fObj !== "object") return;
    var diskPath = String(fObj.path || "");
    var name = String(fObj.name || "Untitled.txt");
    var ext = String(fObj.ext || "").toLowerCase();
    if (!ext && name.indexOf(".") !== -1) {
      ext = "." + name.split(".").pop().toLowerCase();
    }
    var enc = String(fObj.encoding || "UTF-8");
    var content = String(fObj.content || "");

    if (diskPath) {
      var lowTarget = diskPath.toLowerCase();
      for (var i = 0; i < state.notes.length; i++) {
        var existing = state.notes[i];
        if (!existing.trashed && existing.diskPath && existing.diskPath.toLowerCase() === lowTarget) {
          existing.title = name;
          existing.mode = "txt";
          existing.plain = content;
          existing.fileExt = ext;
          existing.encoding = enc;
          existing.isDirty = false;
          existing.updatedAt = Date.now();
          syncNativeDirtyFlag();
          openNote(existing.id);
          return;
        }
      }
    }

    createNewNote({
      title: name,
      mode: "txt",
      plain: content,
      diskPath: diskPath,
      fileExt: ext,
      encoding: enc,
      folderId: ""
    });
  }

  function pullPendingNativeFiles() {
    if (isNativeExe && typeof window.__gnNativePullFiles === "function") {
      Promise.resolve(window.__gnNativePullFiles()).then(function (raw) {
        var list = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(list) && list.length) {
          list.forEach(openDiskFileObject);
        }
      }).catch(function () {});
    } else if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      fetch("/api/pending-files", { method: "GET" })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (list) {
          if (Array.isArray(list) && list.length) list.forEach(openDiskFileObject);
        })
        .catch(function () {});
    }
  }
  window.__gnPullPendingFiles = pullPendingNativeFiles;

  function triggerOpenFileAction() {
    if (isNativeExe && typeof window.__gnNativeOpenDialog === "function") {
      Promise.resolve(window.__gnNativeOpenDialog(state.settings.lang || "ru")).then(function (raw) {
        var list = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(list) && list.length) {
          list.forEach(openDiskFileObject);
        }
      }).catch(function () {});
      return;
    }
    document.getElementById("openNoteFileInput").click();
  }

  function saveActiveNoteAs() {
    var n = getActiveNote();
    if (!n) return;
    var defaultExt = n.fileExt || (n.mode === "txt" ? ".txt" : ".md");
    var suggested = safeFilename(n.title || t("untitled"), defaultExt);
    var bodyText = getVerbatimSaveText(n);
    var enc = n.encoding || "UTF-8";

    if (isNativeExe && typeof window.__gnNativeSaveAsDialog === "function") {
      Promise.resolve(window.__gnNativeSaveAsDialog(suggested, bodyText, enc, state.settings.lang || "ru"))
        .then(function (raw) {
          var res = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (res && res.ok) {
            n.diskPath = res.path || n.diskPath;
            if (res.name) n.title = res.name;
            if (res.ext) n.fileExt = String(res.ext).toLowerCase();
            if (res.encoding) n.encoding = res.encoding;
            n.updatedAt = Date.now();
            markNoteDirty(n, false);
            document.getElementById("noteTitleInput").value = n.title || "";
            renderTabs();
            renderNotesList();
            syncEditorModeLabels();
            scheduleSave();
            showToast(t("toastDirectSaved"));
          }
        })
        .catch(function () {});
      return;
    }

    markNoteDirty(n, false);
    downloadBlob(suggested, bodyText, "text/plain");
    showToast(t("toastSaved"));
  }

  function saveActiveNoteDirect() {
    var n = getActiveNote();
    if (!n) return;

    if (isNativeExe && n.diskPath && typeof window.__gnNativeSaveDirect === "function") {
      var bodyText = getVerbatimSaveText(n);
      Promise.resolve(window.__gnNativeSaveDirect(n.diskPath, bodyText, n.encoding || "UTF-8"))
        .then(function (raw) {
          var res = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (res && res.ok) {
            n.updatedAt = Date.now();
            markNoteDirty(n, false);
            syncEditorModeLabels();
            scheduleSave();
            showToast(t("toastDirectSaved"));
          } else {
            saveActiveNoteAs();
          }
        })
        .catch(function () { saveActiveNoteAs(); });
      return;
    }

    if (isNativeExe && typeof window.__gnNativeSaveAsDialog === "function") {
      saveActiveNoteAs();
      return;
    }

    if (n.fileExt) {
      markNoteDirty(n, false);
      downloadBlob(safeFilename(n.title || t("untitled"), n.fileExt), getVerbatimSaveText(n), "text/plain");
      showToast(t("toastSaved"));
      return;
    }

    exportActiveNote(n.mode === "txt" ? "txt" : "md");
  }

  function exportActiveNote(fmt) {
    var n = getActiveNote();
    if (!n) return;
    var title = n.title || t("untitled");
    if (fmt === "txt") {
      var txt = (n.mode === "txt" || n.diskPath || n.fileExt)
        ? String(n.plain || "").replace(/\r?\n/g, "\r\n")
        : ((n.title ? n.title + "\r\n\r\n" : "") + getNotePlainText(n).replace(/\r?\n/g, "\r\n"));
      downloadBlob(safeFilename(title, ".txt"), txt, "text/plain");
    } else if (fmt === "md") {
      var md = n.mode === "txt"
        ? (n.plain || "")
        : ((n.title ? "# " + n.title + "\n\n" : "") + htmlToMarkdown(n.html || ""));
      downloadBlob(safeFilename(title, ".md"), md, "text/markdown");
    } else if (fmt === "html") {
      var body = n.mode === "txt" ? markdownToHtml(n.plain || "") : (n.html || "");
      var doc = "<!DOCTYPE html><html lang=\"" + state.settings.lang + "\"><head><meta charset=\"UTF-8\"><title>" + escapeHtml(title) +
        "</title><style>body{font-family:system-ui,sans-serif;max-width:740px;margin:40px auto;padding:0 20px;line-height:1.68;color:#18191c}pre{background:#f4f4f5;padding:12px;border-radius:7px;overflow:auto}</style></head><body><h1>" +
        escapeHtml(title) + "</h1>" + body + "</body></html>";
      downloadBlob(safeFilename(title, ".html"), doc, "text/html");
    }
    markNoteDirty(n, false);
    showToast(t("toastSaved"));
  }

  function saveSingleNoteBeforeExit(n) {
    if (!n) return Promise.resolve(true);
    var defaultExt = n.fileExt || (n.mode === "txt" ? ".txt" : ".md");
    var suggested = safeFilename(n.title || t("untitled"), defaultExt);
    var bodyText = getVerbatimSaveText(n);
    var enc = n.encoding || "UTF-8";

    if (isNativeExe && n.diskPath && typeof window.__gnNativeSaveDirect === "function") {
      return Promise.resolve(window.__gnNativeSaveDirect(n.diskPath, bodyText, enc))
        .then(function (raw) {
          var res = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (res && res.ok) {
            n.updatedAt = Date.now();
            markNoteDirty(n, false);
            return true;
          }
          if (typeof window.__gnNativeSaveAsDialog === "function") {
            return Promise.resolve(window.__gnNativeSaveAsDialog(suggested, bodyText, enc, state.settings.lang || "ru"))
              .then(function (r2) {
                var res2 = typeof r2 === "string" ? JSON.parse(r2) : r2;
                if (res2 && res2.ok) {
                  n.diskPath = res2.path || n.diskPath;
                  if (res2.name) n.title = res2.name;
                  if (res2.ext) n.fileExt = String(res2.ext).toLowerCase();
                  if (res2.encoding) n.encoding = res2.encoding;
                  n.updatedAt = Date.now();
                  markNoteDirty(n, false);
                  return true;
                }
                return false;
              });
          }
          return false;
        })
        .catch(function () { return false; });
    }

    if (isNativeExe && typeof window.__gnNativeSaveAsDialog === "function") {
      return Promise.resolve(window.__gnNativeSaveAsDialog(suggested, bodyText, enc, state.settings.lang || "ru"))
        .then(function (raw) {
          var res = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (res && res.ok) {
            n.diskPath = res.path || n.diskPath;
            if (res.name) n.title = res.name;
            if (res.ext) n.fileExt = String(res.ext).toLowerCase();
            if (res.encoding) n.encoding = res.encoding;
            n.updatedAt = Date.now();
            markNoteDirty(n, false);
            return true;
          }
          return false;
        })
        .catch(function () { return false; });
    }

    downloadBlob(suggested, bodyText, "text/plain");
    markNoteDirty(n, false);
    return Promise.resolve(true);
  }

  function closeUnsavedModal() {
    var modal = document.getElementById("unsavedCloseModal");
    if (modal) modal.classList.remove("open");
  }

  function performImmediateAppExit() {
    closeUnsavedModal();
    if (isNativeExe && typeof window.__gnWinCmd === "function") {
      window.__gnWinCmd("forceClose");
    } else {
      try { window.close(); } catch (e) {}
    }
  }

  function requestAppClose() {
    closeMenus();
    var dirtyList = getUnsavedNotes();
    if (!dirtyList.length) {
      flushPortableSave();
      performImmediateAppExit();
      return;
    }

    var descEl = document.getElementById("unsavedModalDesc");
    if (descEl) {
      var names = dirtyList.slice(0, 3).map(function (n) {
        return "«" + ((n.title || "").trim() || t("untitled")) + "»";
      }).join(", ");
      if (dirtyList.length > 3) names += " (+" + (dirtyList.length - 3) + ")";
      descEl.textContent = t("unsavedModalDescNamed") + names;
    }
    var modal = document.getElementById("unsavedCloseModal");
    if (modal) modal.classList.add("open");
  }
  window.__gnRequestAppClose = requestAppClose;

  function exportBackupJson() {
    var d = new Date().toISOString().slice(0, 10);
    downloadBlob("Graphite-Backup-" + d + ".json", JSON.stringify(state, null, 2), "application/json");
    showToast(t("toastBackupSaved"));
  }

  function decodeBufferWithBomAndAnsi(buf) {
    var bytes = new Uint8Array(buf || new ArrayBuffer(0));
    var enc = "UTF-8";
    var text = "";
    try {
      if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        enc = "UTF-8 BOM";
        text = new TextDecoder("utf-8").decode(bytes.subarray(3));
      } else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        enc = "UTF-16LE";
        text = new TextDecoder("utf-16le").decode(bytes.subarray(2));
      } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        enc = "UTF-16BE";
        text = new TextDecoder("utf-16be").decode(bytes.subarray(2));
      } else {
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          enc = "UTF-8";
        } catch (utfErr) {
          enc = "ANSI";
          text = new TextDecoder("windows-1251").decode(bytes);
        }
      }
    } catch (e) {
      text = new TextDecoder("utf-8").decode(bytes);
    }
    return { text: text.replace(/\0/g, " "), encoding: enc };
  }

  function handleImportedFile(file, asDatabaseBackup) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      var decoded = decodeBufferWithBomAndAnsi(ev.target.result);
      var content = decoded.text;
      var name = file.name || "Note.txt";
      var lower = name.toLowerCase();
      var ext = name.indexOf(".") !== -1 ? ("." + name.split(".").pop().toLowerCase()) : "";

      if (asDatabaseBackup && lower.endsWith(".json")) {
        try {
          var parsed = JSON.parse(content);
          if (parsed && Array.isArray(parsed.notes)) {
            hydrateState(parsed);
            applyAppearance();
            applyLocalization();
            loadActiveNoteIntoEditor();
            scheduleSave();
            showToast(t("toastBackupLoaded"));
            return;
          }
        } catch (e) {}
      }

      createNewNote({
        title: name,
        mode: "txt",
        plain: content,
        fileExt: ext,
        encoding: decoded.encoding,
        folderId: ""
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function linkPortableFile() {
    if (typeof window.showSaveFilePicker === "function") {
      window.showSaveFilePicker({
        suggestedName: "Graphite-DB.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }]
      }).then(function (h) {
        linkedFileHandle = h;
        updatePortableStatusLabel();
        flushPortableSave();
        showToast(t("toastLinkedDb"));
      }).catch(function () {});
    } else {
      exportBackupJson();
    }
  }

  /* -------------------- Menus & Events -------------------- */
  function closeMenus() {
    document.querySelectorAll(".dropdown-menu.open").forEach(function (m) { m.classList.remove("open"); });
    document.querySelectorAll(".menu-trigger.open").forEach(function (b) { b.classList.remove("open"); });
  }

  function refreshDefaultNotepadBadge() {
    var badge = document.getElementById("notepadDefaultBadge");
    if (!badge || !isNativeExe || typeof window.__gnNativeNotepadAssoc !== "function") return;
    Promise.resolve(window.__gnNativeNotepadAssoc("status")).then(function (raw) {
      var res = typeof raw === "string" ? JSON.parse(raw) : raw;
      badge.style.display = (res && res.isDefault) ? "inline-flex" : "none";
    }).catch(function () {});
  }

  var activeSettingsTab = "general";

  function setActiveSettingsTab(tabName) {
    activeSettingsTab = tabName === "languages" ? "languages" : "general";
    document.querySelectorAll("#settingsTopTabs [data-settings-tab]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-settings-tab") === activeSettingsTab);
    });
    document.querySelectorAll("#settingsDialog [data-settings-pane]").forEach(function (p) {
      p.classList.toggle("active", p.getAttribute("data-settings-pane") === activeSettingsTab);
    });
  }

  function renderLangCardsGrid(filterText) {
    var grid = document.getElementById("langCardsGrid");
    if (!grid) return;
    var q = String(filterText || "").trim().toLowerCase();
    var list = window.GRAPHITE_LANG_LIST || [];
    var isAuto = state.settings.langMode !== "manual";
    var curLang = state.settings.lang || "ru";
    var sysLang = detectSystemUiLanguage();
    grid.innerHTML = "";

    var autoLabel = t("langAuto");
    var autoSub = t("langAutoSub") + " (" + sysLang.toUpperCase() + ")";
    if (!q || ("auto авто " + autoLabel + " " + autoSub).toLowerCase().indexOf(q) !== -1) {
      var autoBtn = document.createElement("button");
      autoBtn.type = "button";
      autoBtn.className = "lang-card" + (isAuto ? " active" : "");
      autoBtn.setAttribute("data-lang-card", "auto");
      autoBtn.innerHTML =
        '<div class="lang-card-main">' +
        '<span class="lang-code-badge">AUTO</span>' +
        '<div class="lang-names">' +
        '<span class="lang-native">' + escapeHtml(autoLabel) + "</span>" +
        '<span class="lang-sub">' + escapeHtml(autoSub) + "</span>" +
        "</div>" +
        "</div>" +
        '<span class="lang-check">✓</span>';
      grid.appendChild(autoBtn);
    }

    list.forEach(function (item) {
      if (q) {
        var hay = (item.code + " " + item.badge + " " + item.native + " " + item.sub).toLowerCase();
        if (hay.indexOf(q) === -1) return;
      }
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lang-card" + (!isAuto && item.code === curLang ? " active" : "");
      btn.setAttribute("data-lang-card", item.code);
      btn.innerHTML =
        '<div class="lang-card-main">' +
        '<span class="lang-code-badge">' + escapeHtml(item.badge) + "</span>" +
        '<div class="lang-names">' +
        '<span class="lang-native">' + escapeHtml(item.native) + "</span>" +
        '<span class="lang-sub">' + escapeHtml(item.sub) + "</span>" +
        "</div>" +
        "</div>" +
        '<span class="lang-check">✓</span>';
      grid.appendChild(btn);
    });
  }

  function openSettings(initialTab) {
    closeMenus();
    refreshDefaultNotepadBadge();
    renderLangCardsGrid(document.getElementById("langSearchInput") ? document.getElementById("langSearchInput").value : "");
    setActiveSettingsTab(initialTab === "languages" ? "languages" : "general");
    document.getElementById("settingsModal").classList.add("open");
  }

  function closeSettings() {
    document.getElementById("settingsModal").classList.remove("open");
    var flBtn = document.getElementById("btnFloweySecret");
    if (flBtn) flBtn.classList.remove("jarona-active", "talking");
  }

  function syncMaximizeState() {
    if (!isNativeExe || typeof window.__gnWinCmd !== "function") return;
    Promise.resolve(window.__gnWinCmd("isMax")).then(function (isMax) {
      var maximized = isMax === true || isMax === "true";
      document.documentElement.setAttribute("data-maximized", maximized ? "true" : "false");
      var wrap = document.getElementById("winMaxIconWrap");
      if (wrap) {
        wrap.innerHTML = maximized
          ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1.2h5.8V7" stroke="currentColor" stroke-width="1.15"/><rect x="1.2" y="3" width="5.8" height="5.8" rx="1" stroke="currentColor" stroke-width="1.15"/></svg>'
          : '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1.2" stroke="currentColor" stroke-width="1.2"/></svg>';
      }
    }).catch(function () {});
  }

  function setShowFolders(val) {
    state.settings.showFolders = !!val;
    if (!state.settings.showFolders && state.activeFilter && state.activeFilter !== "all") {
      state.activeFilter = "all";
    }
    applyAppearance();
    renderNotesList();
    scheduleSave();
  }

  function bindEvents() {
    /* Native Frameless Titlebar Drag, Maximize/Restore & 8-Edge Resize */
    var customTitlebar = document.getElementById("customTitlebar");
    customTitlebar.addEventListener("mousedown", function (e) {
      if (!isNativeExe || e.button !== 0) return;
      if (e.target.closest("button, .tab, input, select")) return;
      e.preventDefault();
      if (typeof window.__gnWinCmd === "function") {
        window.__gnWinCmd("drag");
      }
    });
    customTitlebar.addEventListener("dblclick", function (e) {
      if (!isNativeExe) return;
      if (e.target.closest("button, .tab, input, select")) return;
      if (typeof window.__gnWinCmd === "function") {
        window.__gnWinCmd("toggleMax");
        setTimeout(syncMaximizeState, 80);
      }
    });

    document.getElementById("btnWinMin").addEventListener("click", function () {
      if (typeof window.__gnWinCmd === "function") window.__gnWinCmd("min");
    });
    document.getElementById("btnWinMax").addEventListener("click", function () {
      if (typeof window.__gnWinCmd === "function") {
        window.__gnWinCmd("toggleMax");
        setTimeout(syncMaximizeState, 80);
      }
    });
    document.getElementById("btnWinClose").addEventListener("click", function () {
      requestAppClose();
    });

    var unsavedCloseModal = document.getElementById("unsavedCloseModal");
    if (unsavedCloseModal) {
      unsavedCloseModal.addEventListener("click", function (e) {
        if (e.target === unsavedCloseModal) closeUnsavedModal();
      });
    }
    var btnUnsavedContinue = document.getElementById("btnUnsavedContinue");
    if (btnUnsavedContinue) {
      btnUnsavedContinue.addEventListener("click", function () {
        closeUnsavedModal();
      });
    }
    var btnUnsavedSaveExit = document.getElementById("btnUnsavedSaveExit");
    if (btnUnsavedSaveExit) {
      btnUnsavedSaveExit.addEventListener("click", function () {
        var dirtyList = getUnsavedNotes().slice();
        btnUnsavedSaveExit.disabled = true;
        var chain = Promise.resolve(true);
        dirtyList.forEach(function (note) {
          chain = chain.then(function (okSoFar) {
            if (!okSoFar) return false;
            return saveSingleNoteBeforeExit(note);
          });
        });
        chain.then(function (allSaved) {
          btnUnsavedSaveExit.disabled = false;
          if (!allSaved) return; /* User cancelled Save-As dialog — stay open */
          renderTabs();
          renderNotesList();
          syncEditorModeLabels();
          flushPortableSave();
          performImmediateAppExit();
        });
      });
    }
    var btnUnsavedDiscardExit = document.getElementById("btnUnsavedDiscardExit");
    if (btnUnsavedDiscardExit) {
      btnUnsavedDiscardExit.addEventListener("click", function () {
        state.notes.forEach(function (n) { if (n) n.isDirty = false; });
        syncNativeDirtyFlag();
        renderTabs();
        performImmediateAppExit();
      });
    }

    window.addEventListener("beforeunload", function (e) {
      if (!isNativeExe && getUnsavedNotes().length > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    document.getElementById("winResizeRing").addEventListener("mousedown", function (e) {
      if (!isNativeExe || e.button !== 0) return;
      var edge = e.target.closest("[data-rz]");
      if (edge && typeof window.__gnWinResize === "function") {
        e.preventDefault();
        window.__gnWinResize(edge.getAttribute("data-rz"));
      }
    });

    var wasNarrowViewport = window.innerWidth <= 740;
    var autoCollapsedByResize = false;

    window.addEventListener("resize", function () {
      syncMaximizeState();
      var nowNarrow = window.innerWidth <= 740;
      if (nowNarrow && !wasNarrowViewport && !state.settings.sidebarCollapsed) {
        state.settings.sidebarCollapsed = true;
        autoCollapsedByResize = true;
        applyAppearance();
      } else if (!nowNarrow && wasNarrowViewport && autoCollapsedByResize) {
        state.settings.sidebarCollapsed = false;
        autoCollapsedByResize = false;
        applyAppearance();
      }
      wasNarrowViewport = nowNarrow;
    });

    /* Route any external link clicks strictly to User's Default Browser (never Edge) */
    document.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[href]") : null;
      if (a && isNativeExe && typeof window.__gnOpenExternal === "function") {
        var href = a.getAttribute("href") || "";
        if (/^(https?:|mailto:)/i.test(href)) {
          e.preventDefault();
          window.__gnOpenExternal(href);
        }
      }
    });
    /* Menu Triggers (Файл / Правка / Вид) */
    document.querySelectorAll(".menu-trigger").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var menuId = btn.getAttribute("data-menu");
        var menu = document.getElementById(menuId);
        var wasOpen = menu.classList.contains("open");
        closeMenus();
        if (!wasOpen) {
          var rect = btn.getBoundingClientRect();
          menu.classList.add("open");
          var mw = menu.offsetWidth || 224;
          menu.style.top = (rect.bottom + 4) + "px";
          menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + "px";
          menu.style.maxHeight = Math.max(120, window.innerHeight - rect.bottom - 12) + "px";
          btn.classList.add("open");
        }
      });
    });

    document.addEventListener("click", closeMenus);

    /* Sidebar Toggle & New Note */
    document.getElementById("btnToggleSidebar").addEventListener("click", function () {
      autoCollapsedByResize = false;
      state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
      applyAppearance();
      scheduleSave();
    });
    document.getElementById("sidebarBackdrop").addEventListener("click", function () {
      state.settings.sidebarCollapsed = true;
      applyAppearance();
    });

    document.getElementById("btnNewNoteSidebar").addEventListener("click", function () { createNewNote(); });
    document.getElementById("btnNewTab").addEventListener("click", function () { createNewNote(); });

    /* Search */
    var searchInput = document.getElementById("searchInput");
    var btnClearSearch = document.getElementById("btnClearSearch");
    searchInput.addEventListener("input", function () {
      btnClearSearch.classList.toggle("visible", !!searchInput.value);
      renderNotesList();
    });
    btnClearSearch.addEventListener("click", function () {
      searchInput.value = "";
      btnClearSearch.classList.remove("visible");
      renderNotesList();
    });

    /* Folders */
    document.getElementById("btnToggleNewFolder").addEventListener("click", function () {
      var box = document.getElementById("newFolderBox");
      box.classList.toggle("open");
      if (box.classList.contains("open")) document.getElementById("newFolderInput").focus();
    });

    function addFolder() {
      var inp = document.getElementById("newFolderInput");
      var name = inp.value.trim();
      if (!name) return;
      var id = uid("fld");
      state.folders.push({ id: id, name: name });
      inp.value = "";
      document.getElementById("newFolderBox").classList.remove("open");
      state.activeFilter = "folder:" + id;
      renderFolders();
      renderNotesList();
      scheduleSave();
    }

    document.getElementById("btnCreateFolder").addEventListener("click", addFolder);
    document.getElementById("newFolderInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") addFolder();
    });

    document.getElementById("foldersList").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del-folder]");
      if (del) {
        e.stopPropagation();
        var fid = del.getAttribute("data-del-folder");
        state.folders = state.folders.filter(function (f) { return f.id !== fid; });
        state.notes.forEach(function (n) { if (n.folderId === fid) n.folderId = ""; });
        if (state.activeFilter === "folder:" + fid) state.activeFilter = "all";
        renderFolders();
        renderNotesList();
        scheduleSave();
        return;
      }
      var row = e.target.closest("[data-filter]");
      if (row) {
        state.activeFilter = row.getAttribute("data-filter");
        renderFolders();
        renderNotesList();
        scheduleSave();
      }
    });

    /* Notes List Click & Right-Click Context Menu */
    var notesList = document.getElementById("notesList");
    notesList.addEventListener("click", function (e) {
      var row = e.target.closest("[data-note-id]");
      if (row) openNote(row.getAttribute("data-note-id"));
    });

    notesList.addEventListener("contextmenu", function (e) {
      var row = e.target.closest("[data-note-id]");
      if (!row) return;
      e.preventDefault();
      closeMenus();
      contextTargetNoteId = row.getAttribute("data-note-id");
      var target = getNoteById(contextTargetNoteId);
      document.getElementById("ctxPinLabel").textContent = target && target.pinned ? t("ctxUnpin") : t("ctxPin");
      var ctx = document.getElementById("noteContextMenu");
      ctx.style.top = Math.max(42, Math.min(e.clientY, window.innerHeight - 115)) + "px";
      ctx.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - 185)) + "px";
      ctx.classList.add("open");
    });

    document.getElementById("ctxPinBtn").addEventListener("click", function () {
      var n = getNoteById(contextTargetNoteId);
      if (n) {
        n.pinned = !n.pinned;
        n.updatedAt = Date.now();
        renderFolders();
        renderNotesList();
        syncEditorModeLabels();
        scheduleSave();
      }
    });
    document.getElementById("ctxDupBtn").addEventListener("click", function () { duplicateNoteById(contextTargetNoteId); });
    document.getElementById("ctxDelBtn").addEventListener("click", function () { moveNoteToTrash(contextTargetNoteId); });

    /* Tabs */
    var tabsStrip = document.getElementById("tabsStrip");
    tabsStrip.addEventListener("wheel", function (e) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        tabsStrip.scrollLeft += e.deltaY * 0.7;
        e.preventDefault();
      }
    }, { passive: false });
    tabsStrip.addEventListener("click", function (e) {
      var x = e.target.closest("[data-close-tab]");
      if (x) { e.stopPropagation(); closeTab(x.getAttribute("data-close-tab")); return; }
      var tab = e.target.closest("[data-tab-id]");
      if (tab) openNote(tab.getAttribute("data-tab-id"));
    });
    tabsStrip.addEventListener("auxclick", function (e) {
      if (e.button === 1) {
        var tab = e.target.closest("[data-tab-id]");
        if (tab) { e.preventDefault(); closeTab(tab.getAttribute("data-tab-id")); }
      }
    });
    tabsStrip.addEventListener("dblclick", function (e) {
      if (e.target.closest("[data-close-tab]")) return;
      var tab = e.target.closest("[data-tab-id]");
      if (!tab) return;
      e.stopPropagation();
      var note = getNoteById(tab.getAttribute("data-tab-id"));
      if (!note) return;
      var nextTitle = window.prompt(t("promptRenameNote"), note.title || "");
      if (nextTitle !== null) {
        note.title = nextTitle;
        note.updatedAt = Date.now();
        markNoteDirty(note, true);
        if (note.id === state.activeNoteId) {
          document.getElementById("noteTitleInput").value = note.title || "";
        }
        renderTabs();
        renderNotesList();
        scheduleSave();
      }
    });

    function setViewLayout(mode) {
      state.settings.viewLayout = mode === "compact" ? "compact" : "full";
      applyAppearance();
      scheduleSave();
    }

    function toggleViewLayout() {
      setViewLayout(state.settings.viewLayout === "compact" ? "full" : "compact");
    }

    /* Quick Topbar Controls */
    var btnQuickView = document.getElementById("btnQuickView");
    if (btnQuickView) {
      btnQuickView.addEventListener("click", toggleViewLayout);
    }

    document.getElementById("btnQuickLang").addEventListener("click", function () {
      openSettings("languages");
    });

    document.getElementById("btnQuickTheme").addEventListener("click", function () {
      var cur = resolveEffectiveTheme();
      if (state.settings.easterEggsEnabled && state.settings.floweyUnlocked) {
        if (cur === "dark") {
          state.settings.themeMode = "light";
        } else if (cur === "light") {
          if (state.settings.scene && state.settings.scene !== "flowey_garden") {
            state.settings.lastNormalScene = state.settings.scene;
          }
          state.settings.themeMode = "flowey";
          state.settings.scene = "flowey_garden";
          state.settings.accent = "gold";
          state.settings.wallpaperDataUrl = "";
          state.settings.material = "blur";
        } else {
          state.settings.themeMode = "dark";
          if (state.settings.scene === "flowey_garden") {
            state.settings.scene = state.settings.lastNormalScene || "web_galaxy";
          }
        }
      } else {
        state.settings.themeMode = cur === "dark" ? "light" : "dark";
      }
      applyAppearance();
      scheduleSave();
    });

    document.getElementById("btnOpenSettings").addEventListener("click", function () { openSettings("general"); });
    document.getElementById("btnCloseSettings").addEventListener("click", closeSettings);
    document.getElementById("settingsModal").addEventListener("click", function (e) {
      if (e.target.id === "settingsModal") closeSettings();
    });

    /* Dropdown Menu Actions */
    var openFileInp = document.getElementById("openNoteFileInput");
    var importDbInp = document.getElementById("importBackupInput");

    document.getElementById("mNewNote").addEventListener("click", function () { createNewNote(); });
    document.getElementById("mOpenFile").addEventListener("click", function () { triggerOpenFileAction(); });
    document.getElementById("mDuplicate").addEventListener("click", function () { duplicateNoteById(); });
    document.getElementById("mSaveDirect").addEventListener("click", function () { saveActiveNoteDirect(); });
    document.getElementById("mSaveAs").addEventListener("click", function () { saveActiveNoteAs(); });
    document.getElementById("mSaveTxt").addEventListener("click", function () { exportActiveNote("txt"); });
    document.getElementById("mSaveMd").addEventListener("click", function () { exportActiveNote("md"); });
    document.getElementById("mExportHtml").addEventListener("click", function () { exportActiveNote("html"); });
    document.getElementById("mPrint").addEventListener("click", function () { window.print(); });
    document.getElementById("mExportBackup").addEventListener("click", exportBackupJson);
    document.getElementById("mImportBackup").addEventListener("click", function () { importDbInp.click(); });
    document.getElementById("mLinkDb").addEventListener("click", linkPortableFile);
    document.getElementById("mOpenBrowser").addEventListener("click", function () {
      if (isNativeExe && typeof window.__gnOpenExternal === "function") {
        window.__gnOpenExternal("__APP__");
      } else {
        window.open(window.location.href, "_blank");
      }
    });
    document.getElementById("mMoveTrash").addEventListener("click", function () { moveNoteToTrash(); });

    document.getElementById("mUndo").addEventListener("click", function () { document.execCommand("undo"); });
    document.getElementById("mRedo").addEventListener("click", function () { document.execCommand("redo"); });
    document.getElementById("mFind").addEventListener("click", function () {
      document.getElementById("findBar").classList.add("open");
      document.getElementById("findInput").focus();
      runFind("stay");
    });
    document.getElementById("mTimestamp").addEventListener("click", insertTimestamp);
    document.getElementById("mClearFmt").addEventListener("click", function () {
      var ed = document.getElementById("richEditor");
      ed.focus();
      document.execCommand("removeFormat");
    });

    var mToggleViewLayout = document.getElementById("mToggleViewLayout");
    if (mToggleViewLayout) {
      mToggleViewLayout.addEventListener("click", toggleViewLayout);
    }

    document.getElementById("mToggleSidebar").addEventListener("click", function () {
      if (state.settings.viewLayout === "compact") {
        state.settings.viewLayout = "full";
        state.settings.sidebarCollapsed = false;
      } else {
        state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
      }
      applyAppearance();
      scheduleSave();
    });
    document.getElementById("mToggleFolders").addEventListener("click", function () {
      setShowFolders(state.settings.showFolders === false);
    });
    document.getElementById("mSwitchMode").addEventListener("click", toggleEditorMode);
    document.getElementById("mWordWrap").addEventListener("click", function () {
      state.settings.wordWrap = !state.settings.wordWrap;
      applyAppearance();
      scheduleSave();
    });
    document.getElementById("mFullWidth").addEventListener("click", function () {
      state.settings.wideMode = !state.settings.wideMode;
      applyAppearance();
      scheduleSave();
    });
    document.querySelectorAll("[data-set-mat]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.settings.material = b.getAttribute("data-set-mat");
        applyAppearance();
        scheduleSave();
      });
    });
    document.getElementById("mOpenSettings").addEventListener("click", function () { openSettings("general"); });

    openFileInp.addEventListener("change", function (e) {
      if (e.target.files && e.target.files.length) {
        for (var fi = 0; fi < e.target.files.length; fi++) {
          handleImportedFile(e.target.files[fi], false);
        }
      }
      openFileInp.value = "";
    });
    importDbInp.addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) handleImportedFile(e.target.files[0], true);
      importDbInp.value = "";
    });

    /* Formatting Strip */
    document.getElementById("richToolsGroup").addEventListener("mousedown", function (e) {
      if (e.target.tagName !== "SELECT") e.preventDefault();
    });
    document.getElementById("richToolsGroup").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cmd]");
      if (!btn) return;
      var ed = document.getElementById("richEditor");
      ed.focus();
      document.execCommand(btn.getAttribute("data-cmd"), false, null);
      var n = getActiveNote();
      if (n) { n.html = ed.innerHTML; n.updatedAt = Date.now(); markNoteDirty(n, true); updateStats(); scheduleSave(); }
    });

    document.getElementById("blockFormatSelect").addEventListener("change", function (e) {
      var ed = document.getElementById("richEditor");
      ed.focus();
      document.execCommand("formatBlock", false, "<" + e.target.value + ">");
      var n = getActiveNote();
      if (n) { n.html = ed.innerHTML; n.updatedAt = Date.now(); markNoteDirty(n, true); scheduleSave(); }
    });

    document.getElementById("btnChecklist").addEventListener("click", insertChecklistRow);
    document.getElementById("btnInlineCode").addEventListener("click", function () {
      var ed = document.getElementById("richEditor");
      ed.focus();
      var sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        document.execCommand("insertHTML", false, "<code>" + escapeHtml(sel.toString()) + "</code>");
        var n = getActiveNote();
        if (n) { n.html = ed.innerHTML; n.updatedAt = Date.now(); markNoteDirty(n, true); scheduleSave(); }
      }
    });

    document.getElementById("btnLineNumbers").addEventListener("click", function () {
      state.settings.lineNumbers = !state.settings.lineNumbers;
      applyAppearance();
      scheduleSave();
    });
    document.getElementById("btnMdPreview").addEventListener("click", function () {
      state.settings.mdPreview = !state.settings.mdPreview;
      applyAppearance();
      updateMarkdownPreview();
      scheduleSave();
    });
    document.getElementById("btnModeToggle").addEventListener("click", toggleEditorMode);

    /* Find Bar */
    document.getElementById("btnToggleFind").addEventListener("click", function () {
      var fb = document.getElementById("findBar");
      fb.classList.toggle("open");
      if (fb.classList.contains("open")) { document.getElementById("findInput").focus(); runFind("stay"); }
    });
    document.getElementById("btnCloseFind").addEventListener("click", function () {
      document.getElementById("findBar").classList.remove("open");
    });
    document.getElementById("findInput").addEventListener("input", function () { findIdx = 0; runFind("stay"); });
    document.getElementById("findInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") runFind(e.shiftKey ? "prev" : "next");
      if (e.key === "Escape") document.getElementById("findBar").classList.remove("open");
    });
    document.getElementById("btnFindCase").addEventListener("click", function (e) {
      e.currentTarget.classList.toggle("active");
      runFind("stay");
    });
    document.getElementById("btnFindNext").addEventListener("click", function () { runFind("next"); });
    document.getElementById("btnFindPrev").addEventListener("click", function () { runFind("prev"); });
    document.getElementById("btnReplaceOne").addEventListener("click", function () { runReplace(false); });
    document.getElementById("btnReplaceAll").addEventListener("click", function () { runReplace(true); });

    /* Note Header & Trash */
    document.getElementById("noteTitleInput").addEventListener("input", function (e) {
      var n = getActiveNote();
      if (!n) return;
      n.title = e.target.value;
      n.updatedAt = Date.now();
      n.isDirty = true;
      syncNativeDirtyFlag();
      renderTabs();
      renderNotesList();
      scheduleSave();
    });

    document.getElementById("noteFolderSelect").addEventListener("change", function (e) {
      var n = getActiveNote();
      if (!n) return;
      n.folderId = e.target.value;
      n.updatedAt = Date.now();
      renderFolders();
      renderNotesList();
      scheduleSave();
    });

    document.getElementById("btnPinNote").addEventListener("click", function () {
      var n = getActiveNote();
      if (!n) return;
      n.pinned = !n.pinned;
      n.updatedAt = Date.now();
      syncEditorModeLabels();
      renderFolders();
      renderNotesList();
      scheduleSave();
    });

    document.getElementById("btnRestoreNote").addEventListener("click", function () {
      var n = getActiveNote();
      if (!n) return;
      n.trashed = false;
      n.updatedAt = Date.now();
      syncEditorModeLabels();
      renderFolders();
      renderNotesList();
      scheduleSave();
      showToast(t("toastRestored"));
    });

    document.getElementById("btnDeleteForever").addEventListener("click", function () {
      var n = getActiveNote();
      if (!n) return;
      state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
      state.openTabs = state.openTabs.filter(function (id) { return id !== n.id; });
      if (!state.notes.length) { createNewNote(); return; }
      if (!state.openTabs.length) state.openTabs = [state.notes[0].id];
      state.activeNoteId = state.openTabs[0];
      renderFolders();
      renderNotesList();
      renderTabs();
      loadActiveNoteIntoEditor();
      scheduleSave();
    });

    /* Rich Editor */
    var richEditor = document.getElementById("richEditor");
    richEditor.addEventListener("input", function () {
      var n = getActiveNote();
      if (!n || n.mode !== "rich") return;
      n.html = richEditor.innerHTML;
      n.updatedAt = Date.now();
      markNoteDirty(n, true);
      renderNotesList();
      updateStats();
      scheduleSave();
    });

    richEditor.addEventListener("click", function (e) {
      var box = e.target.closest(".todo-box");
      if (box) {
        var row = box.closest(".todo-row");
        if (row) {
          row.setAttribute("data-checked", row.getAttribute("data-checked") === "true" ? "false" : "true");
          var n = getActiveNote();
          if (n) { n.html = richEditor.innerHTML; n.updatedAt = Date.now(); markNoteDirty(n, true); scheduleSave(); }
        }
      }
    });

    richEditor.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        var sel = window.getSelection();
        if (sel && sel.anchorNode) {
          var el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
          var todoRow = el && el.closest ? el.closest(".todo-row") : null;
          if (todoRow) {
            e.preventDefault();
            var txtEl = todoRow.querySelector(".todo-text");
            if (txtEl && !txtEl.textContent.trim()) {
              var p = document.createElement("p");
              p.innerHTML = "<br>";
              todoRow.parentNode.replaceChild(p, todoRow);
              var r = document.createRange();
              r.setStart(p, 0);
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
            } else {
              var newRow = document.createElement("div");
              newRow.className = "todo-row";
              newRow.setAttribute("data-checked", "false");
              newRow.innerHTML = '<span class="todo-box" contenteditable="false"></span><div class="todo-text"><br></div>';
              todoRow.insertAdjacentElement("afterend", newRow);
              var nt = newRow.querySelector(".todo-text");
              var r2 = document.createRange();
              r2.setStart(nt, 0);
              r2.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r2);
            }
            var n = getActiveNote();
            if (n) { n.html = richEditor.innerHTML; n.updatedAt = Date.now(); markNoteDirty(n, true); scheduleSave(); }
          }
        }
      }
    });

    /* Plain Textarea */
    var plainTa = document.getElementById("plainTextarea");
    plainTa.addEventListener("input", function () {
      var n = getActiveNote();
      if (!n || n.mode !== "txt") return;
      n.plain = plainTa.value;
      n.updatedAt = Date.now();
      markNoteDirty(n, true);
      updateLineNumbers();
      updateMarkdownPreview();
      renderNotesList();
      updateStats();
      scheduleSave();
    });
    plainTa.addEventListener("scroll", function () {
      document.getElementById("lineNumbers").scrollTop = plainTa.scrollTop;
    });
    plainTa.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = plainTa.selectionStart;
        var end = plainTa.selectionEnd;
        plainTa.value = plainTa.value.slice(0, s) + "  " + plainTa.value.slice(end);
        plainTa.selectionStart = plainTa.selectionEnd = s + 2;
        plainTa.dispatchEvent(new Event("input"));
      }
    });

    /* Settings Dialog Controls */
    var settingsTopTabs = document.getElementById("settingsTopTabs");
    if (settingsTopTabs) {
      settingsTopTabs.addEventListener("click", function (e) {
        var b = e.target.closest("[data-settings-tab]");
        if (!b) return;
        setActiveSettingsTab(b.getAttribute("data-settings-tab"));
      });
    }

    var langSearchInput = document.getElementById("langSearchInput");
    if (langSearchInput) {
      langSearchInput.addEventListener("input", function () {
        renderLangCardsGrid(langSearchInput.value);
      });
    }

    var langCardsGrid = document.getElementById("langCardsGrid");
    if (langCardsGrid) {
      renderLangCardsGrid("");
      langCardsGrid.addEventListener("click", function (e) {
        var b = e.target.closest("[data-lang-card]");
        if (!b) return;
        var picked = b.getAttribute("data-lang-card") || "auto";
        if (picked === "auto") {
          state.settings.langMode = "auto";
          state.settings.lang = detectSystemUiLanguage();
        } else {
          state.settings.langMode = "manual";
          state.settings.lang = picked;
        }
        applyAppearance();
        applyLocalization();
        renderLangCardsGrid(langSearchInput ? langSearchInput.value : "");
        scheduleSave();
      });
    }

    var setViewLayoutGroup = document.getElementById("setViewLayoutGroup");
    if (setViewLayoutGroup) {
      setViewLayoutGroup.addEventListener("click", function (e) {
        var b = e.target.closest("[data-view-layout]");
        if (!b) return;
        setViewLayout(b.getAttribute("data-view-layout"));
      });
    }

    document.getElementById("setFoldersGroup").addEventListener("click", function (e) {
      var b = e.target.closest("[data-folders]");
      if (!b) return;
      setShowFolders(b.getAttribute("data-folders") === "on");
    });

    var setFleetwayThemesGroup = document.getElementById("setFleetwayThemesGroup");
    if (setFleetwayThemesGroup) {
      setFleetwayThemesGroup.addEventListener("click", function (e) {
        var b = e.target.closest("[data-fleetway-themes]");
        if (!b) return;
        var enableFw = b.getAttribute("data-fleetway-themes") === "on";
        state.settings.fleetwayThemesEnabled = enableFw;
        if (enableFw) {
          currentMainThemeTab = "fleetway";
          if (!currentFleetwayCat || currentFleetwayCat === "atmos") {
            currentFleetwayCat = "dr5";
          }
        } else {
          if (state.settings.scene !== "flowey_garden" && !getImportedThemeById(state.settings.scene)) {
            if (getBuiltInCategoryForScene(state.settings.scene) !== "atmos") {
              state.settings.scene = "web_galaxy";
            }
          }
        }
        applyThemeTabsFilter();
        applyAppearance();
        scheduleSave();
      });
    }

    var setEasterEggsGroup = document.getElementById("setEasterEggsGroup");
    if (setEasterEggsGroup) {
      setEasterEggsGroup.addEventListener("click", function (e) {
        var b = e.target.closest("[data-easter-eggs]");
        if (!b) return;
        var enableEe = b.getAttribute("data-easter-eggs") === "on";
        state.settings.easterEggsEnabled = enableEe;
        if (!enableEe) {
          if (state.settings.themeMode === "flowey") {
            state.settings.themeMode = "dark";
          }
          if (state.settings.scene === "flowey_garden") {
            var fallback = state.settings.lastNormalScene || "web_galaxy";
            if (!state.settings.fleetwayThemesEnabled && !getImportedThemeById(fallback) && getBuiltInCategoryForScene(fallback) !== "atmos") {
              fallback = "web_galaxy";
            }
            state.settings.scene = fallback;
          }
        }
        applyThemeTabsFilter();
        applyAppearance();
        scheduleSave();
      });
    }

    function selectThemeMode(nextMode) {
      if (!nextMode) return;
      if (nextMode === "flowey") {
        if (state.settings.scene && state.settings.scene !== "flowey_garden") {
          state.settings.lastNormalScene = state.settings.scene;
        }
        state.settings.themeMode = "flowey";
        state.settings.scene = "flowey_garden";
        state.settings.accent = "gold";
        state.settings.wallpaperDataUrl = "";
        state.settings.material = "blur";
      } else {
        state.settings.themeMode = nextMode;
        if (state.settings.scene === "flowey_garden") {
          state.settings.scene = state.settings.lastNormalScene || "web_galaxy";
        }
      }
      applyAppearance();
      scheduleSave();
    }

    document.getElementById("setThemeGroup").addEventListener("click", function (e) {
      var b = e.target.closest("[data-theme-mode]");
      if (b) selectThemeMode(b.getAttribute("data-theme-mode"));
    });

    document.getElementById("setMaterialGroup").addEventListener("click", function (e) {
      var b = e.target.closest("[data-mat]");
      if (!b) return;
      state.settings.material = b.getAttribute("data-mat");
      applyAppearance();
      scheduleSave();
    });

    document.getElementById("accentsSwatches").addEventListener("click", function (e) {
      var b = e.target.closest("[data-accent]");
      if (!b) return;
      state.settings.accent = b.getAttribute("data-accent");
      applyAppearance();
      scheduleSave();
    });

    document.getElementById("customAccentInput").addEventListener("input", function (e) {
      state.settings.accent = "custom";
      state.settings.customAccent = e.target.value;
      applyAppearance();
      scheduleSave();
    });

    var appIconGroup = document.getElementById("appIconGroup");
    if (appIconGroup) {
      appIconGroup.addEventListener("click", function (e) {
        var b = e.target.closest("[data-app-icon]");
        if (!b) return;
        state.settings.appIcon = b.getAttribute("data-app-icon") || "blue";
        applyAppearance();
        scheduleSave();
      });
    }

    var btnDesktopShortcut = document.getElementById("btnDesktopShortcut");
    if (btnDesktopShortcut) {
      if (typeof window.__gnNativeCreateShortcut === "function") {
        btnDesktopShortcut.style.display = "inline-flex";
        btnDesktopShortcut.addEventListener("click", function () {
          window.__gnNativeCreateShortcut(state.settings.appIcon || "blue").then(function (res) {
            if (res && res.ok) showToast(t("toastShortcutSaved"));
          }).catch(function () {});
        });
      }
    }

    document.getElementById("blurRange").addEventListener("input", function (e) {
      var v = parseInt(e.target.value, 10);
      state.settings.blurPx = isNaN(v) ? 22 : v;
      applyAppearance();
      scheduleSave();
    });

    document.getElementById("opacityRange").addEventListener("input", function (e) {
      var v = parseInt(e.target.value, 10);
      state.settings.glassOpacity = isNaN(v) ? 48 : v;
      applyAppearance();
      scheduleSave();
    });

    function normalizeSubfolderName(raw) {
      var s = String(raw || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
      if (!s) return t("defaultSubfolderImport");
      s = s.slice(0, 28);
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function getBuiltInCategoryForScene(sceneId) {
      if (!sceneId) return "atmos";
      if (sceneId === "flowey_garden") return "dr5";
      if (window.INTERNET_THEME_META && window.INTERNET_THEME_META[sceneId] && window.INTERNET_THEME_META[sceneId].category) {
        return window.INTERNET_THEME_META[sceneId].category;
      }
      var el = document.querySelector('#wpGrid .wp-card[data-scene="' + sceneId + '"]');
      if (el) {
        var c = el.getAttribute("data-cat");
        if (c && c !== "custom") return c;
      }
      return "dr5";
    }

    var initImp = getImportedThemeById(state.settings.scene);
    var currentMainThemeTab = initImp ? "custom" : "fleetway";
    var currentFleetwayCat = initImp ? "dr5" : getBuiltInCategoryForScene(state.settings.scene);
    var currentCustomSubfolder = initImp ? normalizeSubfolderName(initImp.folder) : "";

    function collectCustomSubfolders() {
      var counts = {};
      var order = [];
      var addFolder = function (fName) {
        var clean = normalizeSubfolderName(fName);
        if (Object.prototype.hasOwnProperty.call(counts, clean)) return clean;
        counts[clean] = 0;
        order.push(clean);
        return clean;
      };
      var savedFolders = Array.isArray(state.settings.customThemeFolders) ? state.settings.customThemeFolders : [];
      for (var i = 0; i < savedFolders.length; i++) {
        if (savedFolders[i]) addFolder(savedFolders[i]);
      }
      var list = Array.isArray(state.settings.importedThemes) ? state.settings.importedThemes : [];
      for (var j = 0; j < list.length; j++) {
        var it = list[j];
        if (!it || !it.id || !it.dataUrl) continue;
        var f = addFolder(it.folder || t("defaultSubfolderImport"));
        counts[f] = (counts[f] || 0) + 1;
      }
      return { order: order, counts: counts, total: list.length };
    }

    function renderCustomSubfoldersUI() {
      var info = collectCustomSubfolders();
      var badge = document.getElementById("customThemesCountBadge");
      if (badge) {
        badge.textContent = info.total > 0 ? ("(" + info.total + ")") : "";
      }

      var datalist = document.getElementById("customFoldersDatalist");
      if (datalist) {
        datalist.innerHTML = info.order.map(function (f) {
          return '<option value="' + escapeHtml(f) + '"></option>';
        }).join("");
      }

      if (info.order.length > 0) {
        if (!currentCustomSubfolder || info.order.indexOf(currentCustomSubfolder) === -1) {
          currentCustomSubfolder = info.order[0];
        }
      } else {
        currentCustomSubfolder = "";
      }

      var subMount = document.getElementById("customSubfolderTabs");
      if (subMount) {
        subMount.innerHTML = "";
        info.order.forEach(function (fName) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cat-pill subfolder-pill" + (fName === currentCustomSubfolder ? " active" : "");
          btn.setAttribute("data-subfolder", fName);
          btn.innerHTML = '<span>' + escapeHtml(fName) + '</span><span class="subfolder-cnt">' + (info.counts[fName] || 0) + "</span>";
          subMount.appendChild(btn);
        });
      }
      return info;
    }

    function applyThemeTabsFilter() {
      var info = renderCustomSubfoldersUI();
      var fwOn = !!state.settings.fleetwayThemesEnabled;
      var effectiveCat = fwOn ? currentFleetwayCat : "atmos";

      var tabMainFw = document.getElementById("tabMainFleetwayBtn");
      if (tabMainFw) {
        tabMainFw.textContent = fwOn ? t("tabFleetway") : t("catAtmos");
      }

      document.querySelectorAll("#themeMainTabs [data-main-tab]").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-main-tab") === currentMainThemeTab);
      });

      var fleetwayRow = document.getElementById("fleetwaySubTabs");
      var fleetwayDisc = document.getElementById("fleetwayGalleryDisclaimer");
      var customRow = document.getElementById("customSubfoldersRow");
      if (fleetwayRow) fleetwayRow.style.display = (fwOn && currentMainThemeTab === "fleetway") ? "flex" : "none";
      if (fleetwayDisc) fleetwayDisc.style.display = (fwOn && currentMainThemeTab === "fleetway") ? "block" : "none";
      if (customRow) customRow.style.display = currentMainThemeTab === "custom" ? "flex" : "none";

      document.querySelectorAll("#fleetwaySubTabs [data-cat]").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-cat") === effectiveCat);
      });

      var visibleCustomCount = 0;
      document.querySelectorAll("#wpGrid .wp-card").forEach(function (card) {
        var c = card.getAttribute("data-cat") || "atmos";
        var show = false;
        if (currentMainThemeTab === "fleetway") {
          show = (c !== "custom") && (c === effectiveCat);
        } else {
          var sf = card.getAttribute("data-subfolder") || "";
          show = (c === "custom") && (!currentCustomSubfolder || sf === currentCustomSubfolder);
          if (show) visibleCustomCount++;
        }
        card.classList.toggle("cat-hidden", !show);
      });

      var emptyHint = document.getElementById("customThemesEmptyHint");
      if (emptyHint) {
        emptyHint.style.display = (currentMainThemeTab === "custom" && (info.total === 0 || visibleCustomCount === 0)) ? "block" : "none";
      }
    }

    function renderImportedThemesCards() {
      var mount = document.getElementById("importedThemesMount");
      if (!mount) return;
      mount.innerHTML = "";
      var list = Array.isArray(state.settings.importedThemes) ? state.settings.importedThemes : [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item || !item.id || !item.dataUrl) continue;
        var folderName = normalizeSubfolderName(item.folder);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wp-card dr-photo-card";
        btn.setAttribute("data-cat", "custom");
        btn.setAttribute("data-subfolder", folderName);
        btn.setAttribute("data-scene", item.id);
        btn.style.backgroundImage = "url(\"" + item.dataUrl.replace(/"/g, "%22") + "\")";

        var dot = document.createElement("i");
        dot.className = "wp-accent-dot";
        dot.style.background = item.customAccent || "#38bdf8";
        btn.appendChild(dot);

        var del = document.createElement("span");
        del.className = "wp-card-del";
        del.setAttribute("data-del-theme", item.id);
        del.textContent = "✕";
        btn.appendChild(del);

        var lbl = document.createElement("span");
        lbl.textContent = item.name || "Web Theme";
        btn.appendChild(lbl);

        mount.appendChild(btn);
      }
      applyThemeTabsFilter();
      var activeScene = state.settings.scene;
      document.querySelectorAll("#wpGrid .wp-card").forEach(function (b) {
        b.classList.toggle("active", !state.settings.wallpaperDataUrl && b.getAttribute("data-scene") === activeScene);
      });
    }

    /* Extract a crisp vibrant accent hex color from an HTMLImageElement */
    function extractVibrantHexFromImage(img, fallbackHex) {
      try {
        var c = document.createElement("canvas");
        c.width = 48;
        c.height = 32;
        var ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, 48, 32);
        var data = ctx.getImageData(0, 0, 48, 32).data;
        var bestScore = -1;
        var bestR = 56, bestG = 189, bestB = 248;
        for (var i = 0; i < data.length; i += 4) {
          var r = data[i], g = data[i + 1], b = data[i + 2];
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          var d = mx - mn;
          var sat = mx === 0 ? 0 : d / mx;
          var val = mx / 255;
          if (val < 0.22 || val > 0.98 || sat < 0.20) continue;
          var score = sat * 1.4 + val * 0.5;
          if (score > bestScore) {
            bestScore = score;
            bestR = r; bestG = g; bestB = b;
          }
        }
        if (bestScore < 0) return fallbackHex || "#38bdf8";
        /* Ensure good UI contrast brightness */
        var lum = (0.299 * bestR + 0.587 * bestG + 0.114 * bestB) / 255;
        if (lum < 0.35) {
          bestR = Math.min(255, Math.round(bestR * 1.45 + 35));
          bestG = Math.min(255, Math.round(bestG * 1.45 + 35));
          bestB = Math.min(255, Math.round(bestB * 1.45 + 35));
        }
        var toH = function (n) { var s = n.toString(16); return s.length < 2 ? "0" + s : s; };
        return "#" + toH(bestR) + toH(bestG) + toH(bestB);
      } catch (err) {
        return fallbackHex || "#38bdf8";
      }
    }

    function compressImageElementToWebp(img, fallbackHex) {
      var accentHex = extractVibrantHexFromImage(img, fallbackHex);
      var srcW = img.naturalWidth || 1280;
      var srcH = img.naturalHeight || 720;
      var ratio = srcW / Math.max(1, srcH);
      var c = document.createElement("canvas");
      var ctx;
      /* Frame portrait / square / non-widescreen images over a soft blurred backdrop */
      if (ratio < 1.32) {
        var outW = 1280, outH = 720;
        c.width = outW;
        c.height = outH;
        ctx = c.getContext("2d");
        var bgScale = Math.max(outW / srcW, outH / srcH) * 1.12;
        var bw = srcW * bgScale, bh = srcH * bgScale;
        ctx.save();
        try { ctx.filter = "blur(26px) brightness(0.62)"; } catch (e) {}
        ctx.drawImage(img, (outW - bw) * 0.5, (outH - bh) * 0.5, bw, bh);
        ctx.restore();
        ctx.fillStyle = "rgba(8, 10, 18, 0.24)";
        ctx.fillRect(0, 0, outW, outH);
        var fgScale = Math.min(outW / srcW, outH / srcH);
        var fw = srcW * fgScale, fh = srcH * fgScale;
        ctx.drawImage(img, (outW - fw) * 0.5, (outH - fh) * 0.5, fw, fh);
      } else {
        var maxW = 1400;
        var w = srcW, h = srcH;
        if (w > maxW) {
          h = Math.max(1, Math.round(h * (maxW / w)));
          w = maxW;
        }
        c.width = w;
        c.height = h;
        ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
      }
      var dataUrl = c.toDataURL("image/webp", 0.80);
      if (dataUrl.indexOf("data:image/webp") !== 0) {
        dataUrl = c.toDataURL("image/jpeg", 0.84);
      }
      return { dataUrl: dataUrl, accentHex: accentHex };
    }

    function hasLocalNetProxy() {
      return window.location.protocol === "http:" || window.location.protocol === "https:";
    }

    function fetchInternetImageAsThemeData(rawUrl, fallbackHex) {
      return new Promise(function (resolve, reject) {
        var cleanUrl = String(rawUrl || "").trim();
        if (!cleanUrl) { reject(new Error("empty")); return; }

        var loadBlobIntoImg = function (blob) {
          var objUrl = URL.createObjectURL(blob);
          var img = new Image();
          img.onload = function () {
            try {
              var res = compressImageElementToWebp(img, fallbackHex);
              URL.revokeObjectURL(objUrl);
              resolve(res);
            } catch (e) {
              URL.revokeObjectURL(objUrl);
              reject(e);
            }
          };
          img.onerror = function () {
            URL.revokeObjectURL(objUrl);
            reject(new Error("img-decode"));
          };
          img.src = objUrl;
        };

        if (hasLocalNetProxy() && (cleanUrl.indexOf("http://") === 0 || cleanUrl.indexOf("https://") === 0)) {
          fetch("/api/net-image?url=" + encodeURIComponent(cleanUrl))
            .then(function (r) {
              if (!r.ok) throw new Error("proxy-status-" + r.status);
              return r.blob();
            })
            .then(loadBlobIntoImg)
            .catch(reject);
          return;
        }

        /* Standalone file:// HTML fallback: try CORS fetch first, then direct live Image load */
        fetch(cleanUrl)
          .then(function (r) {
            if (!r.ok) throw new Error("direct-status");
            return r.blob();
          })
          .then(loadBlobIntoImg)
          .catch(function () {
            var liveImg = new Image();
            liveImg.onload = function () {
              resolve({ dataUrl: cleanUrl, accentHex: fallbackHex || "#38bdf8" });
            };
            liveImg.onerror = function () { reject(new Error("unreachable")); };
            liveImg.src = cleanUrl;
          });
      });
    }

    function saveAndActivateImportedTheme(name, dataUrl, accentHex, subfolderName) {
      if (!Array.isArray(state.settings.importedThemes)) state.settings.importedThemes = [];
      if (!Array.isArray(state.settings.customThemeFolders)) state.settings.customThemeFolders = [];
      var newId = "imp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
      var cleanName = String(name || "").trim() || ("Web #" + (state.settings.importedThemes.length + 1));
      var cleanHex = /^#[0-9a-fA-F]{6}$/.test(String(accentHex || "")) ? accentHex : "#38bdf8";
      var cleanFolder = normalizeSubfolderName(subfolderName);

      if (state.settings.customThemeFolders.indexOf(cleanFolder) === -1) {
        state.settings.customThemeFolders.push(cleanFolder);
      }

      state.settings.importedThemes.unshift({
        id: newId,
        name: cleanName.slice(0, 32),
        folder: cleanFolder,
        dataUrl: dataUrl,
        customAccent: cleanHex
      });

      currentMainThemeTab = "custom";
      currentCustomSubfolder = cleanFolder;

      state.settings.scene = newId;
      state.settings.lastNormalScene = newId;
      state.settings.wallpaperDataUrl = "";
      state.settings.accent = "custom";
      state.settings.customAccent = cleanHex;
      if (state.settings.themeMode === "flowey") state.settings.themeMode = "dark";
      if (state.settings.material === "solid") state.settings.material = "blur";

      renderImportedThemesCards();
      applyAppearance();
      scheduleSave();
      showToast(t("toastThemeImported"));
    }

    function onWallpaperCardClick(e) {
      var delBtn = e.target.closest("[data-del-theme]");
      if (delBtn) {
        e.preventDefault();
        e.stopPropagation();
        var delId = delBtn.getAttribute("data-del-theme");
        state.settings.importedThemes = (state.settings.importedThemes || []).filter(function (it) {
          return it && it.id !== delId;
        });
        if (state.settings.scene === delId) {
          state.settings.scene = "web_galaxy";
          state.settings.lastNormalScene = "web_galaxy";
        }
        renderImportedThemesCards();
        applyAppearance();
        scheduleSave();
        showToast(t("toastThemeDeleted"));
        return;
      }

      var card = e.target.closest(".wp-card");
      if (!card) return;
      var nextScene = card.getAttribute("data-scene") || "web_galaxy";
      state.settings.scene = nextScene;
      state.settings.wallpaperDataUrl = "";
      if (nextScene === "flowey_garden") {
        state.settings.themeMode = "flowey";
        state.settings.accent = "gold";
        state.settings.material = "blur";
      } else {
        state.settings.lastNormalScene = nextScene;
        if (state.settings.themeMode === "flowey") {
          state.settings.themeMode = "dark";
        }
        if (state.settings.material === "solid") {
          state.settings.material = "blur";
        }
        var imp = getImportedThemeById(nextScene);
        if (imp && imp.customAccent) {
          state.settings.accent = "custom";
          state.settings.customAccent = imp.customAccent;
        } else if (window.INTERNET_THEME_META && window.INTERNET_THEME_META[nextScene]) {
          var meta = window.INTERNET_THEME_META[nextScene];
          if (meta.accent === "custom" && meta.customAccent) {
            state.settings.accent = "custom";
            state.settings.customAccent = meta.customAccent;
          } else if (meta.accent) {
            state.settings.accent = meta.accent;
          }
        }
      }
      applyAppearance();
      scheduleSave();
    }

    document.getElementById("wpGrid").addEventListener("click", onWallpaperCardClick);
    renderImportedThemesCards();

    var themeMainTabs = document.getElementById("themeMainTabs");
    if (themeMainTabs) {
      themeMainTabs.addEventListener("click", function (e) {
        var b = e.target.closest("[data-main-tab]");
        if (!b) return;
        currentMainThemeTab = b.getAttribute("data-main-tab") || "fleetway";
        applyThemeTabsFilter();
      });
    }

    var fleetwaySubTabs = document.getElementById("fleetwaySubTabs");
    if (fleetwaySubTabs) {
      fleetwaySubTabs.addEventListener("click", function (e) {
        var b = e.target.closest("[data-cat]");
        if (!b) return;
        currentMainThemeTab = "fleetway";
        currentFleetwayCat = b.getAttribute("data-cat") || "dr5";
        applyThemeTabsFilter();
      });
    }

    var customSubfolderTabs = document.getElementById("customSubfolderTabs");
    if (customSubfolderTabs) {
      customSubfolderTabs.addEventListener("click", function (e) {
        var b = e.target.closest("[data-subfolder]");
        if (!b) return;
        currentMainThemeTab = "custom";
        currentCustomSubfolder = b.getAttribute("data-subfolder") || "";
        var netFolderInput = document.getElementById("netFolderInput");
        if (netFolderInput && currentCustomSubfolder) netFolderInput.value = currentCustomSubfolder;
        applyThemeTabsFilter();
      });
    }

    var btnNewThemeSubfolder = document.getElementById("btnNewThemeSubfolder");
    if (btnNewThemeSubfolder) {
      btnNewThemeSubfolder.addEventListener("click", function () {
        var entered = window.prompt(t("promptNewThemeSubfolder"), "");
        if (!entered || !entered.trim()) return;
        var clean = normalizeSubfolderName(entered);
        if (!Array.isArray(state.settings.customThemeFolders)) state.settings.customThemeFolders = [];
        if (state.settings.customThemeFolders.indexOf(clean) === -1) {
          state.settings.customThemeFolders.push(clean);
        }
        currentMainThemeTab = "custom";
        currentCustomSubfolder = clean;
        var netFolderInput = document.getElementById("netFolderInput");
        if (netFolderInput) netFolderInput.value = clean;
        applyThemeTabsFilter();
        scheduleSave();
      });
    }

    /* Internet Theme Importer Tabs & Actions */
    var netImportModeTabs = document.getElementById("netImportModeTabs");
    if (netImportModeTabs) {
      netImportModeTabs.addEventListener("click", function (e) {
        var b = e.target.closest("[data-import-tab]");
        if (!b) return;
        var mode = b.getAttribute("data-import-tab");
        document.querySelectorAll("#netImportModeTabs .cat-pill").forEach(function (el) {
          el.classList.toggle("active", el === b);
        });
        document.getElementById("netSearchPane").style.display = mode === "search" ? "block" : "none";
        document.getElementById("netUrlPane").style.display = mode === "url" ? "block" : "none";
      });
    }

    var RU_SEARCH_DICT = {
      "соник": "sonic",
      "шэдоу": "shadow the hedgehog",
      "шедоу": "shadow the hedgehog",
      "тейлз": "miles tails prower",
      "наклз": "knuckles",
      "сильвер": "silver the hedgehog",
      "эггман": "eggman",
      "дельтарун": "deltarune",
      "андертейл": "undertale",
      "крис": "kris deltarune",
      "сьюзи": "susie deltarune",
      "ралсей": "ralsei",
      "ноэлль": "noelle holiday",
      "спамтон": "spamton",
      "джевил": "jevil",
      "санс": "sans undertale",
      "азгор": "asgore",
      "тенна": "tenna deltarune",
      "флауи": "flowey",
      "хорнет": "hornet hollow knight",
      "полый рыцарь": "hollow knight",
      "ультракилл": "ultrakill",
      "омори": "omori",
      "капхед": "cuphead",
      "персона": "persona 5",
      "дум": "doom slayer",
      "зельда": "zelda",
      "ведьмак": "witcher",
      "геншин": "genshin impact",
      "майнкрафт": "minecraft",
      "киберпанк": "cyberpunk",
      "космос": "space galaxy",
      "природа": "nature landscape",
      "аниме": "anime",
      "сакура": "sakura",
      "лес": "forest",
      "океан": "ocean"
    };

    function translateQueryForApi(rawQ) {
      var low = String(rawQ || "").trim().toLowerCase();
      if (!low) return "Sonic the Hedgehog";
      if (RU_SEARCH_DICT[low]) return RU_SEARCH_DICT[low];
      var out = low;
      Object.keys(RU_SEARCH_DICT).forEach(function (k) {
        if (out.indexOf(k) !== -1) {
          out = out.split(k).join(RU_SEARCH_DICT[k]);
        }
      });
      return out;
    }

    function setNetStatus(msg, visible, showAnyQualityBtn) {
      var row = document.getElementById("netStatusRow");
      var st = document.getElementById("netSearchStatus");
      var anyBtn = document.getElementById("btnSearchAnyQuality");
      if (st) {
        st.textContent = msg || "";
        st.style.display = visible ? "block" : "none";
      }
      if (anyBtn) {
        anyBtn.style.display = showAnyQualityBtn ? "inline-flex" : "none";
      }
      if (row) {
        row.style.display = (visible || showAnyQualityBtn) ? "flex" : "none";
      }
    }

    function fetchSafebooruFallbackResults(apiQuery) {
      if (!hasLocalNetProxy()) return Promise.resolve([]);
      var clean = String(apiQuery || "").trim().toLowerCase().replace(/[^a-z0-9_ ]+/g, " ").trim();
      if (!clean) return Promise.resolve([]);
      var acUrl = "https://safebooru.org/autocomplete.php?q=" + encodeURIComponent(clean.replace(/\s+/g, "_"));
      return fetch("/api/net-image?url=" + encodeURIComponent(acUrl))
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; })
        .then(function (acList) {
          var tag = "";
          if (Array.isArray(acList) && acList.length > 0 && acList[0] && acList[0].value) {
            tag = String(acList[0].value);
          } else {
            tag = clean.split(/\s+/)[0] || "";
          }
          if (!tag) return [];
          var postUrl = "https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=18&tags=" + encodeURIComponent(tag);
          return fetch("/api/net-image?url=" + encodeURIComponent(postUrl))
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (posts) {
              if (!Array.isArray(posts)) return [];
              return posts.slice(0, 14).map(function (p) {
                var full = p.file_url || ("https://safebooru.org//images/" + p.directory + "/" + p.image);
                var sample = p.sample_url || full;
                return {
                  path: full,
                  thumbs: { small: sample, large: sample },
                  resolution: (p.width && p.height) ? (p.width + "x" + p.height) : "Art",
                  colors: ["#38bdf8"]
                };
              });
            })
            .catch(function () { return []; });
        });
    }

    var lastSearchedRawQuery = "Sonic";

    function runInternetThemeSearch(query, qualityMode) {
      var mode = qualityMode === "any" ? "any" : "hd";
      var rawUserQuery = String(query || "").trim() || "Sonic";
      lastSearchedRawQuery = rawUserQuery;
      var folderTarget = normalizeSubfolderName(rawUserQuery);
      var apiQ = translateQueryForApi(rawUserQuery);
      var grid = document.getElementById("netSearchGrid");

      setNetStatus(mode === "any" ? t("netSearchingAny") : t("netSearching"), true, false);
      if (grid) { grid.innerHTML = ""; grid.style.display = "none"; }

      var wallhavenPromise;
      if (hasLocalNetProxy()) {
        wallhavenPromise = fetch("/api/net-search?q=" + encodeURIComponent(apiQ) + "&mode=" + mode)
          .then(function (r) { return r.json(); })
          .catch(function () { return { data: [] }; });
      } else {
        var whUrl = mode === "any"
          ? ("https://wallhaven.cc/api/v1/search?q=" + encodeURIComponent(apiQ) + "&purity=100&sorting=relevance")
          : ("https://wallhaven.cc/api/v1/search?q=" + encodeURIComponent(apiQ) + "&purity=100&atleast=1920x1080&ratios=16x9,16x10&sorting=favorites");
        wallhavenPromise = fetch(whUrl)
          .then(function (r) { return r.json(); })
          .catch(function () { return { data: [] }; });
      }

      var combinedPromise = mode === "any"
        ? Promise.all([wallhavenPromise, fetchSafebooruFallbackResults(apiQ)]).then(function (arr) {
            var whItems = (arr[0] && Array.isArray(arr[0].data)) ? arr[0].data : [];
            var sbItems = Array.isArray(arr[1]) ? arr[1] : [];
            return whItems.slice(0, 12).concat(sbItems.slice(0, 12));
          })
        : wallhavenPromise.then(function (payload) {
            return (payload && Array.isArray(payload.data)) ? payload.data.slice(0, 16) : [];
          });

      combinedPromise.then(function (items) {
        if (!items || !items.length) {
          if (mode === "hd") {
            setNetStatus(t("netNoHdResults"), true, true);
          } else {
            setNetStatus(t("netNoResults"), true, false);
          }
          return;
        }

            setNetStatus(t("netClickHint") + " → " + folderTarget, true, mode === "hd");
        grid.innerHTML = "";
        grid.style.display = "grid";

        items.forEach(function (it, idx) {
          var fullUrl = it.path || "";
          var thumbUrl = (it.thumbs && (it.thumbs.small || it.thumbs.large)) || fullUrl;
          var displayThumb = hasLocalNetProxy() ? ("/api/net-image?url=" + encodeURIComponent(thumbUrl)) : thumbUrl;
          var hintHex = (Array.isArray(it.colors) && it.colors[0]) ? it.colors[0] : "#38bdf8";

          var card = document.createElement("button");
          card.type = "button";
          card.className = "wp-card dr-photo-card";
          card.style.backgroundImage = "url(\"" + displayThumb.replace(/"/g, "%22") + "\")";

          var dot = document.createElement("i");
          dot.className = "wp-accent-dot";
          dot.style.background = hintHex;
          card.appendChild(dot);

          if (it.resolution) {
            var badge = document.createElement("em");
            badge.className = "net-res-badge";
            badge.style.fontStyle = "normal";
            badge.textContent = it.resolution;
            card.appendChild(badge);
          }

          var label = document.createElement("span");
          label.textContent = folderTarget + " #" + (idx + 1);
          card.appendChild(label);

          card.addEventListener("click", function () {
            setNetStatus(t("netDownloading"), true, false);
            fetchInternetImageAsThemeData(fullUrl, hintHex)
              .then(function (res) {
                setNetStatus(t("netClickHint") + " → " + folderTarget, true, mode === "hd");
                saveAndActivateImportedTheme(folderTarget + " #" + (idx + 1), res.dataUrl, res.accentHex, folderTarget);
              })
              .catch(function () {
                setNetStatus(t("toastThemeImportErr"), true, mode === "hd");
                showToast(t("toastThemeImportErr"));
              });
          });

          grid.appendChild(card);
        });
      }).catch(function () {
        setNetStatus(mode === "hd" ? t("netNoHdResults") : t("netNoResults"), true, mode === "hd");
      });
    }

    var btnNetSearch = document.getElementById("btnNetSearch");
    var netSearchInput = document.getElementById("netSearchInput");
    if (btnNetSearch && netSearchInput) {
      btnNetSearch.addEventListener("click", function () {
        runInternetThemeSearch(netSearchInput.value, "hd");
      });
      netSearchInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          runInternetThemeSearch(netSearchInput.value, "hd");
        }
      });
    }

    var btnSearchAnyQuality = document.getElementById("btnSearchAnyQuality");
    if (btnSearchAnyQuality) {
      btnSearchAnyQuality.addEventListener("click", function () {
        var qVal = (netSearchInput && netSearchInput.value.trim()) ? netSearchInput.value : lastSearchedRawQuery;
        runInternetThemeSearch(qVal, "any");
      });
    }

    var netQuickTags = document.getElementById("netQuickTags");
    if (netQuickTags) {
      netQuickTags.addEventListener("click", function (e) {
        var tag = e.target.closest("[data-q]");
        if (!tag) return;
        var q = tag.getAttribute("data-q") || "Sonic";
        if (netSearchInput) netSearchInput.value = q;
        runInternetThemeSearch(q, "hd");
      });
    }

    function importThemesFromJsonObject(parsed) {
      var arr = [];
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && Array.isArray(parsed.themes)) arr = parsed.themes;
      else if (parsed && (parsed.dataUrl || parsed.imageUrl || parsed.url)) arr = [parsed];

      if (!arr.length) {
        showToast(t("toastThemeImportErr"));
        return;
      }

      var pending = arr.slice(0, 24);
      var importedAny = false;
      var chain = Promise.resolve();
      pending.forEach(function (entry) {
        chain = chain.then(function () {
          var entryFolder = entry.folder || t("defaultSubfolderImport");
          if (entry.dataUrl && String(entry.dataUrl).indexOf("data:image/") === 0) {
            saveAndActivateImportedTheme(entry.name || "Imported", entry.dataUrl, entry.customAccent || "#38bdf8", entryFolder);
            importedAny = true;
            return;
          }
          var remote = entry.imageUrl || entry.url;
          if (remote) {
            return fetchInternetImageAsThemeData(remote, entry.customAccent || "#38bdf8").then(function (res) {
              saveAndActivateImportedTheme(entry.name || "Imported", res.dataUrl, entry.customAccent || res.accentHex, entryFolder);
              importedAny = true;
            }).catch(function () {});
          }
        });
      });
      chain.then(function () {
        if (!importedAny) showToast(t("toastThemeImportErr"));
      });
    }

    var btnImportNetUrl = document.getElementById("btnImportNetUrl");
    if (btnImportNetUrl) {
      btnImportNetUrl.addEventListener("click", function () {
        var rawUrl = (document.getElementById("netUrlInput").value || "").trim();
        var customName = (document.getElementById("netNameInput").value || "").trim();
        var folderInputEl = document.getElementById("netFolderInput");
        var customFolder = (folderInputEl && folderInputEl.value ? folderInputEl.value.trim() : "") || currentCustomSubfolder || t("defaultSubfolderImport");
        if (!rawUrl) {
          document.getElementById("netUrlInput").focus();
          return;
        }
        /* Check if URL points to a .json theme pack */
        if (/\.json(\?|$)/i.test(rawUrl)) {
          var jsonFetch = hasLocalNetProxy()
            ? fetch("/api/net-image?url=" + encodeURIComponent(rawUrl)).then(function (r) { return r.json(); })
            : fetch(rawUrl).then(function (r) { return r.json(); });
          jsonFetch.then(importThemesFromJsonObject).catch(function () {
            showToast(t("toastThemeImportErr"));
          });
          return;
        }
        if (!customName) {
          try {
            var seg = decodeURIComponent(rawUrl.split("?")[0].split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "");
            customName = seg.slice(0, 24) || "Web Theme";
          } catch (e) { customName = "Web Theme"; }
        }
        btnImportNetUrl.disabled = true;
        fetchInternetImageAsThemeData(rawUrl, "#38bdf8")
          .then(function (res) {
            btnImportNetUrl.disabled = false;
            document.getElementById("netUrlInput").value = "";
            document.getElementById("netNameInput").value = "";
            saveAndActivateImportedTheme(customName, res.dataUrl, res.accentHex, customFolder);
          })
          .catch(function () {
            btnImportNetUrl.disabled = false;
            showToast(t("toastThemeImportErr"));
          });
      });
    }

    var importThemeFileInput = document.getElementById("importThemeFileInput");
    var btnImportThemeFile = document.getElementById("btnImportThemeFile");
    if (btnImportThemeFile && importThemeFileInput) {
      btnImportThemeFile.addEventListener("click", function () {
        importThemeFileInput.click();
      });
      importThemeFileInput.addEventListener("change", function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        if (f.type && f.type.indexOf("image/") === 0) {
          var rImg = new FileReader();
          rImg.onload = function (ev) {
            var im = new Image();
            im.onload = function () {
              var res = compressImageElementToWebp(im, "#38bdf8");
              var baseName = f.name.replace(/\.[a-z0-9]+$/i, "");
              var folderEl = document.getElementById("netFolderInput");
              var fTarget = (folderEl && folderEl.value.trim()) || currentCustomSubfolder || t("defaultSubfolderImport");
              saveAndActivateImportedTheme(baseName, res.dataUrl, res.accentHex, fTarget);
            };
            im.src = String(ev.target.result || "");
          };
          rImg.readAsDataURL(f);
        } else {
          var rJson = new FileReader();
          rJson.onload = function (ev) {
            try {
              var parsed = JSON.parse(String(ev.target.result || ""));
              importThemesFromJsonObject(parsed);
            } catch (err) {
              showToast(t("toastThemeImportErr"));
            }
          };
          rJson.readAsText(f, "utf-8");
        }
        importThemeFileInput.value = "";
      });
    }

    var btnExportThemesFile = document.getElementById("btnExportThemesFile");
    if (btnExportThemesFile) {
      btnExportThemesFile.addEventListener("click", function () {
        var list = Array.isArray(state.settings.importedThemes) ? state.settings.importedThemes : [];
        var blob = new Blob([JSON.stringify({ app: "Graphite", version: 1, themes: list }, null, 2)], {
          type: "application/json;charset=utf-8"
        });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "graphite-internet-themes.json";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 300);
        showToast(t("toastThemesExported"));
      });
    }

    document.getElementById("setWpAnimGroup").addEventListener("click", function (e) {
      var b = e.target.closest("[data-wp-anim]");
      if (!b) return;
      state.settings.wallpaperAnimated = b.getAttribute("data-wp-anim") === "on";
      applyAppearance();
      scheduleSave();
    });

    var wpInput = document.getElementById("wallpaperFileInput");
    document.getElementById("btnUploadWallpaper").addEventListener("click", function () { wpInput.click(); });
    wpInput.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function (ev) {
        state.settings.wallpaperDataUrl = String(ev.target.result || "");
        applyAppearance();
        scheduleSave();
      };
      r.readAsDataURL(f);
      wpInput.value = "";
    });
    document.getElementById("btnClearWallpaper").addEventListener("click", function () {
      state.settings.wallpaperDataUrl = "";
      applyAppearance();
      scheduleSave();
    });

    document.getElementById("fontFamilySelect").addEventListener("change", function (e) {
      state.settings.fontFamily = e.target.value;
      applyAppearance();
      scheduleSave();
    });
    document.getElementById("btnFontDec").addEventListener("click", function () {
      state.settings.fontSize = Math.max(12, (state.settings.fontSize || 15) - 1);
      applyAppearance();
      updateLineNumbers();
      scheduleSave();
    });
    document.getElementById("btnFontInc").addEventListener("click", function () {
      state.settings.fontSize = Math.min(24, (state.settings.fontSize || 15) + 1);
      applyAppearance();
      updateLineNumbers();
      scheduleSave();
    });

    /* Custom Font File Uploader (.ttf / .otf / .woff / .woff2) + OS System Font Name */
    var customFontFileInput = document.getElementById("customFontFileInput");
    var btnUploadCustomFont = document.getElementById("btnUploadCustomFont");
    var btnAddSystemFontName = document.getElementById("btnAddSystemFontName");
    var customFontsChips = document.getElementById("customFontsChips");

    if (btnUploadCustomFont && customFontFileInput) {
      btnUploadCustomFont.addEventListener("click", function () {
        customFontFileInput.click();
      });
      customFontFileInput.addEventListener("change", function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        var baseName = f.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, "").trim().slice(0, 36) || "Custom Font";
        var reader = new FileReader();
        reader.onload = function () {
          var dataUrl = String(reader.result || "");
          if (!dataUrl || dataUrl.indexOf("data:") !== 0) {
            showToast(t("toastFontErr"));
            return;
          }
          var newId = "cfont_" + Date.now().toString(36);
          if (!Array.isArray(state.settings.customFonts)) state.settings.customFonts = [];
          state.settings.customFonts.push({ id: newId, name: baseName, dataUrl: dataUrl });
          state.settings.fontFamily = newId;
          applyAppearance();
          scheduleSave();
          showToast(t("toastFontAdded") + ": " + baseName);
        };
        reader.onerror = function () {
          showToast(t("toastFontErr"));
        };
        reader.readAsDataURL(f);
        customFontFileInput.value = "";
      });
    }

    if (btnAddSystemFontName) {
      btnAddSystemFontName.addEventListener("click", function () {
        var raw = window.prompt(t("promptSystemFontName"), "");
        if (!raw || !raw.trim()) return;
        var clean = raw.trim().replace(/["'<>]/g, "").slice(0, 40);
        if (!clean) return;
        var newId = "sysfont_" + Date.now().toString(36);
        if (!Array.isArray(state.settings.customFonts)) state.settings.customFonts = [];
        state.settings.customFonts.push({ id: newId, name: clean, dataUrl: "" });
        state.settings.fontFamily = newId;
        applyAppearance();
        scheduleSave();
        showToast(t("toastFontAdded") + ": " + clean);
      });
    }

    if (customFontsChips) {
      customFontsChips.addEventListener("click", function (e) {
        var delBtn = e.target.closest("[data-del-cfont]");
        if (delBtn) {
          e.stopPropagation();
          var delId = delBtn.getAttribute("data-del-cfont");
          state.settings.customFonts = (state.settings.customFonts || []).filter(function (cf) {
            return cf && cf.id !== delId;
          });
          if (state.settings.fontFamily === delId) {
            state.settings.fontFamily = "sans";
          }
          applyAppearance();
          scheduleSave();
          showToast(t("toastFontRemoved"));
          return;
        }
        var chip = e.target.closest("[data-select-cfont]");
        if (chip) {
          state.settings.fontFamily = chip.getAttribute("data-select-cfont") || "sans";
          applyAppearance();
          scheduleSave();
        }
      });
    }

    document.getElementById("btnExportDbSettings").addEventListener("click", exportBackupJson);
    document.getElementById("btnImportDbSettings").addEventListener("click", function () { importDbInp.click(); });

    document.getElementById("btnSetDefaultNotepad").addEventListener("click", function () {
      if (isNativeExe && typeof window.__gnNativeNotepadAssoc === "function") {
        Promise.resolve(window.__gnNativeNotepadAssoc("set")).then(function () {
          refreshDefaultNotepadBadge();
          showToast(t("toastAssocLaunched"));
        }).catch(function () {});
      } else {
        showToast(t("toastAssocExeHint"));
      }
    });

    document.getElementById("btnRestoreNotepad").addEventListener("click", function () {
      if (isNativeExe && typeof window.__gnNativeNotepadAssoc === "function") {
        Promise.resolve(window.__gnNativeNotepadAssoc("restore")).then(function () {
          refreshDefaultNotepadBadge();
          showToast(t("toastAssocRestored"));
        }).catch(function () {});
      } else {
        showToast(t("toastAssocExeHint"));
      }
    });

    /* Deltarune Flowery Easter Egg ("JARONA!") — plays the real MyInstants JARONA MP3 */
    var jaronaAudio = null;
    var jaronaPoseTimer = null;

    function playJaronaSound() {
      try {
        if (!window.FLOWERY_SOUND) return;
        if (!jaronaAudio) {
          jaronaAudio = new Audio(window.FLOWERY_SOUND);
          jaronaAudio.preload = "auto";
          jaronaAudio.volume = 0.90;
        }
        jaronaAudio.pause();
        jaronaAudio.currentTime = 0;
        var p = jaronaAudio.play();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (err) {}
    }

    var btnFloweySecret = document.getElementById("btnFloweySecret");

    if (btnFloweySecret) {
      btnFloweySecret.addEventListener("click", function () {
        if (!state.settings.easterEggsEnabled) return;
        if (state.settings.scene && state.settings.scene !== "flowey_garden") {
          state.settings.lastNormalScene = state.settings.scene;
        }
        state.settings.floweyUnlocked = true;
        state.settings.themeMode = "flowey";
        state.settings.scene = "flowey_garden";
        state.settings.accent = "gold";
        state.settings.wallpaperDataUrl = "";
        state.settings.material = "blur";
        if (state.settings.fleetwayThemesEnabled) {
          currentMainThemeTab = "fleetway";
          currentFleetwayCat = "dr5";
        }
        applyThemeTabsFilter();
        applyAppearance();
        scheduleSave();

        playJaronaSound();

        btnFloweySecret.classList.remove("talking");
        void btnFloweySecret.offsetWidth;
        btnFloweySecret.classList.add("jarona-active", "talking");

        clearTimeout(jaronaPoseTimer);
        jaronaPoseTimer = setTimeout(function () {
          btnFloweySecret.classList.remove("talking");
        }, 450);
      });
    }

    /* Drag & Drop */
    var dropOverlay = document.getElementById("dropOverlay");
    var dragDepth = 0;
    window.addEventListener("dragenter", function (e) {
      if (e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") !== -1) {
        dragDepth++;
        dropOverlay.classList.add("active");
      }
    });
    window.addEventListener("dragleave", function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropOverlay.classList.remove("active");
    });
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      dragDepth = 0;
      dropOverlay.classList.remove("active");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        for (var df = 0; df < e.dataTransfer.files.length; df++) {
          handleImportedFile(e.dataTransfer.files[df], false);
        }
      }
    });

    /* Keyboard Shortcuts */
    window.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        closeMenus();
        closeSettings();
        closeUnsavedModal();
        document.getElementById("findBar").classList.remove("open");
      } else if (e.altKey && (e.key === "n" || e.key === "N" || e.key === "т" || e.key === "Т")) {
        e.preventDefault();
        createNewNote();
      } else if (e.altKey && (e.key === "v" || e.key === "V" || e.key === "м" || e.key === "М")) {
        e.preventDefault();
        toggleViewLayout();
      } else if (mod && e.shiftKey && (e.key === "s" || e.key === "S" || e.key === "ы" || e.key === "Ы")) {
        e.preventDefault();
        saveActiveNoteAs();
      } else if (mod && (e.key === "s" || e.key === "S" || e.key === "ы" || e.key === "Ы")) {
        e.preventDefault();
        saveActiveNoteDirect();
      } else if (mod && (e.key === "o" || e.key === "O" || e.key === "щ" || e.key === "Щ")) {
        e.preventDefault();
        triggerOpenFileAction();
      } else if (mod && (e.key === "f" || e.key === "F" || e.key === "а" || e.key === "А")) {
        e.preventDefault();
        document.getElementById("findBar").classList.add("open");
        document.getElementById("findInput").focus();
        runFind("stay");
      } else if (mod && e.key === ",") {
        e.preventDefault();
        openSettings("general");
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
        applyAppearance();
        scheduleSave();
      } else if (e.key === "F5") {
        e.preventDefault();
        insertTimestamp();
      }
    });
  }

  /* -------------------- Boot -------------------- */
  function finishBoot() {
    if (window.innerWidth <= 780) state.settings.sidebarCollapsed = true;
    if (window.FLOWERY_SPRITES) {
      var idleEl = document.getElementById("floweryIdleImg");
      var jarEl = document.getElementById("floweryJaronaImg");
      if (idleEl) idleEl.src = window.FLOWERY_SPRITES.idle;
      if (jarEl) jarEl.src = window.FLOWERY_SPRITES.jarona;
    }
    if (window.FLOWERY_WALLPAPER && window.FLOWERY_WALLPAPER.static) {
      var flCard = document.getElementById("wpCardFlowey");
      if (flCard) flCard.style.backgroundImage = "url(" + window.FLOWERY_WALLPAPER.static + ")";
    }
    if (window.DELTARUNE_WALLPAPERS) {
      document.querySelectorAll(".dr-photo-card").forEach(function (card) {
        var sc = card.getAttribute("data-scene");
        if (sc && window.DELTARUNE_WALLPAPERS[sc]) {
          card.style.backgroundImage = "url(" + window.DELTARUNE_WALLPAPERS[sc] + ")";
        }
        if (sc && window.INTERNET_THEME_META && window.INTERNET_THEME_META[sc]) {
          var meta = window.INTERNET_THEME_META[sc];
          var dotMap = {
            white: "#ffffff", silver: "#94a3b8", sapphire: "#0078d4", sky: "#38bdf8",
            lagoon: "#14b8a6", emerald: "#10b981", lime: "#84cc16", gold: "#facc15",
            amber: "#f59e0b", coral: "#f97316", crimson: "#ef4444", rose: "#f43f5e",
            magenta: "#d946ef", lavender: "#a855f7", amethyst: "#7c3aed", indigo: "#4f46e5"
          };
          var dotHex = meta.accent === "custom" ? (meta.customAccent || "#ff4db8") : (dotMap[meta.accent] || "#38bdf8");
          var dot = document.createElement("i");
          dot.className = "wp-accent-dot";
          dot.style.background = dotHex;
          card.insertBefore(dot, card.firstChild);
        }
      });
    }
    bindEvents();
    applyAppearance();
    applyLocalization();
    loadActiveNoteIntoEditor();
    syncMaximizeState();
    pullPendingNativeFiles();
  }

  function boot() {
    var local = safeLocalGet();
    if (local) hydrateState(local);

    if (typeof window.__gnNativeLoad === "function") {
      isNativeExe = true;
      Promise.resolve(window.__gnNativeLoad()).then(function (raw) {
        if (raw) {
          try { hydrateState(typeof raw === "string" ? JSON.parse(raw) : raw); } catch (e) {}
        }
        finishBoot();
      }).catch(function () { finishBoot(); });
      return;
    }

    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      fetch("/api/os-ui-lang", { method: "GET" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (langObj) {
          if (langObj && typeof langObj.lang === "string" && langObj.lang) {
            window.__GN_WIN_UI_LANG = langObj.lang;
            if (state.settings.langMode !== "manual") {
              state.settings.lang = detectSystemUiLanguage();
            }
          }
        })
        .catch(function () {})
        .finally(function () {
          fetch("/api/storage", { method: "GET" })
            .then(function (r) {
              if (!r.ok) throw new Error("no-api");
              serverSyncAvailable = true;
              return r.json();
            })
            .then(function (data) {
              if (data && Array.isArray(data.notes)) hydrateState(data);
              else if (state.settings.langMode !== "manual") state.settings.lang = detectSystemUiLanguage();
              finishBoot();
            })
            .catch(function () { finishBoot(); });
        });
      return;
    }

    finishBoot();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
