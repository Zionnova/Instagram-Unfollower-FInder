/* Applies a saved light/dark choice before the page paints. Without one, the page follows the system setting. */
(function () {
  try {
    var saved = localStorage.getItem('unfollower-finder.theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    /* storage unavailable: follow the system setting */
  }
})();
