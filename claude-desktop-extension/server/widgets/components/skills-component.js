/**
 * Reusable Team Skills & Knowledge Base Component
 * Can be mounted into any widget container (e.g. panel.html or skills.html).
 */
export class SkillsComponent {
  constructor(options = {}) {
    this.app = options.app;
    this.container = options.container || null;
    this.showHeader = options.showHeader !== false;
    this.onUpdate = options.onUpdate || null;
    this.skills = [];
    this.isEditing = false;
    this.currentEditSkill = null;
    this.searchQuery = "";
    this.statusMessage = null;
    this.isLoading = false;
    this.isSearching = false;
    this.isSaving = false;
    this.deletingSkillId = null;
  }

  esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  syncEditorStateFromInputs() {
    if (!this.isEditing) return;
    const name = document.getElementById("compSkillName")?.value;
    const description = document.getElementById("compSkillDesc")?.value;
    const content = document.getElementById("compSkillContent")?.value;
    const importFromFile = document.getElementById("compSkillImportFromFile")?.value;
    const metaText = document.getElementById("compSkillMetadata")?.value;

    this.currentEditSkill = {
      ...(this.currentEditSkill || {}),
      name: name !== undefined ? name : (this.currentEditSkill?.name || ""),
      description: description !== undefined ? description : (this.currentEditSkill?.description || ""),
      content: content !== undefined ? content : (this.currentEditSkill?.content || ""),
      _customMetaText: metaText !== undefined ? metaText : (this.currentEditSkill?._customMetaText || ""),
      metadata: {
        ...(this.currentEditSkill?.metadata || {}),
        ...(importFromFile !== undefined ? { importFromFile } : {}),
      },
    };
  }

  async mount(container) {
    this.container = container;
    if (!this.skills || this.skills.length === 0) {
      await this.loadSkills();
    } else {
      this.render();
    }
  }

  async loadSkills() {
    this.isLoading = true;
    this.render();

    try {
      const res = await this.app.callServerTool({
        name: "skills_list",
        arguments: { limit: 100 },
      });
      const data = JSON.parse(res.content[0].text);
      this.skills = data.skills || [];
      if (this.onUpdate) this.onUpdate(this.skills);
      this.isLoading = false;
      this.render();
    } catch (err) {
      this.isLoading = false;
      this.showStatus("err", `Failed to load skills: ${err.message}`);
      this.render();
    }
  }

  showStatus(kind, text) {
    if (this.isEditing) {
      this.syncEditorStateFromInputs();
    }
    this.statusMessage = { kind, text };
    this.render();
    if (kind === "ok") {
      setTimeout(() => {
        if (this.statusMessage?.text === text) {
          this.statusMessage = null;
          this.render();
        }
      }, 4000);
    }
  }

  getSerializedPreview(name, description, content) {
    return `#name: ${(name || "").trim()}\n\n#description: ${(description || "").trim()}\n\n#content: ${(content || "").trim()}`;
  }

  render() {
    if (!this.container) return;
    this.container.innerHTML = `
      ${this.showHeader ? `
        <div class="skills-header" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; padding-bottom:14px; border-bottom:1px solid var(--line);">
          <div>
            <h2 style="font-size:17px; font-weight:700; margin:0 0 4px; display:flex; align-items:center; gap:8px;">🧠 Team Skills & Knowledge Base</h2>
            <p class="sub" style="color:var(--muted); font-size:12.5px; margin:0;">Store, manage, and semantically search skills embedded in Qdrant (<code>knowledge-base</code> collection).</p>
          </div>
          <span class="badge ok">
            ✓ ${this.skills.length} ${this.skills.length === 1 ? 'skill' : 'skills'} stored
          </span>
        </div>
      ` : ''}

      ${this.statusMessage ? `<div class="status-box ${this.statusMessage.kind}" style="display:flex;margin:10px 0;">${this.esc(this.statusMessage.text)}</div>` : ''}

      ${this.isEditing ? this.renderEditor() : this.renderListView()}
    `;

    this.bindEvents();
  }

  renderEditor() {
    const isNew = !this.currentEditSkill?.id;
    const nameVal = this.currentEditSkill?.name || "";
    const descVal = this.currentEditSkill?.description || "";
    const contentVal = this.currentEditSkill?.content || "";
    const importFromFileVal = this.currentEditSkill?.metadata?.importFromFile || "";

    let customMetaVal = this.currentEditSkill?._customMetaText;
    if (customMetaVal === undefined && this.currentEditSkill?.metadata) {
      const { importFromFile: _, ...rest } = this.currentEditSkill.metadata;
      if (Object.keys(rest).length > 0) {
        customMetaVal = JSON.stringify(rest, null, 2);
      } else {
        customMetaVal = "";
      }
    } else if (customMetaVal === undefined) {
      customMetaVal = "";
    }

    return `
      <div class="editor-card" style="background:var(--card-bg); border:2px solid var(--accent); border-radius:10px; padding:16px; margin-bottom:18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <h3 style="margin:0; font-size:15px; font-weight:700;">
            ${isNew ? '✨ Create New Team Skill' : '✏️ Edit Skill'}
          </h3>
          <button class="secondary sm" id="cancelEditSkillBtn">✕ Close</button>
        </div>

        <!-- 1. Mandatory Name -->
        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label" for="compSkillName" style="display:block; font-size:12px; font-weight:700; margin-bottom:4px; color:var(--fg);">Skill Name *</label>
          <input type="text" id="compSkillName" placeholder="e.g. database-migration-guide" value="${this.esc(nameVal)}" required />
          <div class="form-hint" style="font-size:11px;color:var(--muted);margin-top:3px;">Unique identifier or title for this skill.</div>
        </div>

        <!-- 2. Mandatory Description -->
        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label" for="compSkillDesc" style="display:block; font-size:12px; font-weight:700; margin-bottom:4px; color:var(--fg);">Short Description *</label>
          <input type="text" id="compSkillDesc" placeholder="Brief summary of what this skill does, handles, or solves" value="${this.esc(descVal)}" required />
          <div class="form-hint" style="font-size:11px;color:var(--muted);margin-top:3px;">Concise summary indexed for fast similarity matching.</div>
        </div>

        <!-- 3. Mandatory Content -->
        <div class="form-group" style="margin-bottom:14px;">
          <label class="form-label" for="compSkillContent" style="display:block; font-size:12px; font-weight:700; margin-bottom:4px; color:var(--fg);">Skill Content (Markdown) *</label>
          <textarea id="compSkillContent" style="min-height:140px;" placeholder="Enter detailed guidelines, procedures, instructions, or code snippets…" required>${this.esc(contentVal)}</textarea>
          <div class="form-hint" style="font-size:11px;color:var(--muted);margin-top:3px;">Comprehensive instructions injected into agent context.</div>
        </div>

        <hr style="border:none; border-top:1px dashed var(--line); margin:16px 0;" />

        <!-- 4. Optional Source File Reference -->
        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label" for="compSkillImportFromFile" style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">Source File (Optional)</label>
          <input type="text" id="compSkillImportFromFile" placeholder="e.g. docs/skills/database-guide.md or .agents/skills/deploy/SKILL.md" value="${this.esc(importFromFileVal)}" />
          <div class="form-hint" style="font-size:11px;color:var(--muted);margin-top:3px;">Repository or file path reference if imported from code.</div>
        </div>

        <!-- 5. Optional Custom Metadata -->
        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label" for="compSkillMetadata" style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">Custom Metadata (JSON Object, Optional)</label>
          <textarea id="compSkillMetadata" style="min-height: 60px; font-size: 12px;" placeholder='{\n  "author": "team-lead",\n  "tags": ["database", "postgres"]\n}'>${this.esc(customMetaVal)}</textarea>
          <div class="form-hint" style="font-size:11px;color:var(--muted);margin-top:3px;">Arbitrary key-value metadata object for custom properties.</div>
        </div>

        <!-- 6. Embedding Serialization Preview -->
        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label" style="display:block; font-size:12px; font-weight:600; margin-bottom:4px;">Embedding Document Serialization Preview</label>
          <div class="preview-box" id="compSerialPreview">${this.esc(this.getSerializedPreview(nameVal, descVal, contentVal))}</div>
          <div class="form-hint" style="font-size:11px;color:var(--muted);margin-top:3px;">Serialized into Qdrant using <code>#{fieldName}: {fieldValue}</code> with Gemini embeddings.</div>
        </div>

        <div class="btn-row" style="display:flex; gap:8px; margin-top:16px;">
          <button class="primary" id="saveCompSkillBtn" ${this.isSaving ? "disabled" : ""} style="flex:1;">
            ${this.isSaving ? '<span class="spinner-sm"></span> Saving…' : (isNew ? '🚀 Embed & Store Skill' : '💾 Update & Re-embed Skill')}
          </button>
          <button class="secondary" id="cancelCompSkillBtn" ${this.isSaving ? "disabled" : ""}>Cancel</button>
        </div>
      </div>
    `;
  }

  renderListView() {
    return `
      <div class="toolbar" style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">
        <div class="search-box" style="flex:1; min-width:240px; display:flex;">
          <input type="text" id="compSearchInput" placeholder="🔍 Semantic search skills with Gemini vector query…" value="${this.esc(this.searchQuery)}" />
        </div>
        <button class="secondary" id="compSearchBtn" ${(!this.searchQuery || this.isSearching) ? 'disabled' : ''}>
          ${this.isSearching ? '<span class="spinner-sm"></span> Searching…' : 'Search'}
        </button>
        ${this.searchQuery ? `<button class="secondary sm" id="compClearSearchBtn" ${this.isLoading ? "disabled" : ""}>Clear</button>` : ''}
        <button class="primary" id="compNewSkillBtn" ${this.isLoading ? "disabled" : ""}>+ Add Skill</button>
      </div>

      ${this.isLoading ? `
        <div style="text-align:center; padding:36px 16px; color:var(--muted); border:1px solid var(--line); border-radius:10px; background:var(--code-bg);">
          <div class="spinner-sm" style="display:inline-block; margin-right:8px;"></div>
          <span>Loading skills from Qdrant vector database…</span>
        </div>
      ` : `
        <div class="skills-list" style="display:flex; flex-direction:column; gap:12px;">
          ${this.skills.length === 0 ? `
            <div class="empty-state" style="text-align:center; padding:32px 16px; color:var(--muted); border:2px dashed var(--line); border-radius:10px; background:var(--code-bg);">
              <h3 style="margin:0 0 6px; color:var(--fg); font-size:15px;">No skills found in knowledge base</h3>
              <p style="font-size:12.5px; margin:0 0 14px;">Create your first team skill or playbook to index it in Qdrant vector database.</p>
              <button class="primary" id="compEmptyNewBtn">+ Create Skill</button>
            </div>
          ` : this.skills.map(skill => this.renderSkillCard(skill)).join('')}
        </div>
      `}
    `;
  }

  renderSkillCard(skill) {
    const updated = skill.updatedAt ? new Date(skill.updatedAt).toLocaleDateString() : '';
    const scoreBadge = skill.score !== undefined
      ? `<span class="badge score" style="background:var(--purple-bg, #f3e8ff); color:var(--purple-fg, #7e22ce);">★ ${(Math.min(100, Math.max(0, skill.score * 100))).toFixed(1)}% match</span>`
      : '';

    const isDeleting = this.deletingSkillId === skill.id;
    const hasImport = skill.metadata?.importFromFile;
    let extraMetaBadges = '';
    if (skill.metadata) {
      const { importFromFile: _, ...rest } = skill.metadata;
      const keys = Object.keys(rest);
      if (keys.length > 0) {
        extraMetaBadges = keys
          .map((k) => {
            const v = typeof rest[k] === 'object' ? JSON.stringify(rest[k]) : String(rest[k]);
            return `<span class="badge idle" style="font-size:10.5px;" title="${this.esc(k)}: ${this.esc(v)}">🏷️ ${this.esc(k)}: ${this.esc(v)}</span>`;
          })
          .join(' ');
      }
    }

    return `
      <div class="skill-card" data-id="${this.esc(skill.id)}" style="background:var(--card-bg); border:1px solid var(--border); border-radius:9px; padding:12px 14px;">
        <div class="skill-header" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px;">
          <div class="skill-name" style="font-size:13.5px; font-weight:700; color:var(--fg); display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            📌 ${this.esc(skill.name)}
            ${scoreBadge}
          </div>
          <div class="skill-actions" style="display:flex; gap:6px;">
            <button class="secondary sm comp-edit-btn" data-id="${this.esc(skill.id)}" ${isDeleting ? "disabled" : ""}>Edit</button>
            <button class="danger sm comp-delete-btn" data-id="${this.esc(skill.id)}" ${isDeleting ? "disabled" : ""}>
              ${isDeleting ? '<span class="spinner-sm"></span> Deleting…' : 'Delete'}
            </button>
          </div>
        </div>

        ${skill.description ? `<div class="skill-desc" style="color:var(--muted); font-size:12px; margin-bottom:8px; line-height:1.4;">${this.esc(skill.description)}</div>` : ''}

        ${hasImport ? `
          <div style="margin-bottom: 8px; font-size: 11.5px; color: var(--accent);">
            📁 <strong>Source:</strong> <code>${this.esc(skill.metadata.importFromFile)}</code>
          </div>
        ` : ''}

        ${extraMetaBadges ? `
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">
            ${extraMetaBadges}
          </div>
        ` : ''}

        <div class="skill-content-preview" title="Click to expand/collapse" id="comp-preview-${this.esc(skill.id)}" style="background:var(--code-bg); border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-family:ui-monospace, SFMono-Regular, monospace; font-size:11.5px; white-space:pre-wrap; max-height:80px; overflow:hidden; cursor:pointer;">${this.esc(skill.content)}</div>

        <div class="skill-footer" style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding-top:8px; border-top:1px solid var(--line); font-size:11px; color:var(--muted);">
          <span>ID: <code>${this.esc(skill.id ? skill.id.slice(0, 8) + '…' : '')}</code></span>
          <span>${updated ? `Updated: ${this.esc(updated)}` : ''}</span>
        </div>
      </div>
    `;
  }

  bindEvents() {
    if (this.isEditing) {
      const nameInput = document.getElementById("compSkillName");
      const descInput = document.getElementById("compSkillDesc");
      const contentInput = document.getElementById("compSkillContent");
      const importInput = document.getElementById("compSkillImportFromFile");
      const metaInput = document.getElementById("compSkillMetadata");
      const previewBox = document.getElementById("compSerialPreview");

      const updatePreview = () => {
        this.syncEditorStateFromInputs();
        if (previewBox) {
          previewBox.textContent = this.getSerializedPreview(nameInput?.value, descInput?.value, contentInput?.value);
        }
      };

      nameInput?.addEventListener("input", updatePreview);
      descInput?.addEventListener("input", updatePreview);
      contentInput?.addEventListener("input", updatePreview);
      importInput?.addEventListener("input", updatePreview);
      metaInput?.addEventListener("input", updatePreview);

      document.getElementById("cancelEditSkillBtn")?.addEventListener("click", () => {
        this.isEditing = false;
        this.currentEditSkill = null;
        this.render();
      });

      document.getElementById("cancelCompSkillBtn")?.addEventListener("click", () => {
        this.isEditing = false;
        this.currentEditSkill = null;
        this.render();
      });

      document.getElementById("saveCompSkillBtn")?.addEventListener("click", () => this.handleSaveSkill());
    } else {
      document.getElementById("compNewSkillBtn")?.addEventListener("click", () => {
        this.isEditing = true;
        this.currentEditSkill = { name: "", description: "", content: "", metadata: {}, _customMetaText: "" };
        this.render();
      });

      document.getElementById("compEmptyNewBtn")?.addEventListener("click", () => {
        this.isEditing = true;
        this.currentEditSkill = { name: "", description: "", content: "", metadata: {}, _customMetaText: "" };
        this.render();
      });

      const searchInput = document.getElementById("compSearchInput");
      searchInput?.addEventListener("input", (e) => {
        this.searchQuery = e.target.value;
        const searchBtn = document.getElementById("compSearchBtn");
        if (searchBtn) searchBtn.disabled = !this.searchQuery.trim() || this.isSearching;
      });

      searchInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && this.searchQuery.trim() && !this.isSearching) {
          this.handleSearch();
        }
      });

      document.getElementById("compSearchBtn")?.addEventListener("click", () => this.handleSearch());

      document.getElementById("compClearSearchBtn")?.addEventListener("click", () => {
        this.searchQuery = "";
        this.statusMessage = null;
        this.loadSkills();
      });

      // Expand/collapse previews
      document.querySelectorAll(".skill-content-preview").forEach((el) => {
        el.addEventListener("click", () => {
          if (el.style.maxHeight === "none") {
            el.style.maxHeight = "80px";
          } else {
            el.style.maxHeight = "none";
          }
        });
      });

      // Edit buttons
      document.querySelectorAll(".comp-edit-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.id;
          const found = this.skills.find((s) => s.id === id);
          if (found) {
            this.isEditing = true;
            this.currentEditSkill = { ...found };
            this.render();
          }
        });
      });

      // Delete buttons
      document.querySelectorAll(".comp-delete-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          await this.handleDeleteSkill(id);
        });
      });
    }
  }

  async handleSaveSkill() {
    this.syncEditorStateFromInputs();
    const isNew = !this.currentEditSkill?.id;
    const name = this.currentEditSkill?.name?.trim();
    const description = this.currentEditSkill?.description?.trim();
    const content = this.currentEditSkill?.content?.trim();
    const importFromFile = this.currentEditSkill?.metadata?.importFromFile?.trim();
    const metaText = this.currentEditSkill?._customMetaText?.trim();

    // Mandatory fields validation
    if (!name) {
      this.showStatus("err", "Skill Name is required.");
      return;
    }
    if (!description) {
      this.showStatus("err", "Short Description is required.");
      return;
    }
    if (!content) {
      this.showStatus("err", "Skill Content (Markdown) is required.");
      return;
    }

    let metaObj = {};
    if (metaText) {
      try {
        const parsed = JSON.parse(metaText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          this.showStatus("err", 'Metadata must be a valid JSON object (e.g. {"key": "value"}).');
          return;
        }
        metaObj = { ...parsed };
      } catch (err) {
        this.showStatus("err", `Invalid JSON in metadata: ${err.message}`);
        return;
      }
    }

    if (importFromFile) {
      metaObj.importFromFile = importFromFile;
    }

    const metadata = Object.keys(metaObj).length > 0 ? metaObj : undefined;

    this.isSaving = true;
    this.render();

    try {
      if (this.currentEditSkill?.id) {
        await this.app.callServerTool({
          name: "skills_update",
          arguments: {
            id: this.currentEditSkill.id,
            name,
            description,
            content,
            metadata,
          },
        });
        this.showStatus("ok", `✓ Skill "${name}" updated and re-indexed in Qdrant!`);
      } else {
        await this.app.callServerTool({
          name: "skills_create",
          arguments: {
            name,
            description,
            content,
            metadata,
          },
        });
        this.showStatus("ok", `✓ Skill "${name}" embedded and stored in Qdrant!`);
      }
      this.isEditing = false;
      this.currentEditSkill = null;
      this.isSaving = false;
      await this.loadSkills();
    } catch (err) {
      this.isSaving = false;
      this.showStatus("err", `Failed to save skill: ${err.message}`);
    }
  }

  async handleDeleteSkill(id) {
    this.deletingSkillId = id;
    this.render();

    try {
      await this.app.callServerTool({
        name: "skills_delete",
        arguments: { id },
      });
      this.deletingSkillId = null;
      this.showStatus("ok", "✓ Skill removed from Qdrant knowledge-base.");
      await this.loadSkills();
    } catch (err) {
      this.deletingSkillId = null;
      this.showStatus("err", `Failed to delete skill: ${err.message}`);
    }
  }

  async handleSearch() {
    if (!this.searchQuery.trim()) return;
    this.isSearching = true;
    this.render();

    try {
      const res = await this.app.callServerTool({
        name: "skills_search",
        arguments: { query: this.searchQuery.trim(), limit: 15 },
      });
      const data = JSON.parse(res.content[0].text);
      this.skills = data.results || [];
      this.isSearching = false;
      this.showStatus("ok", `Found ${this.skills.length} matching skills for "${this.searchQuery}"`);
    } catch (err) {
      this.isSearching = false;
      this.showStatus("err", `Search failed: ${err.message}`);
      this.render();
    }
  }
}

globalThis.SkillsComponent = SkillsComponent;
