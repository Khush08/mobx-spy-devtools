/**
 * devtools.js — Registers the MobX panel in Chrome DevTools.
 */
chrome.devtools.panels.create(
  "MobXSpy", // Panel title
  null, // Icon path (null uses default)
  "panel.html", // Panel page
  function (panel) {
    // Panel created
  },
);
