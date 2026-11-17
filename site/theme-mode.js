'use strict';

// Light/dark mode for the website and the admin portal. Loaded in <head> before the stylesheets
// are applied, so a dark page never flashes light first. Follows the device setting until the
// visitor presses the sun/moon button; their choice is remembered in this browser.
(function () {
  var root = document.documentElement;
  if (root.getAttribute('data-dark') === 'off') return;
  var KEY = 'fh-color-mode';
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try {
      var value = window.localStorage.getItem(KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch (err) {
      return null;
    }
  }

  function remember(mode) {
    try {
      // Matching the device again means "follow the device" from now on.
      if (mode === system()) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, mode);
    } catch (err) {
      // Private browsing: the choice lasts for this page only.
    }
  }

  function system() {
    return query && query.matches ? 'dark' : 'light';
  }

  function label() {
    var dark = root.getAttribute('data-color-mode') === 'dark';
    var buttons = document.querySelectorAll('[data-mode-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      buttons[i].setAttribute('title', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }

  function apply(mode) {
    root.setAttribute('data-color-mode', mode || saved() || system());
    label();
  }

  apply();

  if (query) {
    var onDeviceChange = function () {
      if (!saved()) apply();
    };
    if (query.addEventListener) query.addEventListener('change', onDeviceChange);
    else if (query.addListener) query.addListener(onDeviceChange);
  }
  // Another tab changed the choice.
  window.addEventListener('storage', function (event) {
    if (event.key === KEY || event.key === null) apply();
  });
  document.addEventListener('DOMContentLoaded', label);
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-mode-toggle]') : null;
    if (!button) return;
    var next = root.getAttribute('data-color-mode') === 'dark' ? 'light' : 'dark';
    remember(next);
    apply(next);
  });
}());
