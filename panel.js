/**
 * panel.js — Main logic for the MobX DevTools panel.
 *
 * Profiler-style UX:
 *  - idle:      No data, not profiling. "Click Record to start."
 *  - profiling:  Actively recording. Shows "Profiling..." overlay. Events buffer silently.
 *  - stopped:   Has data. Shows grouped event list + detail panel.
 *
 * Transitions:
 *  - Record (from idle):     clear memory → start profiling → show overlay
 *  - Record (from stopped):  clear memory → start profiling → show overlay
 *  - Stop (from profiling):  stop profiling → flush → render results
 *  - DevTools close:         clear all memory
 */
(function () {
  "use strict";

  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  var KNOWN_EVENT_TYPES = [
    "action",
    "scheduled-reaction",
    "reaction",
    "error",
    "add",
    "update",
    "remove",
    "delete",
    "splice"
  ];

  var DEFAULT_ENABLED_TYPES = ["action", "reaction"];

  // Max individual events kept per group (for expand view).
  var MAX_EVENTS_PER_GROUP = 50;

  // Max number of groups to prevent unbounded memory growth (#10).
  var MAX_GROUPS = 5000;

  // Max total events to count before capping (#10).
  var MAX_TOTAL_EVENTS = 500000;

  // Event types that only show as a count — no expand, no individual events stored.
  var NON_EXPANDABLE_TYPES = new Set(["reaction", "scheduled-reaction"]);

  // Panel states
  var STATE_IDLE = "idle";
  var STATE_PROFILING = "profiling";
  var STATE_STOPPED = "stopped";

  // ──────────────────────────────────────────────
  // Dev-URL allowlist
  // ──────────────────────────────────────────────

  // Only allow profiling on development URLs.
  // Matches: localhost, 127.0.0.1, 0.0.0.0, [::1], *.local, *.test, *.dev,
  //          *.localhost, file:// URLs, and chrome-extension:// URLs.
  var DEV_URL_PATTERNS = [
    /^https?:\/\/localhost(:\d+)?(\/|$)/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
    /^https?:\/\/\[::1\](:\d+)?(\/|$)/,
    /^https?:\/\/0\.0\.0\.0(:\d+)?(\/|$)/
  ];

  var isDevUrl = false;
  var inspectedUrl = "";

  function checkDevUrl(url) {
    if (!url) return false;
    for (var i = 0; i < DEV_URL_PATTERNS.length; i++) {
      if (DEV_URL_PATTERNS[i].test(url)) return true;
    }
    return false;
  }

  function updateUrlCheck() {
    chrome.devtools.inspectedWindow.eval("window.location.href", function (url) {
      inspectedUrl = url || "";
      isDevUrl = checkDevUrl(inspectedUrl);
      updateToolbarState();
      if (!isDevUrl) {
        showBlockedState();
      } else if (panelState === STATE_IDLE) {
        // If URL is allowed and we're idle, show the normal idle state
        showView(STATE_IDLE);
      }
    });
  }

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  var groups = new Map();
  var groupOrder = [];
  var filteredGroupKeys = [];
  var enabledTypes = new Set(DEFAULT_ENABLED_TYPES);
  var searchQuery = "";
  var panelState = STATE_IDLE;   // current panel state
  var mobxDetected = false;
  var mobxDetectionInfo = null;
  var totalEventCount = 0;
  var selectedGroupKey = null;
  var selectedEventIndex = -1;
  var detailRenderedCount = 0;

  // ──────────────────────────────────────────────
  // DOM references
  // ──────────────────────────────────────────────

  var btnStart = document.getElementById("btn-start");
  var btnStop = document.getElementById("btn-stop");
  var btnFilters = document.getElementById("btn-filters");
  var btnDownload = document.getElementById("btn-download");
  var btnCloseDetail = document.getElementById("btn-close-detail");
  var searchInput = document.getElementById("search-input");
  var filterPanel = document.getElementById("filter-panel");
  var filterCheckboxes = document.getElementById("filter-checkboxes");
  var eventListContainer = document.getElementById("event-list-container");
  var eventList = document.getElementById("event-list");
  var emptyState = document.getElementById("empty-state");
  var profilingScreen = document.getElementById("profiling-screen");
  var profilingCount = document.getElementById("profiling-count");
  var detailPanel = document.getElementById("detail-panel");
  var detailTitle = document.getElementById("detail-title");
  var detailEventList = document.getElementById("detail-event-list");
  var detailContent = document.getElementById("detail-content");
  var statusIndicator = document.getElementById("status-indicator");
  var statusText = document.getElementById("status-text");
  var eventCount = document.getElementById("event-count");
  var nameResizeHandle = document.getElementById("name-resize-handle");
  var blockedState = document.getElementById("blocked-state");
  var blockedUrl = document.getElementById("blocked-url");
  var mobxInfoEl = document.getElementById("mobx-info");

  // ──────────────────────────────────────────────
  // Name column resize
  // ──────────────────────────────────────────────

  (function () {
    var MIN_NAME_WIDTH = 80;
    var MAX_NAME_WIDTH = 600;
    var dragging = false;
    var startX = 0;
    var startWidth = 0;

    function getNameWidth() {
      var val = getComputedStyle(document.documentElement).getPropertyValue("--col-name-width");
      return parseInt(val, 10) || 200;
    }

    nameResizeHandle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startWidth = getNameWidth();
      nameResizeHandle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var delta = e.clientX - startX;
      var newWidth = Math.max(MIN_NAME_WIDTH, Math.min(MAX_NAME_WIDTH, startWidth + delta));
      document.documentElement.style.setProperty("--col-name-width", newWidth + "px");
    });

    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      nameResizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  })();

  // ──────────────────────────────────────────────
  // Detail panel resize
  // ──────────────────────────────────────────────

  (function () {
    var MIN_DETAIL_WIDTH = 200;
    var MAX_DETAIL_WIDTH_RATIO = 0.7; // max 70% of viewport
    var detailResizeHandle = document.getElementById("detail-resize-handle");
    var dragging = false;
    var startX = 0;
    var startWidth = 0;

    function getDetailWidth() {
      return detailPanel.getBoundingClientRect().width || 380;
    }

    detailResizeHandle.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startWidth = getDetailWidth();
      detailResizeHandle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      // Dragging left edge: moving mouse left = panel gets wider
      var delta = startX - e.clientX;
      var maxWidth = Math.floor(document.body.clientWidth * MAX_DETAIL_WIDTH_RATIO);
      var newWidth = Math.max(MIN_DETAIL_WIDTH, Math.min(maxWidth, startWidth + delta));
      document.documentElement.style.setProperty("--detail-panel-width", newWidth + "px");
    });

    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      detailResizeHandle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  })();

  // ──────────────────────────────────────────────
  // Port connection to background
  // ──────────────────────────────────────────────

  var port = null;
  var portDead = false;
  var keepaliveTimer = null;

  // Keep service worker alive during profiling by pinging every 20s
  var KEEPALIVE_INTERVAL = 20000;

  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(function () {
      // A no-op message just to keep the SW port alive
      safeSend({ source: "mobx-devtools-panel", command: "ping" });
    }, KEEPALIVE_INTERVAL);
  }

  function stopKeepalive() {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function onPortMessage(msg) {
    if (!msg || msg.source !== "mobx-devtools-inject") return;

    if (msg.type === "spy-event-batch") {
      onSpyEventBatch(msg.payload);
    }

    if (msg.type === "status") {
      onStatusUpdate(msg.payload);
    }

    if (msg.type === "loaded") {
      // Page navigated — re-check URL and re-sync
      updateUrlCheck();
      syncFiltersToInject();
      sendCommand("detect");
    }
  }

  function connectPanel() {
    try {
      port = chrome.runtime.connect({ name: "mobx-devtools-panel" });
      portDead = false;
    } catch (e) {
      port = null;
      portDead = true;
      return;
    }

    port.onMessage.addListener(onPortMessage);

    port.onDisconnect.addListener(function () {
      port = null;
      portDead = true;
      // Read lastError to suppress "unchecked" warnings from bfcache/SW transitions
      void chrome.runtime.lastError;
      // Auto-reconnect after a short delay so the pipeline stays alive
      setTimeout(function () {
        connectPanel();
        if (port) {
          // Re-establish state: sync filters, re-detect
          syncFiltersToInject();
          sendCommand("detect");
          // If we were profiling, re-send the start command so inject resumes
          if (panelState === STATE_PROFILING) {
            sendCommand("start");
          }
        }
      }, 500);
    });

    try {
      port.postMessage({
        type: "init",
        tabId: chrome.devtools.inspectedWindow.tabId
      });
    } catch (e) {
      port = null;
      portDead = true;
    }
  }

  function safeSend(msg) {
    if (port) {
      try {
        port.postMessage(msg);
        return;
      } catch (e) {
        port = null;
        portDead = true;
      }
    }

    connectPanel();
    if (port) {
      try {
        port.postMessage(msg);
      } catch (e) {
        port = null;
        portDead = true;
      }
    }
  }

  connectPanel();

  function sendCommand(command) {
    safeSend({ source: "mobx-devtools-panel", command: command });
  }

  function sendCommandWithData(command, data) {
    safeSend({ source: "mobx-devtools-panel", command: command, data: data });
  }

  function syncFiltersToInject() {
    sendCommandWithData("set-filters", Array.from(enabledTypes));
  }

  // ──────────────────────────────────────────────
  // Memory management
  // ──────────────────────────────────────────────

  function clearAllData() {
    groups.clear();
    groupOrder = [];
    filteredGroupKeys = [];
    totalEventCount = 0;
    selectedGroupKey = null;
    selectedEventIndex = -1;
    detailRenderedCount = 0;
    searchQuery = "";
    searchInput.value = "";
  }

  // ──────────────────────────────────────────────
  // Panel state transitions
  // ──────────────────────────────────────────────

  function showView(viewName) {
    // Hide everything first
    emptyState.classList.add("hidden");
    blockedState.classList.add("hidden");
    profilingScreen.classList.add("hidden");
    eventListContainer.classList.add("hidden");
    detailPanel.classList.add("hidden");

    switch (viewName) {
      case STATE_IDLE:
        emptyState.classList.remove("hidden");
        break;
      case "blocked":
        blockedState.classList.remove("hidden");
        break;
      case STATE_PROFILING:
        profilingScreen.classList.remove("hidden");
        break;
      case STATE_STOPPED:
        eventListContainer.classList.remove("hidden");
        // detail panel is shown/hidden independently via openGroupDetail/closeDetail
        break;
    }
  }

  function showBlockedState() {
    blockedUrl.textContent = inspectedUrl ? "Current URL: " + inspectedUrl : "";
    showView("blocked");
    setStatus("error", "Blocked");
  }

  function transitionTo(newState) {
    panelState = newState;
    updateToolbarState();

    switch (newState) {
      case STATE_IDLE:
        stopKeepalive();
        showView(STATE_IDLE);
        renderMobxInfo();
        break;
      case STATE_PROFILING:
        startKeepalive();
        profilingCount.textContent = "0 events captured";
        showView(STATE_PROFILING);
        break;
      case STATE_STOPPED:
        stopKeepalive();
        // Build results and show
        applyFilters();
        updateEventCount();
        renderFilterCheckboxes();
        showView(STATE_STOPPED);
        break;
    }
  }

  // ──────────────────────────────────────────────
  // Grouping logic
  // ──────────────────────────────────────────────

  function getGroupKey(ev) {
    var name = ev.name || "(anonymous)";
    if (ev.type === "action") {
      var cls = ev._objectClass || "";
      return "action:" + name + ":" + cls;
    }
    return ev.type + ":" + name;
  }

  function getDisplayName(ev) {
    var name = ev.name || "(anonymous)";
    if (ev.type === "action" && ev._objectClass) {
      return ev._objectClass + "." + name;
    }
    return name;
  }

  function addEventToGroup(ev) {
    var key = getGroupKey(ev);
    var group = groups.get(key);

    if (!group) {
      // Cap total number of groups (#10)
      if (groups.size >= MAX_GROUPS) return;

      group = {
        key: key,
        type: ev.type,
        name: ev.name || "(anonymous)",
        displayName: getDisplayName(ev),
        count: 0,
        lastTimestamp: 0,
        lastEvent: null,
        events: []
      };
      groups.set(key, group);
      groupOrder.push(key);
    }

    group.count++;
    group.lastTimestamp = ev._timestamp;
    group.lastEvent = ev;

    // Only store individual events for expandable types
    if (!NON_EXPANDABLE_TYPES.has(ev.type)) {
      group.events.push(ev);
      if (group.events.length > MAX_EVENTS_PER_GROUP) {
        group.events.shift();
      }
    }

    // Discover new event types dynamically
    if (ev.type && !KNOWN_EVENT_TYPES.includes(ev.type)) {
      KNOWN_EVENT_TYPES.push(ev.type);
    }
  }

  // ──────────────────────────────────────────────
  // Event handling
  // ──────────────────────────────────────────────

  function onSpyEventBatch(batch) {
    if (!Array.isArray(batch) || batch.length === 0) return;
    // Cap incoming batch size to prevent DoS (#10)
    if (batch.length > 10000) batch = batch.slice(0, 10000);

    for (var i = 0; i < batch.length; i++) {
      addEventToGroup(batch[i]);
    }

    totalEventCount += batch.length;
    if (totalEventCount > MAX_TOTAL_EVENTS) totalEventCount = MAX_TOTAL_EVENTS;

    // During profiling, just update the counter overlay
    if (panelState === STATE_PROFILING) {
      profilingCount.textContent = totalEventCount + " events captured";
    }
  }

  function onStatusUpdate(status) {
    mobxDetected = status.detected;

    // Store detection info for idle screen display
    if (status.detectionInfo) {
      mobxDetectionInfo = status.detectionInfo;
    }

    // Re-render detection info if on the idle screen
    if (panelState === STATE_IDLE) {
      renderMobxInfo();
    }

    // Sync panel state with inject.js status
    // If inject.js confirms monitoring started and we're profiling, stay profiling
    // If inject.js confirms monitoring stopped and we're profiling, transition to stopped
    if (status.monitoring && panelState === STATE_PROFILING) {
      // Expected: we asked to start, inject confirmed
      updateToolbarState();
    } else if (!status.monitoring && panelState === STATE_PROFILING) {
      // inject.js stopped unexpectedly (page nav?) — show whatever we have
      if (totalEventCount > 0) {
        transitionTo(STATE_STOPPED);
      } else {
        transitionTo(STATE_IDLE);
      }
    }

    if (status.error) {
      setStatus("error", status.error);
    }
  }

  // ──────────────────────────────────────────────
  // Filtering
  // ──────────────────────────────────────────────

  function applyFilters() {
    var query = searchQuery.toLowerCase();

    filteredGroupKeys = [];

    for (var i = 0; i < groupOrder.length; i++) {
      var key = groupOrder[i];
      var group = groups.get(key);
      if (!group) continue;

      // Type filter
      if (!enabledTypes.has(group.type)) continue;

      // Search filter
      if (query) {
        var searchable = (
          group.type + " " +
          group.displayName + " " +
          (group.lastEvent ? JSON.stringify(group.lastEvent) : "")
        ).toLowerCase();
        if (searchable.indexOf(query) === -1) continue;
      }

      filteredGroupKeys.push(key);
    }

    renderEventList();
  }

  // ──────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────

  function renderEventList() {
    // Clear existing rows
    eventList.innerHTML = "";

    if (filteredGroupKeys.length === 0) {
      var noResults = document.createElement("div");
      noResults.className = "empty-state";
      var noResultsP = document.createElement("p");
      noResultsP.textContent = "No events match the current filters.";
      noResults.appendChild(noResultsP);
      eventList.appendChild(noResults);
      return;
    }

    var fragment = document.createDocumentFragment();

    for (var i = 0; i < filteredGroupKeys.length; i++) {
      var key = filteredGroupKeys[i];
      var group = groups.get(key);
      if (!group) continue;

      var expandable = !NON_EXPANDABLE_TYPES.has(group.type);
      var safeType = sanitizeCssClass(group.type);

      var row = document.createElement("div");
      row.className = "group-row event-type-" + safeType;
      if (key === selectedGroupKey) row.classList.add("selected");
      if (!expandable) row.classList.add("no-expand");
      row.dataset.groupKey = key;

      // Build row content using DOM APIs instead of innerHTML (#6)
      var colExpand = document.createElement("span");
      colExpand.className = "col-expand";
      if (expandable) colExpand.textContent = "\u25B6";

      var colCount = document.createElement("span");
      colCount.className = "col-count";
      var countBadge = document.createElement("span");
      countBadge.className = "count-badge";
      countBadge.textContent = group.count;
      colCount.appendChild(countBadge);

      var colTime = document.createElement("span");
      colTime.className = "col-time";
      colTime.textContent = formatTime(group.lastTimestamp);

      var colType = document.createElement("span");
      colType.className = "col-type";
      var typeBadge = document.createElement("span");
      typeBadge.className = "type-badge type-" + safeType;
      typeBadge.textContent = group.type;
      colType.appendChild(typeBadge);

      var colName = document.createElement("span");
      colName.className = "col-name";
      colName.textContent = group.displayName;

      row.appendChild(colExpand);
      row.appendChild(colCount);
      row.appendChild(colTime);
      row.appendChild(colType);
      row.appendChild(colName);

      if (expandable) {
        row.addEventListener("click", (function (capturedKey) {
          return function () { openGroupDetail(capturedKey); };
        })(key));
      }

      fragment.appendChild(row);
    }

    eventList.appendChild(fragment);
  }

  /**
   * Open the detail panel showing all retained events for a group.
   */
  function openGroupDetail(key) {
    var group = groups.get(key);
    if (!group) return;

    // Toggle off if clicking the same group
    if (selectedGroupKey === key) {
      closeDetail();
      return;
    }

    selectedGroupKey = key;
    selectedEventIndex = -1;

    detailTitle.textContent = group.displayName + " (" + group.count + ")";
    detailPanel.classList.remove("hidden");
    detailContent.textContent = "";

    renderDetailEventList(group);
    highlightSelectedGroup();
  }

  /**
   * Render the list of individual events in the detail panel for a group.
   */
  function renderDetailEventList(group) {
    detailEventList.innerHTML = "";
    detailRenderedCount = 0;

    var evts = group.events;

    // Trimmed notice
    if (group.count > evts.length) {
      var notice = document.createElement("div");
      notice.className = "detail-trimmed-notice";
      notice.textContent = (group.count - evts.length) + " older events not retained in memory";
      detailEventList.appendChild(notice);
    }

    for (var i = 0; i < evts.length; i++) {
      appendDetailEventRow(evts[i], i);
    }

    detailRenderedCount = evts.length;
  }

  /**
   * Append a single event row to the detail event list.
   */
  function appendDetailEventRow(ev, index) {
    var row = document.createElement("div");
    row.className = "detail-event-row";
    row.dataset.eventIndex = index;

    if (index === selectedEventIndex) {
      row.classList.add("selected");
    }

    // Build row content using DOM APIs instead of innerHTML (#6)
    var evId = document.createElement("span");
    evId.className = "detail-ev-id";
    evId.textContent = "#" + ev._id;

    var evTime = document.createElement("span");
    evTime.className = "detail-ev-time";
    evTime.textContent = formatTime(ev._timestamp);

    var evSummary = document.createElement("span");
    evSummary.className = "detail-ev-summary";
    evSummary.textContent = summarizeEvent(ev);

    row.appendChild(evId);
    row.appendChild(evTime);
    row.appendChild(evSummary);

    row.addEventListener("click", (function (capturedIdx) {
      return function () { selectDetailEvent(capturedIdx); };
    })(index));

    detailEventList.appendChild(row);
  }

  /**
   * Select an individual event in the detail panel to show its full JSON.
   */
  // Internal metadata keys — used for grouping/display but hidden from tree viewer
  var INTERNAL_KEYS = { "_id": true, "_timestamp": true, "_objectClass": true };

  function selectDetailEvent(index) {
    var group = groups.get(selectedGroupKey);
    if (!group) return;

    var ev = group.events[index];
    if (!ev) return;

    // Strip internal metadata before showing in tree viewer
    var display = {};
    var keys = Object.keys(ev);
    for (var i = 0; i < keys.length; i++) {
      if (!INTERNAL_KEYS[keys[i]]) {
        display[keys[i]] = ev[keys[i]];
      }
    }

    selectedEventIndex = index;
    detailContent.innerHTML = "";
    detailContent.appendChild(buildTreeView(display));

    // Update selected state
    var rows = detailEventList.querySelectorAll(".detail-event-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("selected", parseInt(rows[i].dataset.eventIndex) === index);
    }
  }

  // ──────────────────────────────────────────────
  // Tree viewer
  // ──────────────────────────────────────────────

  function buildTreeView(value) {
    var root = document.createElement("div");
    root.className = "tree-root";
    renderTreeNode(root, null, value, true);
    return root;
  }

  function renderTreeNode(parent, key, value, expandedByDefault) {
    var isObj = value !== null && typeof value === "object" && !Array.isArray(value);
    var isArr = Array.isArray(value);
    var isExpandable = isObj || isArr;

    var row = document.createElement("div");
    row.className = "tree-row";

    if (isExpandable) {
      var entryCount = isArr ? value.length : Object.keys(value).length;

      var arrow = document.createElement("span");
      arrow.className = "tree-arrow";
      arrow.textContent = expandedByDefault ? "\u25BC" : "\u25B6";
      row.appendChild(arrow);

      if (key !== null) {
        var keySpan = document.createElement("span");
        keySpan.className = "tree-key";
        keySpan.textContent = key + ": ";
        row.appendChild(keySpan);
      }

      var preview = document.createElement("span");
      preview.className = "tree-preview";
      preview.textContent = isArr
        ? "Array(" + entryCount + ")"
        : getObjectPreview(value, entryCount);
      row.appendChild(preview);

      parent.appendChild(row);

      var children = document.createElement("div");
      children.className = "tree-children";
      if (!expandedByDefault) children.classList.add("hidden");

      if (isArr) {
        for (var i = 0; i < value.length; i++) {
          renderTreeNode(children, i, value[i], false);
        }
      } else {
        var keys = Object.keys(value);
        for (var j = 0; j < keys.length; j++) {
          renderTreeNode(children, keys[j], value[keys[j]], false);
        }
      }

      parent.appendChild(children);

      arrow.addEventListener("click", function (e) {
        e.stopPropagation();
        var isHidden = children.classList.contains("hidden");
        children.classList.toggle("hidden");
        arrow.textContent = isHidden ? "\u25BC" : "\u25B6";
      });

      row.addEventListener("click", function (e) {
        e.stopPropagation();
        var isHidden = children.classList.contains("hidden");
        children.classList.toggle("hidden");
        arrow.textContent = isHidden ? "\u25BC" : "\u25B6";
      });

    } else {
      var indent = document.createElement("span");
      indent.className = "tree-leaf-indent";
      row.appendChild(indent);

      if (key !== null) {
        var leafKey = document.createElement("span");
        leafKey.className = "tree-key";
        leafKey.textContent = key + ": ";
        row.appendChild(leafKey);
      }

      var valSpan = document.createElement("span");
      valSpan.className = "tree-value " + getValueClass(value);
      valSpan.textContent = formatLeafValue(value);
      row.appendChild(valSpan);

      parent.appendChild(row);
    }
  }

  function getObjectPreview(obj, keyCount) {
    if (obj.__type) return obj.__type + " {" + keyCount + "}";
    return "{" + keyCount + "}";
  }

  function formatLeafValue(val) {
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    if (typeof val === "string") {
      if (val === "[undefined]" || val === "[NaN]" || val === "[Infinity]" ||
          val === "[-Infinity]" || val === "[Circular]" || val === "[Object: max depth]" ||
          val === "[Object: unreadable keys]" ||
          val.indexOf("[Function") === 0 || val.indexOf("[Unserializable") === 0 ||
          val.indexOf("[Unreadable") === 0 || val.indexOf("Symbol(") === 0 ||
          /^\d+n$/.test(val)) {
        return val;
      }
      return '"' + val + '"';
    }
    return String(val);
  }

  function getValueClass(val) {
    if (val === null || val === undefined) return "tree-val-null";
    var t = typeof val;
    if (t === "string") {
      if (val === "[undefined]" || val === "[NaN]" || val === "[Infinity]" ||
          val === "[-Infinity]" || val === "[Circular]" || val === "[Object: max depth]" ||
          val === "[Object: unreadable keys]" ||
          val.indexOf("[Function") === 0 || val.indexOf("[Unserializable") === 0 ||
          val.indexOf("[Unreadable") === 0) {
        return "tree-val-special";
      }
      if (val.indexOf("Symbol(") === 0 || /^\d+n$/.test(val)) return "tree-val-special";
      return "tree-val-string";
    }
    if (t === "number") return "tree-val-number";
    if (t === "boolean") return "tree-val-boolean";
    return "tree-val-string";
  }

  function closeDetail() {
    selectedGroupKey = null;
    selectedEventIndex = -1;
    detailRenderedCount = 0;
    detailPanel.classList.add("hidden");
    detailEventList.innerHTML = "";
    detailContent.textContent = "";
    highlightSelectedGroup();
  }

  function highlightSelectedGroup() {
    var rows = eventList.querySelectorAll(".group-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("selected", rows[i].dataset.groupKey === selectedGroupKey);
    }
  }

  function renderFilterCheckboxes() {
    filterCheckboxes.innerHTML = "";

    for (var i = 0; i < KNOWN_EVENT_TYPES.length; i++) {
      var type = KNOWN_EVENT_TYPES[i];

      var label = document.createElement("label");
      label.className = "filter-checkbox";

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = enabledTypes.has(type);
      checkbox.dataset.type = type;

      checkbox.addEventListener("change", (function (capturedType) {
        return function () {
          if (this.checked) {
            enabledTypes.add(capturedType);
          } else {
            enabledTypes.delete(capturedType);
          }
          syncFiltersToInject();
          if (panelState === STATE_STOPPED) {
            applyFilters();
            updateEventCount();
          }
        };
      })(type));

      var badge = document.createElement("span");
      badge.className = "type-badge type-" + sanitizeCssClass(type);
      badge.textContent = type;

      // Count events of this type across all groups
      var count = document.createElement("span");
      count.className = "filter-count";
      var c = 0;
      for (var j = 0; j < groupOrder.length; j++) {
        var g = groups.get(groupOrder[j]);
        if (g && g.type === type) c += g.count;
      }
      count.textContent = c;

      label.appendChild(checkbox);
      label.appendChild(badge);
      label.appendChild(count);
      filterCheckboxes.appendChild(label);
    }
  }

  // ──────────────────────────────────────────────
  // MobX detection info display (idle screen)
  // ──────────────────────────────────────────────

  function renderMobxInfo() {
    // Clear previous content
    mobxInfoEl.innerHTML = "";

    if (!mobxDetectionInfo) {
      // No detection info yet — show "searching" state
      var searching = document.createElement("div");
      searching.className = "mobx-info-status mobx-info-searching";
      var dot = document.createElement("span");
      dot.className = "mobx-info-dot searching";
      searching.appendChild(dot);
      var text = document.createElement("span");
      text.textContent = "Searching for MobX...";
      searching.appendChild(text);
      mobxInfoEl.appendChild(searching);
      return;
    }

    var info = mobxDetectionInfo;

    if (!mobxDetected) {
      // MobX not found
      var notFound = document.createElement("div");
      notFound.className = "mobx-info-status mobx-info-not-found";
      var dot2 = document.createElement("span");
      dot2.className = "mobx-info-dot not-found";
      notFound.appendChild(dot2);
      var text2 = document.createElement("span");
      text2.textContent = "MobX not detected on this page";
      notFound.appendChild(text2);
      mobxInfoEl.appendChild(notFound);
      return;
    }

    // MobX found — show detection summary
    var found = document.createElement("div");
    found.className = "mobx-info-status mobx-info-found";
    var dot3 = document.createElement("span");
    dot3.className = "mobx-info-dot found";
    found.appendChild(dot3);
    var summary = document.createElement("span");
    var summaryParts = ["MobX detected"];
    if (info.version) summaryParts[0] += " v" + info.version;
    if (info.detectionMethod) summaryParts.push("via " + info.detectionMethod);
    if (info.spyListenersCount !== null) summaryParts.push(info.spyListenersCount + " spy listener(s)");
    summary.textContent = summaryParts.join("  \u00B7  ");
    found.appendChild(summary);
    mobxInfoEl.appendChild(found);

    // Show __mobxGlobals detail table if available
    if (info.mobxGlobals && typeof info.mobxGlobals === "object") {
      var globalsKeys = Object.keys(info.mobxGlobals);
      if (globalsKeys.length > 0) {
        var details = document.createElement("details");
        details.className = "mobx-info-details";
        var summaryEl = document.createElement("summary");
        summaryEl.textContent = "window.__mobxGlobals (" + globalsKeys.length + " keys)";
        details.appendChild(summaryEl);

        var table = document.createElement("table");
        table.className = "mobx-info-table";
        var tbody = document.createElement("tbody");

        for (var i = 0; i < globalsKeys.length; i++) {
          var k = globalsKeys[i];
          var tr = document.createElement("tr");
          var tdKey = document.createElement("td");
          tdKey.className = "mobx-info-key";
          tdKey.textContent = k;
          var tdVal = document.createElement("td");
          tdVal.className = "mobx-info-val";
          var rawVal = info.mobxGlobals[k];
          tdVal.textContent = rawVal === null ? "null" : String(rawVal);
          // Color-code value types
          if (typeof rawVal === "number") tdVal.classList.add("val-number");
          else if (typeof rawVal === "boolean") tdVal.classList.add("val-boolean");
          else if (typeof rawVal === "string" && rawVal.charAt(0) === "[") tdVal.classList.add("val-special");
          else if (rawVal === null) tdVal.classList.add("val-null");
          tr.appendChild(tdKey);
          tr.appendChild(tdVal);
          tbody.appendChild(tr);
        }

        table.appendChild(tbody);
        details.appendChild(table);
        mobxInfoEl.appendChild(details);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Toolbar state
  // ──────────────────────────────────────────────

  function updateToolbarState() {
    // If not a dev URL, always disable both buttons
    if (!isDevUrl) {
      btnStart.disabled = true;
      btnStop.disabled = true;
      btnDownload.disabled = true;
      btnStart.classList.remove("active");
      return;
    }

    switch (panelState) {
      case STATE_IDLE:
        btnStart.disabled = false;
        btnStop.disabled = true;
        btnDownload.disabled = true;
        btnStart.classList.remove("active");
        setStatus("inactive", "Idle");
        break;
      case STATE_PROFILING:
        btnStart.disabled = true;
        btnStop.disabled = false;
        btnDownload.disabled = true;
        btnStart.classList.add("active");
        setStatus("recording", "Recording");
        break;
      case STATE_STOPPED:
        btnStart.disabled = false;
        btnStop.disabled = true;
        btnDownload.disabled = false;
        btnStart.classList.remove("active");
        setStatus("paused", "Stopped");
        break;
    }
  }

  function setStatus(state, text) {
    statusIndicator.className = "status-dot status-" + sanitizeCssClass(state);
    statusText.textContent = text;
  }

  function updateEventCount() {
    var groupCount = filteredGroupKeys.length;
    eventCount.textContent = totalEventCount + " events / " + groupCount + " groups";
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  function formatTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return (
      pad(d.getHours()) + ":" +
      pad(d.getMinutes()) + ":" +
      pad(d.getSeconds()) + "." +
      pad3(d.getMilliseconds())
    );
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function pad3(n) { return n < 10 ? "00" + n : n < 100 ? "0" + n : "" + n; }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Sanitize a string for safe use as a CSS class name suffix.
   * Only allows alphanumeric characters and hyphens. All others are stripped.
   * Prevents CSS class injection (#7).
   */
  function sanitizeCssClass(str) {
    if (!str) return "unknown";
    return str.replace(/[^a-zA-Z0-9\-]/g, "");
  }

  function summarizeEvent(ev) {
    if (!ev) return "";
    switch (ev.type) {
      case "action":
        return ev.arguments
          ? "args: [" + (Array.isArray(ev.arguments) ? ev.arguments.length : "?") + "]"
          : "";
      case "reaction":
      case "scheduled-reaction":
        return "";
      case "update":
        var updateParts = [];
        if (ev.name) updateParts.push(ev.name);
        if (ev.oldValue !== undefined && ev.newValue !== undefined) {
          updateParts.push(truncate(JSON.stringify(ev.oldValue), 30) + " -> " + truncate(JSON.stringify(ev.newValue), 30));
        }
        return updateParts.join(" ");
      case "splice":
        return "added:" + (ev.addedCount || 0) + " removed:" + (ev.removedCount || 0);
      case "add":
        return (ev.name ? ev.name + " = " : "") + truncate(JSON.stringify(ev.newValue), 60);
      case "remove":
        return (ev.name || "") + (ev.oldValue !== undefined ? " was " + truncate(JSON.stringify(ev.oldValue), 40) : "");
      case "delete":
        return (ev.name || "") + (ev.oldValue !== undefined ? " was " + truncate(JSON.stringify(ev.oldValue), 40) : "");
      case "error":
        return ev.message || "";
      default:
        return "";
    }
  }

  function truncate(str, max) {
    if (!str) return "";
    return str.length > max ? str.substring(0, max) + "..." : str;
  }

  // ──────────────────────────────────────────────
  // Export / Download
  // ──────────────────────────────────────────────

  /**
   * Build a JSON-serializable export of all profiling data.
   * Includes metadata, group summaries, and retained individual events.
   */
  function buildExportData() {
    var exportGroups = [];
    for (var i = 0; i < groupOrder.length; i++) {
      var key = groupOrder[i];
      var group = groups.get(key);
      if (!group) continue;

      exportGroups.push({
        key: group.key,
        type: group.type,
        name: group.name,
        displayName: group.displayName,
        count: group.count,
        lastTimestamp: group.lastTimestamp,
        events: group.events.slice() // shallow copy of retained events
      });
    }

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      url: inspectedUrl || null,
      totalEventCount: totalEventCount,
      groupCount: groupOrder.length,
      enabledTypes: Array.from(enabledTypes),
      detectionInfo: mobxDetectionInfo || null,
      groups: exportGroups
    };
  }

  /**
   * Trigger a JSON file download of the profiling data.
   * Uses Blob + object URL + programmatic <a> click.
   */
  function downloadProfilingData() {
    var data = buildExportData();
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: "application/json" });
    var url = URL.createObjectURL(blob);

    // Generate filename with timestamp
    var now = new Date();
    var timestamp = now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) + "-" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());
    var filename = "mobxspy-" + timestamp + ".json";

    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    // Cleanup
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // ──────────────────────────────────────────────
  // Button event listeners
  // ──────────────────────────────────────────────

  btnStart.addEventListener("click", function () {
    if (panelState === STATE_PROFILING) return;
    if (!isDevUrl) return;

    // Clear all previous data (panel + inject side)
    clearAllData();
    sendCommand("clear-buffer");

    // Clear the DOM
    eventList.innerHTML = "";
    closeDetail();

    // Start profiling
    syncFiltersToInject();
    sendCommand("start");
    transitionTo(STATE_PROFILING);
  });

  btnStop.addEventListener("click", function () {
    if (panelState !== STATE_PROFILING) return;

    // Stop profiling — inject.js will flush remaining buffered events
    sendCommand("stop");

    // Small delay to allow the final flush to arrive before rendering results
    setTimeout(function () {
      if (totalEventCount > 0) {
        transitionTo(STATE_STOPPED);
      } else {
        transitionTo(STATE_IDLE);
      }
    }, 200);
  });

  btnFilters.addEventListener("click", function () {
    filterPanel.classList.toggle("hidden");
    renderFilterCheckboxes();
  });

  btnDownload.addEventListener("click", function () {
    if (panelState !== STATE_STOPPED) return;
    if (totalEventCount === 0) return;
    downloadProfilingData();
  });

  btnCloseDetail.addEventListener("click", function () {
    closeDetail();
  });

  var searchTimeout;
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function () {
      searchQuery = searchInput.value.trim();
      if (panelState === STATE_STOPPED) {
        applyFilters();
      }
    }, 200);
  });

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      searchInput.focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (panelState === STATE_STOPPED && totalEventCount > 0) {
        downloadProfilingData();
      }
    }
    if (e.key === "Escape") {
      if (!detailPanel.classList.contains("hidden")) {
        btnCloseDetail.click();
      }
    }
  });

  // ──────────────────────────────────────────────
  // Cleanup on panel close (devtools close)
  // ──────────────────────────────────────────────

  window.addEventListener("beforeunload", function () {
    stopKeepalive();
    // Stop monitoring if active
    if (panelState === STATE_PROFILING) {
      sendCommand("stop");
    }
    // Clear all memory
    clearAllData();
  });

  // ──────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────

  renderFilterCheckboxes();
  transitionTo(STATE_IDLE);
  updateUrlCheck();
  syncFiltersToInject();
  sendCommand("detect");
})();
