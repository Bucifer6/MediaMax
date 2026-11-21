/* The offline page's script (served by the service worker when the server can't be reached). It shows the server's
 * name, logo and colours as the web app last saw them (localStorage "mm.offlineBrand", written by
 * web/src/sw/register.ts), polls the server every few seconds and reloads the page as soon as it answers. */
(function () {
  var BASE = '%BASE%';
  var EVERY = 5;
  var brand = null;
  try { brand = JSON.parse(localStorage.getItem('mm.offlineBrand') || 'null'); } catch (e) { brand = null; }
  try { if (localStorage.getItem('mm.tv') === '1') document.documentElement.classList.add('tv'); } catch (e) { /* storage blocked */ }

  var $ = function (id) { return document.getElementById(id); };
  var logo = $('logo');
  var name = (brand && typeof brand.name === 'string' && brand.name.trim()) || 'MediaMax';
  var stock = name === 'MediaMax';
  var light = !!(brand && brand.mode === 'light');
  $('name').textContent = name;
  document.title = name + ': server offline';

  if (brand && brand.colors && window.CSS && CSS.supports) {
    var map = { bg: '--bg', text: '--text', muted: '--muted', accent: '--accent', primary: '--primary', primaryText: '--primary-text' };
    for (var k in map) {
      var v = brand.colors[k];
      if (typeof v === 'string' && CSS.supports('color', v)) document.documentElement.style.setProperty(map[k], v);
    }
  }

  function img(src, alt, onFail) {
    var el = document.createElement('img');
    el.alt = alt;
    el.onerror = onFail || null;
    el.src = src;
    return el;
  }
  function fallbackLogo() {
    logo.textContent = '';
    if (stock) {
      logo.appendChild(img(BASE + 'brand/wordmark-' + (light ? 'light' : 'dark') + '.svg', 'MediaMax'));
    } else {
      logo.appendChild(img(BASE + 'brand/mark.svg', ''));
      var t = document.createElement('span');
      t.className = 'name';
      t.textContent = name;
      logo.appendChild(t);
    }
  }
  // The server's own logo comes from the browser's HTTP cache if it is there (branding files are cached as immutable);
  // the service worker never stores it. Without it: the MediaMax wordmark, or the mark plus the server's name.
  var logoUrl = brand && typeof brand.logo === 'string' && /^(\/|https?:)/.test(brand.logo) ? brand.logo : null;
  if (logoUrl) {
    logo.textContent = '';
    logo.appendChild(img(logoUrl, name, fallbackLogo));
  } else fallbackLogo();

  var status = $('status');
  var left = EVERY;
  var busy = false;
  function check() {
    if (busy) return;
    busy = true;
    status.textContent = 'Connecting…';
    var done = function (ok) {
      busy = false;
      if (ok) {
        status.textContent = 'Back online. Loading…';
        location.reload();
        return;
      }
      left = EVERY;
      status.textContent = 'Retrying in ' + left + ' s';
    };
    var timer = setTimeout(function () { done(false); done = function () {}; }, 4000);
    fetch(BASE + 'api/v1/system/info', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { clearTimeout(timer); done(r.ok); })
      .catch(function () { clearTimeout(timer); done(false); });
  }
  setInterval(function () {
    if (busy) return;
    left -= 1;
    if (left <= 0) check();
    else status.textContent = 'Retrying in ' + left + ' s';
  }, 1000);
  $('retry').addEventListener('click', check);
  window.addEventListener('online', check);
  $('retry').focus();
  check();
})();
