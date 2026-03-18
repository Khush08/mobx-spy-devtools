/**
 * inject.js — Runs in the PAGE context (not the extension context).
 *
 * Responsibilities:
 *  - Detect MobX on the page (via __mobxGlobals or global module reference)
 *  - Attach/detach a spy listener
 *  - Filter events by type before sending (avoids unnecessary serialization)
 *  - Respond to commands from the content script
 *  - Authenticate messages via nonce to prevent spoofing (#5)
 *
 * Detection strategy (priority order):
 *  1. window.__mobxGlobals.spyListeners — direct push, zero user setup
 *  2. window.__MOBX_DEVTOOLS_GLOBAL_HOOK__.mobx — explicit hook
 *  3. window.mobx / window.__MOBX__ — common globals
 */
(function () {
  "use strict";

  var SOURCE = "mobx-devtools-inject";
  var spyListener = null;
  var disposer = null;
  var isMonitoring = false;
  var eventId = 0;

  // ──────────────────────────────────────────────
  // Nonce authentication (#5)
  // Read the nonce from the script element's data attribute.
  // The content script sets this before injecting us.
  // ──────────────────────────────────────────────

  var nonce = "";
  (function readNonce() {
    try {
      var scriptEl = document.currentScript;
      if (scriptEl && scriptEl.dataset && scriptEl.dataset.mobxNonce) {
        nonce = scriptEl.dataset.mobxNonce;
      }
    } catch (e) { /* ignore — nonce will be empty, messages won't validate */ }
  })();

  // Event types to capture. Only these are serialized and forwarded.
  // Updated by "set-filters" command from the panel.
  var enabledTypes = null; // null = capture all; Set = capture only these

  // ──────────────────────────────────────────────
  // Dev-URL allowlist (defense in depth — panel also checks)
  // ──────────────────────────────────────────────

  var DEV_URL_PATTERNS = [
    /^https?:\/\/localhost(:\d+)?(\/|$)/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
    /^https?:\/\/\[::1\](:\d+)?(\/|$)/,
    /^https?:\/\/0\.0\.0\.0(:\d+)?(\/|$)/
  ];

  function isDevUrl() {
    var url = window.location.href;
    for (var i = 0; i < DEV_URL_PATTERNS.length; i++) {
      if (DEV_URL_PATTERNS[i].test(url)) return true;
    }
    return false;
  }

  // ──────────────────────────────────────────────
  // Detection
  // ──────────────────────────────────────────────

  function getMobXGlobals() {
    return window.__mobxGlobals || null;
  }

  function findMobXModule() {
    if (window.__MOBX_DEVTOOLS_GLOBAL_HOOK__ && window.__MOBX_DEVTOOLS_GLOBAL_HOOK__.mobx) {
      return window.__MOBX_DEVTOOLS_GLOBAL_HOOK__.mobx;
    }
    if (window.mobx && typeof window.mobx.spy === "function") {
      return window.mobx;
    }
    if (window.__MOBX__ && typeof window.__MOBX__.spy === "function") {
      return window.__MOBX__;
    }
    return null;
  }

  function isMobXDetected() {
    return !!(getMobXGlobals() || findMobXModule());
  }

  /**
   * Gather detailed info about the MobX detection state.
   * Returns a plain object safe for postMessage serialization.
   */
  function gatherDetectionInfo() {
    var info = {
      detectionMethod: null,
      version: null,
      spyListenersCount: null,
      mobxGlobals: null
    };

    // Check __mobxGlobals first (primary detection)
    var globals = getMobXGlobals();
    if (globals) {
      info.detectionMethod = "__mobxGlobals";
      try {
        if (Array.isArray(globals.spyListeners)) {
          info.spyListenersCount = globals.spyListeners.length;
        }
      } catch (e) { /* proxy trap safety */ }

      // Extract a snapshot of __mobxGlobals keys/values (safe, shallow)
      var globalsSnapshot = {};
      try {
        var keys = Object.keys(globals);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          try {
            var v = globals[k];
            var t = typeof v;
            if (t === "string" || t === "number" || t === "boolean") {
              globalsSnapshot[k] = v;
            } else if (v === null) {
              globalsSnapshot[k] = null;
            } else if (Array.isArray(v)) {
              globalsSnapshot[k] = "[Array(" + v.length + ")]";
            } else if (t === "object") {
              globalsSnapshot[k] = "[Object]";
            } else if (t === "function") {
              globalsSnapshot[k] = "[Function]";
            } else {
              globalsSnapshot[k] = "[" + t + "]";
            }
          } catch (e) {
            globalsSnapshot[k] = "[Unreadable]";
          }
        }
      } catch (e) {
        globalsSnapshot._error = "Could not read keys";
      }
      info.mobxGlobals = globalsSnapshot;

      // Try to extract version from globals
      try {
        if (globals.version) info.version = String(globals.version);
      } catch (e) { /* ignore */ }

      return info;
    }

    // Fallback detection methods
    var mobxModule = null;
    if (window.__MOBX_DEVTOOLS_GLOBAL_HOOK__ && window.__MOBX_DEVTOOLS_GLOBAL_HOOK__.mobx) {
      info.detectionMethod = "__MOBX_DEVTOOLS_GLOBAL_HOOK__";
      mobxModule = window.__MOBX_DEVTOOLS_GLOBAL_HOOK__.mobx;
    } else if (window.mobx && typeof window.mobx.spy === "function") {
      info.detectionMethod = "window.mobx";
      mobxModule = window.mobx;
    } else if (window.__MOBX__ && typeof window.__MOBX__.spy === "function") {
      info.detectionMethod = "window.__MOBX__";
      mobxModule = window.__MOBX__;
    }

    if (mobxModule) {
      try {
        if (mobxModule.version) info.version = String(mobxModule.version);
      } catch (e) { /* ignore */ }
    }

    return info;
  }

  // ──────────────────────────────────────────────
  // Serialization
  // ──────────────────────────────────────────────

  var MAX_DEPTH = 6;        // how deep to recurse into nested objects
  var MAX_ARRAY_ITEMS = 100; // max array elements to serialize
  var MAX_OBJ_KEYS = 50;    // max object keys to serialize

  /**
   * Deep-clone a value into a plain, JSON-safe structure.
   * Handles: circular refs, functions, symbols, bigints, undefined,
   * Map, Set, Error, Date, RegExp, MobX observable proxies.
   *
   * Hardened against:
   * - Malicious Proxy traps that throw on property access (#11)
   * - Prototype pollution via __proto__, constructor, prototype keys (#13)
   */

  // Unsafe keys that could cause prototype pollution (#13)
  var UNSAFE_KEYS = { "__proto__": true, "constructor": true, "prototype": true };

  // Safe instanceof check — Proxy traps can throw on Symbol.hasInstance (#11)
  function safeInstanceOf(val, ctor) {
    try { return val instanceof ctor; } catch (e) { return false; }
  }

  function safeClone(val, depth, seen) {
    // Primitives
    if (val === null) return null;
    if (val === undefined) return "[undefined]";

    var t;
    try { t = typeof val; } catch (e) { return "[Unreadable: typeof threw]"; }

    if (t === "string" || t === "boolean") return val;
    if (t === "number") {
      if (val !== val) return "[NaN]";           // NaN
      if (val === Infinity) return "[Infinity]";
      if (val === -Infinity) return "[-Infinity]";
      return val;
    }
    if (t === "bigint") return val.toString() + "n";
    if (t === "function") {
      var fname = "";
      try { fname = val.name || "anonymous"; } catch (e) { fname = "anonymous"; }
      return "[Function: " + fname + "]";
    }
    if (t === "symbol") {
      try { return val.toString(); } catch (e) { return "[Symbol]"; }
    }

    // Depth limit — only applies to objects (not arrays/sets which are containers)
    if (depth >= MAX_DEPTH) return "[Object: max depth]";

    // Circular reference check
    if (seen.has(val)) return "[Circular]";
    seen.add(val);

    try {
      // Date
      if (safeInstanceOf(val, Date)) {
        try { return val.toISOString(); } catch (e) { return "[Date: invalid]"; }
      }

      // RegExp
      if (safeInstanceOf(val, RegExp)) {
        try { return val.toString(); } catch (e) { return "[RegExp]"; }
      }

      // Error
      if (safeInstanceOf(val, Error)) {
        return {
          __type: "Error",
          name: val.name,
          message: val.message,
          stack: val.stack ? val.stack.split("\n").slice(0, 5).join("\n") : undefined
        };
      }

      // Map — counts as a depth level (like objects)
      if (safeInstanceOf(val, Map)) {
        var mapObj = { __type: "Map", size: val.size, entries: {} };
        var mc = 0;
        try {
          val.forEach(function (v, k) {
            if (mc >= MAX_OBJ_KEYS) return;
            var keyStr;
            try { keyStr = typeof k === "object" ? JSON.stringify(k) : String(k); }
            catch (e) { keyStr = "[Unreadable key]"; }
            if (!UNSAFE_KEYS[keyStr]) {
              mapObj.entries[keyStr] = safeClone(v, depth + 1, seen);
            }
            mc++;
          });
        } catch (e) {
          mapObj._error = "[Map iteration threw]";
        }
        if (val.size > MAX_OBJ_KEYS) mapObj._truncated = val.size - MAX_OBJ_KEYS + " more";
        return mapObj;
      }

      // Set — container, does NOT consume a depth level
      if (safeInstanceOf(val, Set)) {
        var setArr = [];
        var sc = 0;
        try {
          val.forEach(function (v) {
            if (sc >= MAX_ARRAY_ITEMS) return;
            setArr.push(safeClone(v, depth, seen));
            sc++;
          });
        } catch (e) {
          setArr.push("[Set iteration threw]");
        }
        if (val.size > MAX_ARRAY_ITEMS) setArr.push("... " + (val.size - MAX_ARRAY_ITEMS) + " more");
        return setArr;
      }

      // Array (including MobX ObservableArray) — container, does NOT consume a depth level
      var isArr;
      try { isArr = Array.isArray(val); } catch (e) { isArr = false; }

      if (isArr) {
        var arr = [];
        var len;
        try { len = Math.min(val.length, MAX_ARRAY_ITEMS); } catch (e) { len = 0; }
        for (var i = 0; i < len; i++) {
          try {
            arr.push(safeClone(val[i], depth, seen));
          } catch (e) {
            arr.push("[Unreadable]");
          }
        }
        try {
          if (val.length > MAX_ARRAY_ITEMS) arr.push("... " + (val.length - MAX_ARRAY_ITEMS) + " more items");
        } catch (e) { /* ignore */ }
        return arr;
      }

      // Plain objects (including MobX observable objects which are Proxies)
      var result = {};
      var keys;
      try {
        keys = Object.keys(val);
      } catch (e) {
        // Some proxies throw on Object.keys
        return "[Object: unreadable keys]";
      }

      // Add constructor name if it's not a plain Object
      var ctorName = null;
      try {
        ctorName = val.constructor && val.constructor.name;
      } catch (e) { /* ignore */ }
      if (ctorName && ctorName !== "Object" && ctorName !== "Array") {
        result.__type = ctorName;
      }

      var kc = 0;
      for (var j = 0; j < keys.length; j++) {
        if (kc >= MAX_OBJ_KEYS) {
          result._truncated = (keys.length - MAX_OBJ_KEYS) + " more keys";
          break;
        }
        var key = keys[j];
        // Skip prototype-polluting keys (#13)
        if (UNSAFE_KEYS[key]) continue;
        try {
          result[key] = safeClone(val[key], depth + 1, seen);
        } catch (e) {
          result[key] = "[Unreadable]";
        }
        kc++;
      }

      return result;
    } catch (e) {
      return "[Unserializable: " + (e.message || "unknown error") + "]";
    } finally {
      seen.delete(val);
    }
  }

  // Per-type field whitelists — only these fields get safeClone'd.
  // Fields not in the whitelist are never read from the event, avoiding
  // expensive Proxy traversals on large observable trees.
  // null = no whitelist, serialize all fields.
  var TYPE_FIELD_WHITELIST = {
    "action":             ["name", "object", "arguments"],
    "add":                ["name", "object", "observableKind", "debugObjectName", "newValue"],
    "remove":             ["name", "object", "observableKind", "debugObjectName", "oldValue"],
    "update":             ["name", "object", "observableKind", "debugObjectName", "oldValue", "newValue"],
    "delete":             ["name", "object", "observableKind", "debugObjectName", "oldValue"],
    "splice":             ["name", "object", "observableKind", "debugObjectName", "removed", "added", "removedCount", "addedCount"],
    "error":              ["name", "message", "error"],
    "reaction":           ["name"],
    "scheduled-reaction": ["name"]
  };

  // Fields that should be serialized with a shallow depth limit.
  // Value is the starting depth offset — safeClone starts at this depth
  // so it only recurses (MAX_DEPTH - value) levels deep.
  // e.g. with MAX_DEPTH=5 and offset=2, fields get 3 levels of recursion.
  var SHALLOW_FIELDS = { "arguments": 3, "object": 3 };

  function serializeEvent(event) {
    var seen = new Set();
    seen.add(event); // the event itself is the root, don't re-enter it

    var serialized = { type: event.type };
    var whitelist = TYPE_FIELD_WHITELIST[event.type] || null;

    if (whitelist) {
      // Only serialize whitelisted fields — skip everything else
      for (var i = 0; i < whitelist.length; i++) {
        var key = whitelist[i];
        if (key in event) {
          var startDepth = SHALLOW_FIELDS[key] || 0;
          try {
            serialized[key] = safeClone(event[key], startDepth, seen);
          } catch (e) {
            serialized[key] = "[Unserializable]";
          }
        }
      }
    } else {
      // No whitelist — serialize all fields (unknown/future event types)
      var keys = Object.keys(event);
      for (var j = 0; j < keys.length; j++) {
        var key2 = keys[j];
        if (key2 === "type") continue;
        var startDepth2 = SHALLOW_FIELDS[key2] || 0;
        try {
          serialized[key2] = safeClone(event[key2], startDepth2, seen);
        } catch (e) {
          serialized[key2] = "[Unserializable]";
        }
      }
    }
    return serialized;
  }

  // ──────────────────────────────────────────────
  // Spy listener + batching
  // ──────────────────────────────────────────────

  var FLUSH_INTERVAL = 1000; // ms
  var MAX_BUFFER_SIZE = 10000; // max events buffered before flush (#10 — DoS protection)
  var eventBuffer = [];
  var flushTimer = null;

  function onSpyEvent(event) {
    if (!isMonitoring) return;

    // Always skip report-end events — they are internal MobX bookkeeping
    if (event.type === "report-end" || event.spyReportEnd) return;

    // Filter by type before serializing (performance)
    if (enabledTypes !== null && !enabledTypes.has(event.type)) return;

    var payload = serializeEvent(event);
    payload._id = ++eventId;
    payload._timestamp = Date.now();

    // Extract constructor name for grouping (before object gets serialized away)
    if (event.object && event.object.constructor && event.object.constructor.name) {
      payload._objectClass = event.object.constructor.name;
    }

    eventBuffer.push(payload);

    // Cap buffer size to prevent unbounded memory growth (#10)
    if (eventBuffer.length > MAX_BUFFER_SIZE) {
      eventBuffer = eventBuffer.slice(-MAX_BUFFER_SIZE);
    }

    // Start the flush timer if not already running
    if (flushTimer === null) {
      flushTimer = setTimeout(flushEvents, FLUSH_INTERVAL);
    }
  }

  function flushEvents() {
    flushTimer = null;

    if (eventBuffer.length === 0) return;

    // Send the entire batch as a single message
    var batch = eventBuffer;
    eventBuffer = [];

    window.postMessage(
      { source: SOURCE, _nonce: nonce, type: "spy-event-batch", payload: batch },
      "*"
    );
  }

  function stopFlushTimer() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  // ──────────────────────────────────────────────
  // Start / Stop
  // ──────────────────────────────────────────────

  function attachSpy() {
    if (disposer) return true; // Already attached

    spyListener = onSpyEvent;

    // Strategy 1: __mobxGlobals.spyListeners
    var globals = getMobXGlobals();
    if (globals && Array.isArray(globals.spyListeners)) {
      globals.spyListeners.push(spyListener);
      disposer = function () {
        var idx = globals.spyListeners.indexOf(spyListener);
        if (idx !== -1) globals.spyListeners.splice(idx, 1);
      };
      return true;
    }

    // Strategy 2: module spy() API
    var mobx = findMobXModule();
    if (mobx) {
      disposer = mobx.spy(spyListener);
      return true;
    }

    spyListener = null;
    return false;
  }

  function detachSpy() {
    flushEvents();      // send any buffered events before detaching
    stopFlushTimer();
    if (disposer) {
      disposer();
      disposer = null;
    }
    spyListener = null;
  }

  // ──────────────────────────────────────────────
  // Status
  // ──────────────────────────────────────────────

  function postStatus(extra) {
    var detectionInfo = gatherDetectionInfo();
    var payload = {
      detected: isMobXDetected(),
      monitoring: isMonitoring,
      attached: !!disposer,
      detectionInfo: detectionInfo
    };
    if (extra) {
      for (var k in extra) payload[k] = extra[k];
    }
    window.postMessage({ source: SOURCE, _nonce: nonce, type: "status", payload: payload }, "*");
  }

  // ──────────────────────────────────────────────
  // Command handler
  // ──────────────────────────────────────────────

  window.addEventListener("message", function (msg) {
    if (!msg.data || msg.data.source !== "mobx-devtools-content") return;
    // Validate nonce — reject spoofed commands (#5)
    if (!nonce || msg.data._nonce !== nonce) return;

    var command = msg.data.command;
    var data = msg.data.data;

    switch (command) {
      case "detect":
        postStatus();
        break;

      case "start":
        if (!isDevUrl()) {
          postStatus({ error: "Profiling blocked on production URLs" });
          break;
        }
        if (!isMonitoring) {
          var ok = attachSpy();
          if (ok) {
            isMonitoring = true;
            postStatus();
          } else {
            postStatus({ error: "MobX not found on page" });
          }
        } else {
          postStatus();
        }
        break;

      case "stop":
        isMonitoring = false;
        detachSpy();
        postStatus();
        break;

      case "clear-buffer":
        // Panel is starting a new profiling session — wipe buffered events
        stopFlushTimer();
        eventBuffer = [];
        eventId = 0;
        break;

      case "set-filters":
        // data is an array of event type strings, or null for "all"
        if (data === null || data === undefined) {
          enabledTypes = null;
        } else if (Array.isArray(data)) {
          enabledTypes = new Set(data);
        }
        break;
    }
  });

  // ──────────────────────────────────────────────
  // Auto-detection polling
  // ──────────────────────────────────────────────

  var detectAttempts = 0;
  var MAX_DETECT_ATTEMPTS = 20;

  function pollForMobX() {
    if (isMobXDetected()) {
      postStatus();
      return;
    }
    if (++detectAttempts < MAX_DETECT_ATTEMPTS) {
      setTimeout(pollForMobX, 500);
    }
  }

  window.postMessage({ source: SOURCE, _nonce: nonce, type: "loaded" }, "*");
  pollForMobX();
})();
