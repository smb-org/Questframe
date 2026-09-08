// StreamElements Custom Widget: JS-Tab. Bewusst ES2018, damit auch alte
// OBS-CEF-Versionen das Skript parsen.
window.addEventListener('onWidgetLoad', function (event) {
  var data = event.detail.fieldData;
  var frame = document.getElementById('hudFrame');
  var error = document.getElementById('hudError');
  var url = String(data.overlayUrl || '').trim();

  // Nur https zulassen: eine Tippfehler-URL soll nicht als relativer Pfad
  // gegen streamelements.com aufgelöst werden.
  if (url.indexOf('https://') !== 0) {
    frame.style.display = 'none';
    error.style.display = 'block';
    console.error('[questframe] Ungültige Overlay-URL:', url);
    return;
  }

  frame.src = url;
});
