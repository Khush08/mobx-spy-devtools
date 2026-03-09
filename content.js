/**
 * content.js — Content script that bridges the page and the extension.
 *
 * - Injects inject.js into the page
 * - Relays messages bidirectionally between inject.js (via window.postMessage)
 *   and the background service worker (via chrome.runtime port)
 * - Handles port disconnection gracefully (no "disconnected port" errors)
 * - Uses a random nonce to authenticate postMessage traffic (#5)
 * - Handles bfcache (back/forward cache) lifecycle: disconnects cleanly on
 *   freeze, reconnects on resume
 */
(function () {
  "use strict";

  // ── Generate a cryptographic nonce for message auth (#5) ──
  var nonce = "";
  var nonceArray = new Uint8Array(16);
  crypto.getRandomValues(nonceArray);
  for (var n = 0; n < nonceArray.length; n++) {
    nonce += nonceArray[n].toString(16).padStart(2, "0");
  }

  // ── Inject the page-level script ─────────────
  var script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.dataset.mobxNonce = nonce;
  script.onload = function () { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  // ── Port management ──────────────────────────
  var port = null;
  var portDisconnected = false;
  var reconnectTimer = null;
  var extensionInvalidated = false;
  var frozen = false; // true when page is in bfcache

  // Max delay between reconnect attempts (exponential backoff caps here)
  var RECONNECT_BASE_DELAY = 500;
  var RECONNECT_MAX_DELAY = 5000;
  var reconnectAttempts = 0;

  function connectPort() {
    if (extensionInvalidated || frozen) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    try {
      port = chrome.runtime.connect({ name: "mobx-devtools-content" });
      // Read lastError to suppress "unchecked" warnings from bfcache transitions
      void chrome.runtime.lastError;
      portDisconnected = false;
      reconnectAttempts = 0;
    } catch (e) {
      port = null;
      portDisconnected = true;
      // If chrome.runtime.id is gone, the extension context is invalidated — stop retrying
      if (!chrome.runtime.id) {
        extensionInvalidated = true;
        return;
      }
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener(function (msg) {
      // Forward commands from devtools panel to the page.
      // Pass through the entire message so all fields (command, data, etc.) arrive.
      // Include the nonce so inject.js can verify the sender (#5).
      if (msg.source === "mobx-devtools-panel") {
        window.postMessage({
          source: "mobx-devtools-content",
          _nonce: nonce,
          command: msg.command,
          data: msg.data
        }, window.location.origin || "*");
      }
    });

    port.onDisconnect.addListener(function () {
      port = null;
      portDisconnected = true;
      // Read lastError to suppress "unchecked" warnings from bfcache transitions
      void chrome.runtime.lastError;
      // Don't reconnect if we're frozen (in bfcache) — resume handler will do it
      if (frozen) return;
      // Auto-reconnect so the panel→content→inject pipeline stays alive
      // (service worker may have gone idle and restarted)
      if (!extensionInvalidated && chrome.runtime.id) {
        scheduleReconnect();
      }
    });
  }

  function disconnectPort() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (port) {
      try { port.disconnect(); } catch (e) { /* ignore */ }
      port = null;
      portDisconnected = true;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null || frozen) return;
    var delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY);
    reconnectAttempts++;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectPort();
    }, delay);
  }

  function safeSend(data) {
    // Try to send on the existing port
    if (port) {
      try {
        port.postMessage(data);
        void chrome.runtime.lastError;
        return;
      } catch (e) {
        port = null;
        portDisconnected = true;
      }
    }

    // Try to reconnect once synchronously for this send
    if (portDisconnected && !extensionInvalidated && !frozen) {
      connectPort();
    }

    if (port) {
      try {
        port.postMessage(data);
        void chrome.runtime.lastError;
      } catch (e) {
        port = null;
        portDisconnected = true;
      }
    }
  }

  // Establish connection immediately so panel commands can flow down
  connectPort();

  // ── bfcache lifecycle ───────────────────────
  // When the page enters bfcache, Chrome freezes it and disconnects ports.
  // We disconnect proactively on "freeze" to avoid the unchecked lastError,
  // and reconnect on "resume" when the page comes back from bfcache.

  document.addEventListener("freeze", function () {
    frozen = true;
    disconnectPort();
  });

  document.addEventListener("resume", function () {
    frozen = false;
    reconnectAttempts = 0;
    connectPort();
  });

  // Also handle pageshow with persisted flag (bfcache restore in older Chrome)
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
      frozen = false;
      reconnectAttempts = 0;
      if (!port) {
        connectPort();
      }
    }
  });

  // ── Page -> Extension relay ──────────────────
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== "mobx-devtools-inject") return;
    // Validate nonce — reject spoofed messages (#5)
    if (event.data._nonce !== nonce) return;
    safeSend(event.data);
  });
})();
