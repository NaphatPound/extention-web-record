// Unique CSS selector + XPath generator for a DOM element.
// Runs in page context. Exposes window.WebRecordSelector.
(function () {
  'use strict';

  function isUnique(root, sel) {
    try {
      return root.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  }

  function nthOfType(el) {
    let i = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) i++;
      sib = sib.previousElementSibling;
    }
    return i;
  }

  function uniqueCssSelector(el) {
    if (!(el instanceof Element)) return null;
    const doc = el.ownerDocument;

    // 1. By id
    if (el.id && isUnique(doc, `#${cssEscape(el.id)}`)) {
      return `#${cssEscape(el.id)}`;
    }

    // 2. By data-testid / name / aria-label
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `${el.tagName.toLowerCase()}[${attr}="${val.replace(/"/g, '\\"')}"]`;
        if (isUnique(doc, sel)) return sel;
      }
    }

    // 3. Walk up the DOM and build a path
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== doc.documentElement) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part = `#${cssEscape(current.id)}`;
        parts.unshift(part);
        break;
      }
      part += `:nth-of-type(${nthOfType(current)})`;
      parts.unshift(part);
      current = current.parentElement;
      const candidate = parts.join(' > ');
      if (isUnique(doc, candidate)) return candidate;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function xpathFor(el) {
    if (!(el instanceof Element)) return null;
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1) {
      let i = 1;
      let sib = current.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName === current.tagName) i++;
        sib = sib.previousSibling;
      }
      parts.unshift(`${current.tagName.toLowerCase()}[${i}]`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  function describe(el, clientX, clientY) {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className : null,
      innerText: (el.innerText || el.textContent || '').trim().slice(0, 140),
      selector: uniqueCssSelector(el),
      xpath: xpathFor(el),
      position: {
        x: clientX ?? Math.round(rect.left + rect.width / 2),
        y: clientY ?? Math.round(rect.top + rect.height / 2),
      },
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    };
  }

  function resolve(selector, xpath) {
    if (selector) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {}
    }
    if (xpath) {
      try {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (result.singleNodeValue) return result.singleNodeValue;
      } catch {}
    }
    return null;
  }

  self.WebRecordSelector = { uniqueCssSelector, xpathFor, describe, resolve };
})();
