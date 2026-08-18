/**
 * Code that runs INSIDE the target page. Never imported — read as text and injected.
 *
 * A plain .js file on purpose. This code crosses a process boundary into the browser,
 * so it has to arrive as text, and the two obvious ways of producing that text are
 * both worse:
 *
 *   String(someTypeScriptFunction) — esbuild's keepNames (which tsx enables) rewrites
 *   function declarations to reference a `__name` helper that exists in our module
 *   scope and not in the page, so the injected code throws ReferenceError.
 *
 *   A template literal in a .ts file — no type checking, no syntax highlighting, and
 *   every backslash needs doubling. Two real bugs came from that: a regex silently
 *   became /s+/ instead of /\s+/, and a backtick inside a comment terminated the
 *   literal.
 *
 * As a real file it is ordinary, reviewable JavaScript that no build step touches.
 * Deliberately ES5-flavoured (var, no arrow functions) so it runs unchanged in any
 * browser engine a surface driver might drive.
 */

/* eslint-env browser */

// ---------------------------------------------------------------------------
// harvest(maxNodes) -> AxNode[]
//
// The accessibility view of the screen: what a control IS (role) and what it is
// CALLED (name), plus the caption a human reads when the application supplies no
// name of its own. Deliberately not the DOM — this is the shape a desktop driver
// would build from UI Automation, so nothing above the seam has to change.
// ---------------------------------------------------------------------------
function harvest(maxNodes) {
  var INTERESTING = [
    "button", "link", "textbox", "searchbox", "combobox", "checkbox",
    "radio", "heading", "alert", "alertdialog", "dialog", "status", "cell",
    "paragraph",
  ];

  // Cells and paragraphs are capped separately: a data table or a page of prose would
  // otherwise crowd out every interactive control.
  var MAX_CELLS = 40;
  var MAX_PARAGRAPHS = 12;
  var cells = 0;
  var paragraphs = 0;

  // Generous, because captions on legacy screens are sometimes whole instruction
  // sentences — "A minimum of $100.00 must be deposited... Please choose an existing
  // account." is the only thing identifying one dropdown on this app. Long is
  // acceptable; truncated is not, because a caption has to be usable as a locator.
  var CAPTION_MAX = 200;

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  function implicitRole(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "dialog") return "dialog";
    // A displayed value very often lives in a plain td. Legacy applications state a
    // reading as a caption cell followed by a value cell: no input, no label and no
    // header row, so a walker that only reports interactive controls cannot see the
    // number an operator is looking straight at.
    if (tag === "td") return "cell";
    // Nor is a value always in a control. A confirmation reads as a sentence, with no
    // input, no cell and no caption of its own — addressable only as the text under
    // the heading that introduces it.
    if (tag === "p") return "paragraph";
    if (tag === "input") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      if (t === "hidden") return "";
      return "textbox";
    }
    return "";
  }

  function labelText(el) {
    var id = el.getAttribute("id");
    if (id) {
      var lab = el.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab && lab.textContent) return lab.textContent;
    }
    var wrapping = el.closest("label");
    if (wrapping && wrapping.textContent) return wrapping.textContent;
    return "";
  }

  // Simplified accname algorithm, in spec precedence order.
  function accessibleName(el, role) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var parts = [];
      by.split(/\s+/).forEach(function (ref) {
        var target = el.ownerDocument.getElementById(ref);
        if (target && target.textContent) parts.push(target.textContent);
      });
      if (parts.length) return parts.join(" ").replace(/\s+/g, " ").trim();
    }

    var lab = labelText(el);
    if (lab.trim()) return lab.replace(/\s+/g, " ").trim();

    if (el.tagName === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      // <input type=submit> takes its name from the value attribute.
      if (type === "submit" || type === "button" || type === "reset") {
        return (el.getAttribute("value") || "").trim();
      }
      if (type === "image") return (el.getAttribute("alt") || "").trim();
      // A plain text input is NOT named by its own contents.
      return (el.getAttribute("title") || "").trim();
    }

    // Text content names buttons, links and headings; it does not name a field.
    if (role === "button" || role === "link" || role === "heading") {
      var text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
    }
    return (el.getAttribute("title") || "").trim();
  }

  // Column header from the table's header row, row identity from its first cell. A
  // figure in a grid is located by column and row; the thing beside it belongs to a
  // different record.
  function cellCoords(el) {
    var out = { column: "", row: "" };
    var tr = el.closest("tr");
    var table = el.closest("table");
    if (!tr || !table) return out;

    var cellsInRow = tr.querySelectorAll("td");
    var index = -1;
    for (var c = 0; c < cellsInRow.length; c++) if (cellsInRow[c] === el) index = c;
    if (index < 0) return out;

    var headers = table.querySelectorAll("th");
    if (headers.length > index) {
      out.column = (headers[index].textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    }
    if (index > 0 && cellsInRow[0]) {
      out.row = (cellsInRow[0].textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    }
    return out;
  }

  var out = [];
  if (!document.body) return out;

  // One pass over elements AND text, in document order. A text node reached before an
  // element precedes it on screen, so the last one seen is that element's caption —
  // exactly the relationship a person uses to read an unlabelled field.
  //
  // The previous version re-walked every text node for each control it captioned,
  // which is quadratic: a 5,000-node screen with 50 unnamed fields cost a quarter of a
  // million comparisons per observation, and discovery observes every turn.
  var walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    null,
  );
  var caption = "";
  var current;

  while ((current = walker.nextNode()) && out.length < maxNodes) {
    if (current.nodeType === Node.TEXT_NODE) {
      var t = (current.textContent || "").replace(/\s+/g, " ").trim();
      // Text carrying no letters is skipped. Currency symbols and punctuation sit
      // between a caption and its field — "<b>Amount:</b> $ <input>" — and taking the
      // literal nearest text yields "$", which is useless as an anchor.
      if (!t || !/[A-Za-z]/.test(t)) continue;
      // Text inside a hidden template is not a caption anyone reads, and offering it
      // as one hands the model an anchor that cannot be resolved.
      if (!visible(current.parentElement)) continue;
      // Dropped rather than shortened: a truncated caption matches no text node on the
      // page, so a control offered only that becomes unaddressable. Clearing is
      // honest; inheriting the previous caption would point at the wrong control.
      caption = t.length <= CAPTION_MAX ? t : "";
      continue;
    }

    var el = current;
    var role = implicitRole(el);
    if (INTERESTING.indexOf(role) === -1) continue;
    if (!visible(el)) continue;

    if (role === "paragraph") {
      if (paragraphs >= MAX_PARAGRAPHS) continue;
      var paraText = (el.textContent || "").replace(/\s+/g, " ").trim();
      // Too short to be a statement, or long enough to be a page of prose.
      if (paraText.length < 10 || paraText.length > 200) continue;
      // A paragraph wrapping another paragraph is a container, not a statement.
      if (el.querySelector("p")) continue;
      // Chrome, not content. A tagline and a copyright notice are on every screen and
      // are never the value anyone came for.
      if (el.closest("#topPanel, #headerPanel, #footerPanel, footer, header, nav")) continue;
      if (/^©|\ball rights reserved\b/i.test(paraText)) continue;
      paragraphs++;
    }

    if (role === "cell") {
      if (cells >= MAX_CELLS) continue;
      var cellText = (el.textContent || "").replace(/\s+/g, " ").trim();
      // Empty spacer cells and long prose blocks are not values.
      if (!cellText || cellText.length > 60) continue;
      cells++;
    }

    var name = accessibleName(el, role);
    var node = { role: role, name: name };

    var tag = el.tagName;
    if ((tag === "INPUT" || tag === "TEXTAREA") && role !== "button") {
      // A submit button's value IS its accessible name; repeating it is noise.
      var inputType = (el.getAttribute("type") || "text").toLowerCase();
      // Never surface the contents of a password field, even to our own logs.
      if (inputType !== "password" && el.value) node.value = String(el.value).slice(0, 80);
    } else if (tag === "SELECT") {
      // The SELECTED OPTION'S TEXT, not the value attribute. A person reading this
      // screen sees "SAVINGS"; the attribute says "1". Reporting the attribute made
      // the compiler derive a checkpoint asserting the label against a control that
      // returns the index, so replay failed on a step that had actually worked.
      var chosen = el.options[el.selectedIndex];
      var chosenText = chosen ? (chosen.textContent || "").replace(/\s+/g, " ").trim() : "";
      node.value = (chosenText || String(el.value || "")).slice(0, 80);
      // What can be chosen. A dropdown with unknown options forces a guess.
      var opts = [];
      for (var o = 0; o < el.options.length && o < 12; o++) {
        var optText = (el.options[o].textContent || "").replace(/\s+/g, " ").trim();
        if (optText) opts.push(optText.slice(0, 40));
      }
      if (opts.length) {
        node.options = opts;
        if (el.options.length > 12) node.options.push("… " + (el.options.length - 12) + " more");
      }
    } else if (role === "cell" || role === "paragraph") {
      node.value = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
      var coords = cellCoords(el);
      if (coords.column) node.columnHeader = coords.column;
      if (coords.row) node.rowLabel = coords.row;
    }

    // A cell with coordinates must NOT also carry a caption: in a data table the
    // preceding text is the last column header, the same misleading string for every
    // cell in the body — and on a live run the model trusted it and read one account's
    // number as another account's balance.
    var hasCoords = role === "cell" && node.columnHeader && node.rowLabel;

    // Who gets a caption.
    //
    // Unnamed controls always do; it is the only way to identify them at all.
    //
    // A NAMED control gets one only when its name is a bare value — digits, an amount,
    // a date. Such a control displays data rather than labelling itself, and cannot be
    // addressed by that name because the value changes every run: the confirmation
    // link here is named after the account number it has just created, so "Your new
    // account number:" is the only durable way in.
    //
    // A control named "Home" or "Log In" labels itself and must not take a caption. It
    // is visited before its own text child, so it would otherwise inherit whatever
    // caption was still current — which is how a footer link ended up captioned "Your
    // new account number:" and made that caption look ambiguous.
    var valueLike = name !== "" && /^[\d$€£.,\-\/\s]+$/.test(name);
    var wantsCaption = name === "" || valueLike || role === "cell" || role === "paragraph";

    if (caption && caption !== name && wantsCaption && !hasCoords) node.nearbyText = caption;

    out.push(node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// dialogs() -> string[]
// Open interstitials: the thing that derails an unattended replay.
// ---------------------------------------------------------------------------
function dialogs() {
  var found = [];
  var sel = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="alert"]';
  var els = document.querySelectorAll(sel);
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || "").replace(/\s+/g, " ").trim();
    if (t) found.push(t.slice(0, 200));
  }
  return found;
}

// ---------------------------------------------------------------------------
// nearby(caption, axis) -> string[] of unique CSS paths
//
// Find the control a VISIBLE caption is labelling. The decisive test is whether the
// anchor is visible, and computed style is not reachable from XPath: this app carries
// a hidden confirmation template repeating "to account #", so an XPath anchored on
// text alone matched the real dropdown plus a link following the invisible copy.
//
// The returned CSS path is used only to hand the element back to the locator engine.
// It is never stored in an artifact — the artifact keeps the semantic instruction, and
// this is how that instruction is carried out.
// ---------------------------------------------------------------------------
function nearby(caption, axis) {
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  // P is included so a value stated as a sentence can be read; a paragraph is never
  // the target of a click.
  function isControl(el) {
    var t = el.tagName;
    return t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || t === "BUTTON" ||
           t === "A" || t === "TD" || t === "P";
  }

  function uniquePath(el) {
    var parts = [];
    while (el && el.nodeType === Node.ELEMENT_NODE && el.tagName !== "HTML") {
      var tag = el.tagName.toLowerCase();
      var parent = el.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var same = 0;
      var index = 0;
      for (var i = 0; i < parent.children.length; i++) {
        var sib = parent.children[i];
        if (sib.tagName === el.tagName) { same++; if (sib === el) index = same; }
      }
      parts.unshift(same > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
      el = parent;
    }
    return parts.join(" > ");
  }

  var wanted = String(caption).replace(/\s+/g, " ").trim();
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  var anchors = [];
  var node;
  while ((node = walker.nextNode())) {
    if ((node.textContent || "").replace(/\s+/g, " ").trim() !== wanted) continue;
    // A caption inside a hidden template is not a caption.
    if (!visible(node.parentElement)) continue;
    anchors.push(node);
  }

  var all = Array.prototype.slice.call(document.querySelectorAll("*"));
  var hits = [];
  for (var a = 0; a < anchors.length; a++) {
    var anchor = anchors[a];
    var ordered = axis === "preceding" ? all.slice().reverse() : all;
    for (var j = 0; j < ordered.length; j++) {
      var candidate = ordered[j];
      var pos = anchor.compareDocumentPosition(candidate);
      var after = (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      var contains = (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0;
      var rightSide = axis === "preceding" ? !after : after;
      if (!rightSide || contains) continue;
      if (!isControl(candidate) || !visible(candidate)) continue;
      hits.push(uniquePath(candidate));
      break;
    }
  }
  // Distinct captions may legitimately lead to the same control.
  return hits.filter(function (p, i) { return hits.indexOf(p) === i; });
}
