// /repeater: the claim hand-off when the URL carries a claim, the setup guide otherwise.
//
// Everything here is progressive. With the script blocked the guide still renders with every
// panel open, which is worse to look at and loses nothing. Nothing is sent anywhere: the claim is
// read from the fragment, which never reaches this origin, and platform detection stays in the
// page.
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  // ── Copy buttons ────────────────────────────────────────────────────────────

  function wireCopy(button, text) {
    button.addEventListener('click', function () {
      var value = typeof text === 'function' ? text() : text;
      if (!navigator.clipboard) {
        button.textContent = 'Select it';
        return;
      }
      navigator.clipboard.writeText(value).then(
        function () {
          button.textContent = 'Copied';
          setTimeout(function () {
            button.textContent = 'Copy';
          }, 1800);
        },
        function () {
          button.textContent = 'Select it';
        }
      );
    });
  }

  // ── The claim ───────────────────────────────────────────────────────────────

  function params(source) {
    return new URLSearchParams(source || '');
  }

  // Fragment first: that is the shape a repeater prints, and a fragment is never sent to a
  // server. The query is read as a fallback for a link something rewrote; by then it has already
  // reached this origin, and refusing to read it would not un-send it.
  var fromHash = params(location.hash.replace(/^#/, ''));
  var fromQuery = params(location.search.replace(/^\?/, ''));
  var ticket = fromHash.get('t') || fromQuery.get('t') || '';
  var secret = fromHash.get('s') || fromQuery.get('s') || '';

  // A claim link opened in a tab already on this page changes only the fragment, which does not
  // reload it. Start over so it is read.
  window.addEventListener('hashchange', function () {
    var next = params(location.hash.replace(/^#/, ''));
    if (next.get('t') || next.get('s') || ticket || secret) location.reload();
  });

  if (ticket || secret) {
    // Shape check only; the app checks the repeater's signed answer, not this page.
    var valid = /^[A-Za-z0-9]+$/.test(ticket) && /^[0-9a-fA-F]{64}$/.test(secret);

    $('guide').hidden = true;
    $('claim-view').hidden = false;
    $(valid ? 'claim' : 'incomplete').hidden = false;
    document.title = valid
      ? 'Claim a repeater · streetCryptid'
      : 'Incomplete claim link · streetCryptid';

    if (valid) {
      var link = 'streetcryptid-repeater:' + ticket + '#' + secret.toLowerCase();
      $('link').textContent = link;
      $('open').href = 'streetcryptid:///repeater?t=' + encodeURIComponent(ticket) + '&s=' + secret;
      wireCopy($('copy'), link);
    }
    return;
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────

  // WAI-ARIA tabs: one tab stop per list, arrows move between tabs, panels follow selection.
  function tablist(list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));

    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        $(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () {
        select(tab, false);
      });
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) {
          e.preventDefault();
          select(next, true);
        }
      });
    });

    select(tabs[0], false);
    return select;
  }

  var selectOs = tablist(document.querySelector('[data-tabs="os"]'));
  tablist(document.querySelector('[data-tabs="win"]'));

  Array.prototype.forEach.call(document.querySelectorAll('[data-show-tab]'), function (button) {
    button.addEventListener('click', function () {
      selectOs($(button.getAttribute('data-show-tab')), true);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.cmd'), function (cmd) {
    var code = cmd.querySelector('code');
    wireCopy(cmd.querySelector('.copy'), function () {
      return code.textContent.trim();
    });
  });

  // ── Which computer is this ──────────────────────────────────────────────────

  var uaData = navigator.userAgentData;
  var ua = navigator.userAgent || '';
  var platform = ((uaData && uaData.platform) || navigator.platform || '').toLowerCase();

  var os = null;
  var phone = (uaData && uaData.mobile) || /Android|iPhone|iPad|iPod/i.test(ua);
  // iPadOS reports itself as a Mac; a Mac has no touch screen.
  if (/mac/.test(platform) && navigator.maxTouchPoints > 1) phone = true;

  if (phone) {
    $('on-phone').hidden = false;
  } else if (/win/.test(platform)) {
    os = 'windows';
  } else if (/mac/.test(platform)) {
    os = 'macos';
  } else if (/linux|x11|cros/.test(platform) || /Linux|X11|CrOS/.test(ua)) {
    os = 'linux';
  }

  if (os) {
    var tab = $('tab-' + os);
    tab.querySelector('.here').hidden = false;
    selectOs(tab, false);
  }

  // Which installer to put first. Only Chromium says, and only when asked; elsewhere both stay
  // equal and the footnote does the explaining.
  if (os === 'windows' && uaData && uaData.getHighEntropyValues) {
    uaData.getHighEntropyValues(['architecture', 'bitness']).then(
      function (v) {
        var arch = v.architecture === 'arm' ? 'arm64' : v.architecture === 'x86' ? 'x64' : null;
        var match = arch && document.querySelector('.downloads [data-arch="' + arch + '"]');
        if (!match) return;
        match.classList.add('suggested');
        match.textContent += ' · this PC';
        match.parentNode.insertBefore(match, match.parentNode.firstChild);
      },
      function () {}
    );
  }
})();
