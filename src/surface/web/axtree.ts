/**
 * Accessibility-tree extraction, executed inside the page.
 *
 * Hand-rolled rather than using Playwright's aria snapshot because we need a
 * structured node list — the same shape a desktop driver would build from UI
 * Automation — not a YAML blob to parse back.
 *
 * The important behaviour is what it does with *unnamed* controls. On a legacy app
 * like ParaBank the login inputs have no id, no <label>, and no aria-label, so
 * their accessible name is correctly the empty string. Reporting that honestly and
 * then attaching the nearest preceding visible text is what makes such a control
 * identifiable at all — to the model during discovery, and to a reader of the
 * evidence afterwards. It is also exactly what a human operator does: read the bold
 * caption sitting above the box.
 *
 * Written as a plain string rather than a TypeScript function on purpose. A
 * transpiler that preserves function names (esbuild's keepNames, which tsx enables)
 * injects a `__name` helper into the source, and that helper does not exist in the
 * page — so a stringified function throws ReferenceError on evaluate. This is
 * browser code being serialized across a boundary; keeping it a literal makes it
 * immune to whatever the build step does.
 */

/** Returns AxNode[]. Takes a node cap. */
export const HARVEST_FN = `function (maxNodes) {
  var INTERESTING = ["button","link","textbox","searchbox","combobox","checkbox",
                     "radio","heading","alert","alertdialog","dialog","status","cell"];
  /* Cells are capped separately: a data table would otherwise crowd out everything
     else, and only a handful of cells are ever the value someone wants. */
  var MAX_CELLS = 40;
  var cells = 0;

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
    /* A displayed value very often lives in a plain td. Legacy applications state the
       reading as a caption cell followed by a value cell: no input, no label and no
       header row, so a walker that only reports interactive controls cannot see the
       number an operator is looking straight at. */
    if (tag === "td") return "cell";
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

  /* Simplified accname algorithm, in spec precedence order. */
  function accessibleName(el, role) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var parts = [];
      by.split(/\\s+/).forEach(function (ref) {
        var t = el.ownerDocument.getElementById(ref);
        if (t && t.textContent) parts.push(t.textContent);
      });
      if (parts.length) return parts.join(" ").replace(/\\s+/g, " ").trim();
    }

    var lab = labelText(el);
    if (lab.trim()) return lab.replace(/\\s+/g, " ").trim();

    if (el.tagName === "INPUT") {
      var t2 = (el.getAttribute("type") || "text").toLowerCase();
      /* <input type=submit> takes its name from the value attribute. */
      if (t2 === "submit" || t2 === "button" || t2 === "reset") {
        return (el.getAttribute("value") || "").trim();
      }
      if (t2 === "image") return (el.getAttribute("alt") || "").trim();
      /* A plain text input is NOT named by its own contents. */
      return (el.getAttribute("title") || "").trim();
    }

    /* Text content names buttons, links and headings; it does not name a field. */
    if (role === "button" || role === "link" || role === "heading") {
      var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text.slice(0, 120);
    }
    return (el.getAttribute("title") || "").trim();
  }

  /* Nearest meaningful text before this element in reading order — what a human
     reads as the caption when the markup provides no label.

     Text carrying no letters is skipped rather than accepted. Currency symbols and
     punctuation routinely sit between a caption and its field:

       <b>Amount:</b> $ <input id="amount">

     Taking the literal nearest text node yields "$", which is useless as an anchor
     and tells the model nothing during discovery. Walking back one more node
     yields "Amount:", which is what an operator reads. */
  function nearbyText(el) {
    var walker = el.ownerDocument.createTreeWalker(el.ownerDocument.body, NodeFilter.SHOW_TEXT, null);
    var best = "", node;
    while ((node = walker.nextNode())) {
      if (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
      var t = (node.textContent || "").replace(/\\s+/g, " ").trim();
      if (t && /[A-Za-z]/.test(t)) best = t;
    }
    return best.slice(0, 80);
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  var out = [];
  if (!document.body) return out;
  var all = document.body.querySelectorAll("*");

  for (var i = 0; i < all.length && out.length < maxNodes; i++) {
    var el = all[i];
    var role = implicitRole(el);
    if (INTERESTING.indexOf(role) === -1) continue;
    if (!visible(el)) continue;

    if (role === "cell") {
      if (cells >= MAX_CELLS) continue;
      var cellText = (el.textContent || "").replace(/\\s+/g, " ").trim();
      /* Empty spacer cells and long prose blocks are not values. */
      if (!cellText || cellText.length > 60) continue;
      cells++;
    }

    var name = accessibleName(el, role);
    var node = { role: role, name: name };

    var tag = el.tagName;
    if ((tag === "INPUT" || tag === "TEXTAREA") && role !== "button") {
      /* A submit button's value IS its accessible name; repeating it is noise. */
      var type = (el.getAttribute("type") || "text").toLowerCase();
      /* Never surface the contents of a password field, even to our own logs. */
      if (type !== "password" && el.value) node.value = String(el.value).slice(0, 80);
    } else if (tag === "SELECT") {
      node.value = String(el.value || "").slice(0, 80);
    } else if (role === "cell") {
      node.value = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    }

    /* Only worth computing when the app gave the control no name of its own. A cell
       is always in this position: its text is the value, never the caption. */
    if (!name || role === "cell") {
      var near = nearbyText(el);
      if (near) node.nearbyText = near;
    }
    out.push(node);
  }
  return out;
}`;

/** Returns string[] — text of open interstitials, the thing that derails replay. */
export const DIALOG_FN = `function () {
  var found = [];
  var sel = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="alert"]';
  var els = document.querySelectorAll(sel);
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || "").replace(/\\s+/g, " ").trim();
    if (t) found.push(t.slice(0, 200));
  }
  return found;
}`;
