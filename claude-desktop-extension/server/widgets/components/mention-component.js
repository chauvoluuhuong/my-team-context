/**
 * Reusable Mention Utility Component for Ext-Apps Widgets.
 *
 * Supports mentioning resources (such as Skills, Docs, etc.) using `@` or `@[resourceType:resourceName]`.
 * Provides interactive caret-positioned autocomplete popup, keyboard navigation,
 * mention parsing, and formatting.
 */

(function () {
  /**
   * Escape HTML entities.
   */
  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    }[c]));
  }

  /**
   * Regex matching mentions:
   * 1. @[skill:some-name] or @[type:name]
   * 2. @[some-name]
   * 3. @some-name
   */
  const BRACKET_TYPED_REGEX = /@\[([a-zA-Z0-9_\-\.]+):([^\]]+)\]/g;
  const BRACKET_SIMPLE_REGEX = /@\[([^\]:]+)\]/g;
  const PLAIN_AT_REGEX = /(^|[^a-zA-Z0-9_\-\./@])@([a-zA-Z0-9_\-\.]{2,})/g;

  /**
   * Parse all mentions in a text string.
   */
  function parseMentions(text) {
    if (!text || typeof text !== "string") return [];

    const results = [];
    const occupied = [];

    const isOverlapping = (start, end) =>
      occupied.some(([s, e]) => Math.max(start, s) < Math.min(end, e));

    let m;
    const typedRegex = new RegExp(BRACKET_TYPED_REGEX.source, "g");
    while ((m = typedRegex.exec(text)) !== null) {
      const raw = m[0];
      const type = m[1].toLowerCase();
      const name = m[2].trim();
      const startIndex = m.index;
      const endIndex = startIndex + raw.length;
      occupied.push([startIndex, endIndex]);
      results.push({ raw, type, name, startIndex, endIndex });
    }

    const simpleRegex = new RegExp(BRACKET_SIMPLE_REGEX.source, "g");
    while ((m = simpleRegex.exec(text)) !== null) {
      const raw = m[0];
      const name = m[1].trim();
      const startIndex = m.index;
      const endIndex = startIndex + raw.length;
      if (!isOverlapping(startIndex, endIndex)) {
        occupied.push([startIndex, endIndex]);
        results.push({ raw, type: "skill", name, startIndex, endIndex });
      }
    }

    const plainRegex = new RegExp(PLAIN_AT_REGEX.source, "g");
    while ((m = plainRegex.exec(text)) !== null) {
      const prefix = m[1];
      let name = m[2].trim();
      while (/[.,;:!?]$/.test(name)) {
        name = name.slice(0, -1);
      }
      if (name.length < 2) continue;

      const raw = "@" + name;
      const startIndex = m.index + prefix.length;
      const endIndex = startIndex + raw.length;

      if (startIndex > 0 && text[startIndex - 1] && /[a-zA-Z0-9]/.test(text[startIndex - 1])) {
        continue;
      }

      if (!isOverlapping(startIndex, endIndex)) {
        occupied.push([startIndex, endIndex]);
        results.push({ raw, type: "skill", name, startIndex, endIndex });
      }
    }

    return results.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * Format a resource into an unambiguous mention string.
   */
  function formatMention(resource, style = "bracket") {
    const name = (resource.name || "").trim();
    const type = (resource.type || "skill").trim().toLowerCase();
    if (style === "at") {
      return `@${name}`;
    }
    return `@[${type}:${name}]`;
  }

  /**
   * Replace mentions in HTML or text with rich badges.
   */
  function renderMentionsInHtml(text) {
    if (!text) return "";
    return esc(text)
      .replace(/@\[([a-zA-Z0-9_\-\.]+):([^\]]+)\]/g, (_, type, name) => {
        const icon = type === "skill" ? "🧠" : "🏷️";
        return `<span class="mention-pill mention-${type}" data-mention-type="${type}" data-mention-name="${name}" style="display:inline-flex;align-items:center;gap:3px;background:var(--purple-bg,#f3e8ff);color:var(--purple-fg,#7e22ce);font-weight:600;padding:1px 6px;border-radius:4px;font-size:11px;user-select:none;">${icon} @${name}</span>`;
      })
      .replace(/@\[([^\]:]+)\]/g, (_, name) => {
        return `<span class="mention-pill mention-skill" data-mention-type="skill" data-mention-name="${name}" style="display:inline-flex;align-items:center;gap:3px;background:var(--purple-bg,#f3e8ff);color:var(--purple-fg,#7e22ce);font-weight:600;padding:1px 6px;border-radius:4px;font-size:11px;user-select:none;">🧠 @${name}</span>`;
      });
  }

  /**
   * Caret position calculation helper for textarea / input elements.
   */
  function getCaretCoordinates(element, position) {
    const div = document.createElement("div");
    const style = window.getComputedStyle(element);

    for (const prop of style) {
      div.style[prop] = style[prop];
    }

    div.style.position = "absolute";
    div.style.visibility = "hidden";
    div.style.whiteSpace = "pre-wrap";
    div.style.top = "0";
    div.style.left = "-9999px";

    const textContent = element.value.substring(0, position);
    div.textContent = textContent;

    const span = document.createElement("span");
    span.textContent = element.value.substring(position) || ".";
    div.appendChild(span);

    document.body.appendChild(div);

    const spanOffset = {
      top: span.offsetTop,
      left: span.offsetLeft,
      height: parseInt(style.lineHeight) || 18,
    };

    document.body.removeChild(div);
    return spanOffset;
  }

  /**
   * MentionController: coordinates mention providers and interactive autocomplete.
   */
  class MentionController {
    constructor(options = {}) {
      this.app = options.app || null;
      this.providers = new Map();
      this.activeElement = null;
      this.activeMenu = null;
      this.selectedIndex = 0;
      this.currentQuery = "";
      this.triggerIndex = -1;
      this.filteredItems = [];
      this.skillsCache = options.skills || [];

      // Register default Skill resource provider
      this.registerProvider({
        type: "skill",
        label: "Skill",
        icon: "🧠",
        search: async (query) => {
          const q = (query || "").toLowerCase().trim();
          let skills = this.skillsCache;

          if ((!skills || skills.length === 0) && this.app?.callServerTool) {
            try {
              const res = await this.app.callServerTool({
                name: "skills_list",
                arguments: { limit: 100 },
              });
              const data = JSON.parse(res.content[0].text);
              if (Array.isArray(data.skills)) {
                this.skillsCache = data.skills;
                skills = data.skills;
              }
            } catch {}
          }

          if (!q) {
            return (skills || []).slice(0, 10).map((s) => ({
              id: s.id,
              name: s.name,
              type: "skill",
              title: s.name,
              description: s.description || "",
              icon: "🧠",
            }));
          }

          return (skills || [])
            .filter((s) => {
              const nameMatch = (s.name || "").toLowerCase().includes(q);
              const descMatch = (s.description || "").toLowerCase().includes(q);
              return nameMatch || descMatch;
            })
            .slice(0, 10)
            .map((s) => ({
              id: s.id,
              name: s.name,
              type: "skill",
              title: s.name,
              description: s.description || "",
              icon: "🧠",
            }));
        },
      });

      // Bind global clicks to close open menu
      document.addEventListener("mousedown", (e) => {
        if (this.activeMenu && !this.activeMenu.contains(e.target) && e.target !== this.activeElement) {
          this.closeMenu();
        }
      });
    }

    /**
     * Update known skills cache.
     */
    setSkills(skills) {
      if (Array.isArray(skills)) {
        this.skillsCache = skills;
      }
    }

    /**
     * Register an extensible resource provider.
     */
    registerProvider(provider) {
      if (!provider || !provider.type) return;
      this.providers.set(provider.type, provider);
    }

    /**
     * Attach mention listener to an input or textarea element.
     */
    attach(element, options = {}) {
      if (!element) return () => {};

      const formatStyle = options.formatStyle || "bracket"; // "bracket" -> @[skill:name], "at" -> @name
      const onMentionInserted = options.onInsert || null;

      const handleInput = async (e) => {
        const text = element.value;
        const caret = element.selectionStart;

        // Check text up to caret for an active @ trigger
        const beforeCaret = text.slice(0, caret);
        const atIdx = beforeCaret.lastIndexOf("@");

        if (atIdx === -1) {
          this.closeMenu();
          return;
        }

        // Only trigger if @ is at start of string or preceded by whitespace/newline
        if (atIdx > 0 && !/[\s\n(]/.test(beforeCaret[atIdx - 1])) {
          this.closeMenu();
          return;
        }

        const query = beforeCaret.slice(atIdx + 1);

        // If query contains spaces or closing brackets/newlines, cancel mention menu
        if (/[\s\n\]]/.test(query)) {
          this.closeMenu();
          return;
        }

        this.triggerIndex = atIdx;
        this.currentQuery = query;
        this.activeElement = element;

        await this.showMenu(element, query, formatStyle, onMentionInserted);
      };

      const handleKeyDown = (e) => {
        if (!this.activeMenu || this.filteredItems.length === 0) return;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.selectedIndex = (this.selectedIndex + 1) % this.filteredItems.length;
          this.updateMenuHighlight();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.selectedIndex = (this.selectedIndex - 1 + this.filteredItems.length) % this.filteredItems.length;
          this.updateMenuHighlight();
        } else if (e.key === "Enter" || e.key === "Tab") {
          if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredItems.length) {
            e.preventDefault();
            this.insertMention(this.filteredItems[this.selectedIndex], formatStyle, onMentionInserted);
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.closeMenu();
        }
      };

      element.addEventListener("input", handleInput);
      element.addEventListener("keydown", handleKeyDown);

      return () => {
        element.removeEventListener("input", handleInput);
        element.removeEventListener("keydown", handleKeyDown);
        if (this.activeElement === element) {
          this.closeMenu();
        }
      };
    }

    /**
     * Trigger mention menu manually or via typing.
     */
    async showMenu(element, query = "", formatStyle = "bracket", onInsert = null) {
      // Gather matching items across providers (currently 'skill')
      const items = [];
      for (const provider of this.providers.values()) {
        try {
          const res = await provider.search(query);
          if (Array.isArray(res)) items.push(...res);
        } catch {}
      }

      this.filteredItems = items;
      this.selectedIndex = 0;

      if (items.length === 0 && query.trim().length > 0) {
        this.closeMenu();
        return;
      }

      if (!this.activeMenu) {
        this.activeMenu = document.createElement("div");
        this.activeMenu.className = "mention-menu-popup";
        document.body.appendChild(this.activeMenu);
      }

      this.renderMenu(query, formatStyle, onInsert);
      this.positionMenu(element);
    }

    /**
     * Render the menu contents.
     */
    renderMenu(query, formatStyle, onInsert) {
      if (!this.activeMenu) return;

      if (this.filteredItems.length === 0) {
        this.activeMenu.innerHTML = `
          <div class="mention-menu-header" style="padding:7px 10px;font-size:11px;font-weight:700;color:var(--muted);border-bottom:1px solid var(--line);background:var(--card-bg);display:flex;justify-content:space-between;align-items:center;">
            <span>🧠 Mention Skill</span>
            <span style="font-size:10.5px;color:var(--muted);font-weight:normal;">No matching skills</span>
          </div>
          <div style="padding:10px;text-align:center;font-size:11.5px;color:var(--muted);">No skills found matching "${esc(query)}"</div>
        `;
        return;
      }

      const itemsHtml = this.filteredItems
        .map((item, idx) => {
          const isSelected = idx === this.selectedIndex;
          const icon = item.icon || (item.type === "skill" ? "🧠" : "🏷️");
          return `
            <div class="mention-item ${isSelected ? "selected" : ""}" data-index="${idx}" style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;cursor:pointer;background:${isSelected ? "var(--accent-light, #eff6ff)" : "transparent"};border-radius:6px;transition:background 0.1s ease;">
              <span style="font-size:15px;flex-shrink:0;line-height:1.2;">${icon}</span>
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
                  <strong style="font-size:12.5px;color:var(--fg);font-family:ui-monospace,SFMono-Regular,monospace;">${esc(item.name)}</strong>
                  <span class="badge ${item.type === "skill" ? "score" : "idle"}" style="font-size:10px;padding:1px 5px;border-radius:4px;">${esc(item.type.toUpperCase())}</span>
                </div>
                ${item.description ? `<div style="font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px;">${esc(item.description)}</div>` : ""}
              </div>
            </div>
          `;
        })
        .join("");

      this.activeMenu.innerHTML = `
        <div class="mention-menu-header" style="padding:6px 10px;font-size:11px;font-weight:700;color:var(--muted);border-bottom:1px solid var(--line);background:var(--code-bg);display:flex;justify-content:space-between;align-items:center;">
          <span style="display:flex;align-items:center;gap:4px;">🧠 <span>Mention a Skill</span></span>
          <span style="font-size:10px;color:var(--muted);font-weight:normal;">↑↓ navigate • ↵ insert</span>
        </div>
        <div class="mention-items-list" style="max-height:190px;overflow-y:auto;padding:4px;">
          ${itemsHtml}
        </div>
      `;

      // Bind click and hover listeners to items
      this.activeMenu.querySelectorAll(".mention-item").forEach((el) => {
        el.addEventListener("mouseenter", () => {
          const idx = parseInt(el.dataset.index, 10);
          this.selectedIndex = idx;
          this.updateMenuHighlight();
        });

        el.addEventListener("mousedown", (e) => {
          e.preventDefault(); // keep textarea focus
          const idx = parseInt(el.dataset.index, 10);
          if (idx >= 0 && idx < this.filteredItems.length) {
            this.insertMention(this.filteredItems[idx], formatStyle, onInsert);
          }
        });
      });
    }

    /**
     * Update highlight styles when navigating with arrows.
     */
    updateMenuHighlight() {
      if (!this.activeMenu) return;
      const items = this.activeMenu.querySelectorAll(".mention-item");
      items.forEach((el, idx) => {
        const isSelected = idx === this.selectedIndex;
        el.classList.toggle("selected", isSelected);
        el.style.background = isSelected ? "var(--accent-light, #eff6ff)" : "transparent";
        if (isSelected) {
          el.scrollIntoView({ block: "nearest" });
        }
      });
    }

    /**
     * Position the popup near the input / textarea caret.
     */
    positionMenu(element) {
      if (!this.activeMenu || !element) return;

      const rect = element.getBoundingClientRect();
      let top = 0;
      let left = 0;

      if (element.tagName === "TEXTAREA") {
        try {
          const caretCoords = getCaretCoordinates(element, Math.max(0, this.triggerIndex));
          top = rect.top + window.scrollY + caretCoords.top + caretCoords.height + 6;
          left = Math.min(
            window.innerWidth - 360,
            Math.max(rect.left, rect.left + window.scrollX + caretCoords.left)
          );
        } catch {
          top = rect.bottom + window.scrollY + 4;
          left = rect.left + window.scrollX;
        }
      } else {
        top = rect.bottom + window.scrollY + 4;
        left = rect.left + window.scrollX;
      }

      // Keep within viewport height
      const menuHeight = 220;
      if (top + menuHeight > window.innerHeight + window.scrollY) {
        top = Math.max(10, rect.top + window.scrollY - menuHeight - 6);
      }

      Object.assign(this.activeMenu.style, {
        position: "fixed",
        top: `${Math.max(10, top - window.scrollY)}px`,
        left: `${Math.max(10, left - window.scrollX)}px`,
        width: "360px",
        maxWidth: "92vw",
        zIndex: "10000",
        background: "var(--card-bg, #ffffff)",
        border: "1px solid var(--border, #cbd5e1)",
        borderRadius: "9px",
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
        overflow: "hidden",
        display: "block",
      });
    }

    /**
     * Insert the selected mention into the active element.
     */
    insertMention(item, formatStyle = "bracket", onInsert = null) {
      const element = this.activeElement;
      if (!element || this.triggerIndex === -1) {
        this.closeMenu();
        return;
      }

      const text = element.value;
      const mentionText = formatMention(item, formatStyle) + " ";
      const beforeTrigger = text.slice(0, this.triggerIndex);
      const caret = element.selectionStart;
      const afterCaret = text.slice(caret);

      const newContent = beforeTrigger + mentionText + afterCaret;
      element.value = newContent;

      // Position caret right after inserted mention
      const newCaretPos = beforeTrigger.length + mentionText.length;
      element.setSelectionRange(newCaretPos, newCaretPos);
      element.focus();

      // Trigger input event so reactive listeners update state & preview
      element.dispatchEvent(new Event("input", { bubbles: true }));

      if (typeof onInsert === "function") {
        onInsert(item, mentionText);
      }

      this.closeMenu();
    }

    /**
     * Close and remove the popup menu.
     */
    closeMenu() {
      if (this.activeMenu) {
        this.activeMenu.remove();
        this.activeMenu = null;
      }
      this.activeElement = null;
      this.triggerIndex = -1;
      this.currentQuery = "";
      this.filteredItems = [];
      this.selectedIndex = 0;
    }
  }

  // Export to global scope
  globalThis.MentionController = MentionController;
  globalThis.parseMentions = parseMentions;
  globalThis.formatMention = formatMention;
  globalThis.renderMentionsInHtml = renderMentionsInHtml;

  /**
   * Quick utility function to attach mention functionality.
   */
  globalThis.attachMention = function (element, options = {}) {
    const controller = new MentionController(options);
    const cleanup = controller.attach(element, options);
    return { controller, cleanup };
  };
})();
