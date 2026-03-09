/**
 * background.js — Service worker that manages connections between
 * content scripts and devtools panels.
 *
 * Message flow:
 *   Content Script --port "mobx-devtools-content"--> Background --> Panel
 *   Panel          --port "mobx-devtools-panel"-->   Background --> Content Script
 *
 * Key behaviors:
 *  - Routes messages by tabId
 *  - Buffers panel->content messages if content port hasn't connected yet
 *  - Safely handles disconnected ports without throwing
 */
"use strict";

// Map<tabId, { content: Port|null, panel: Port|null, pendingToContent: Array }>
var connections = new Map();

// Max buffered messages to content script before dropping (#15)
var MAX_PENDING_MESSAGES = 500;

function getConnection(tabId) {
  if (!connections.has(tabId)) {
    connections.set(tabId, { content: null, panel: null, pendingToContent: [] });
  }
  return connections.get(tabId);
}

function cleanupConnection(tabId) {
  var conn = connections.get(tabId);
  if (conn && !conn.content && !conn.panel) {
    connections.delete(tabId);
  }
}

/**
 * Safely post a message to a port. Returns false if the port is dead.
 * Reads chrome.runtime.lastError to suppress "unchecked" warnings
 * (e.g. when the receiving page is in the bfcache).
 */
function safeSend(port, msg) {
  if (!port) return false;
  try {
    port.postMessage(msg);
    // Reading lastError clears the "unchecked runtime.lastError" warning
    // that Chrome surfaces when the port's page entered the bfcache.
    void chrome.runtime.lastError;
    return true;
  } catch (e) {
    return false;
  }
}

chrome.runtime.onConnect.addListener(function (port) {

  // ── Content script connection ────────────────
  if (port.name === "mobx-devtools-content") {
    var tabId = port.sender && port.sender.tab && port.sender.tab.id;
    if (!tabId) return;

    var conn = getConnection(tabId);
    conn.content = port;

    // Flush any messages that the panel sent before content was connected
    if (conn.pendingToContent.length > 0) {
      for (var i = 0; i < conn.pendingToContent.length; i++) {
        safeSend(port, conn.pendingToContent[i]);
      }
      conn.pendingToContent = [];
    }

    port.onMessage.addListener(function (msg) {
      safeSend(conn.panel, msg);
    });

    port.onDisconnect.addListener(function () {
      // Only null if this is still the active content port (not replaced by a newer one)
      if (conn.content === port) {
        conn.content = null;
      }
      cleanupConnection(tabId);
    });
  }

  // ── DevTools panel connection ────────────────
  if (port.name === "mobx-devtools-panel") {
    // The panel sends its tabId as the first message
    port.onMessage.addListener(function onInit(msg) {
      if (msg.type === "init" && msg.tabId) {
        var tabId = msg.tabId;

        // Verify that the claimed tabId corresponds to an actual open tab (#12).
        // This prevents a compromised extension page from routing messages to
        // an arbitrary tab it shouldn't have access to.
        chrome.tabs.get(tabId, function (tab) {
          if (chrome.runtime.lastError || !tab) {
            // Tab doesn't exist — reject silently
            try { port.disconnect(); } catch (e) { /* ignore */ }
            return;
          }

          var conn = getConnection(tabId);
          conn.panel = port;

          // Remove init listener, replace with relay listener
          port.onMessage.removeListener(onInit);

          port.onMessage.addListener(function (panelMsg) {
            // Keepalive pings don't need to be forwarded or buffered
            if (panelMsg.command === "ping") return;
            // If content script isn't connected yet, buffer the message
            if (!safeSend(conn.content, panelMsg)) {
              // Cap pendingToContent buffer (#15)
              if (conn.pendingToContent.length < MAX_PENDING_MESSAGES) {
                conn.pendingToContent.push(panelMsg);
              }
            }
          });

          port.onDisconnect.addListener(function () {
            // Only null if this is still the active panel port (not replaced by a newer one)
            if (conn.panel === port) {
              conn.panel = null;
            }
            cleanupConnection(tabId);
          });
        });
      }
    });
  }
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  connections.delete(tabId);
});
