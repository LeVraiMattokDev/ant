// Applies the saved theme before first paint (external file so a strict CSP without 'unsafe-inline' still works).
(function () {
  try {
    var t = localStorage.getItem('ant-theme');
    document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
  } catch (e) {
    /* storage unavailable: keep the dark default */
  }
})();
