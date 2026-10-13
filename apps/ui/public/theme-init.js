// Applies the saved theme before first paint (external file so a strict CSP without 'unsafe-inline' still works).
// Served as is (not transpiled): ES5 only. The colours match setTheme() in src/lib/theme.ts.
(function () {
  try {
    var t = localStorage.getItem('ant-theme') === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    // index.html declares the dark colour; the browser and system bars must follow a saved light theme too.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#ffffff' : '#1c1c1c');
  } catch (e) {
    /* storage unavailable: keep the dark default */
  }
})();
