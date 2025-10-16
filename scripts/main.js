// --- Reagent Tracker (quiet build: no global hook spam, DEBUG off) ---
"use strict";

const MODULE_ID = "reagent-tracker";
const DEBUG = false;

/* -------------------------------------------------------------------------------------------------
 *  DEBUG HELPERS (silent by default)
 * ------------------------------------------------------------------------------------------------- */
const D = {
  timeOrigin: (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(),
  now() {
    return (typeof performance !== "undefined" && performance.now)
      ? (performance.now() - this.timeOrigin).toFixed(3)
      : (Date.now() - this.timeOrigin);
  },
  _base(level, msg, data) {
    if (!DEBUG) return;
    const prefix = `${MODULE_ID} | t+${this.now()}ms | ${msg}`;
    try { (data === undefined ? console[level](prefix) : console[level](prefix, data)); }
    catch { console.log(prefix, data); }
  },
  log(msg, data)   { this._base("log", msg, data); },
  warn(msg, data)  { this._base("warn", msg, data); },
  error(msg, data) { this._base("error", msg, data); },
  group(label, collapsed = false) {
    if (!DEBUG) return;
    try { (collapsed ? console.groupCollapsed : console.group)(`${MODULE_ID} | ${label}`); } catch {}
  },
  groupEnd() { if (!DEBUG) return; try { console.groupEnd(); } catch {} },
  trace(label) { if (DEBUG && console.trace) console.trace(`${MODULE_ID} | ${label}`); }
};

function onHook(name, fn) {
  Hooks.on(name, (...args) => {
    if (DEBUG) {
      const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      D.group(`${name} [ENTER]`, true);
      D.trace(name);
      try {
        const result = fn(...args);
        const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        D.log(`${name} [RETURN]`, { result, dtMs: (t1 - t0).toFixed(3) });
        D.groupEnd();
        return result;
      } catch (e) {
        const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        D.error(`${name} [THROW]`, { error: e, dtMs: (t1 - t0).toFixed(3) });
        D.groupEnd();
        throw e;
      }
    } else {
      return fn(...args);
    }
  });
}

// ==============================
// Reagent Tracker — Lifecycle & Public API
// ==============================

Handlebars.registerHelper("ifEquals", function(a, b, options) {
  return (a === b) ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('sort', function (arr, field) {
  if (!Array.isArray(arr)) return [];
  return arr.slice().sort((a, b) =>
    String(a[field] ?? '').localeCompare(String(b[field] ?? ''), undefined, { sensitivity: 'base' })
  );
});


Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      ...(mod.api ?? {}),
      //getTable: () => ReagentData.getTable(),
      setTable: (rows) => ReagentData.setTable(rows),
      findReagentItemOnActor: findReagentItemOnActor_Auto,
      consumeReagent: consumeReagent_Auto,
      getSpellMap: () => SpellMapData.getMap(),
      setSpellMap: (rows) => SpellMapData.setMap(rows),
      runSpellMapBuilder,
     //openReagentEditor: () => new ReagentEditor().render(true),
      openSpellMap: () => new SpellMapManager().render(true),
      //openReagentPicker: (opts) => ReagentPicker.pick(opts),
      repairReagentCompendium,
      _postPreambleRegistered: mod.api?._postPreambleRegistered ?? false
    };
    globalThis.reagentTracker = mod.api;

    // --- midi-qol integration: reagent auto-consume at a reliable point ---
    if (game.modules.get("midi-qol")?.active) {
      if (!mod.api._postPreambleRegistered) {
        Hooks.on("midi-qol.postPreambleComplete", (wf) => {
          try {
            if (wf?.item) maybeConsumeForCast(wf.item, wf.id);
          } catch (e) {
            console.warn(`[${MODULE_ID}] postPreambleComplete handler failed`, e);
          }
        });
        mod.api._postPreambleRegistered = true;
        console.log(`[${MODULE_ID}] midi-qol.postPreambleComplete hook registered`);
      }
    } else {
      console.warn(`[${MODULE_ID}] midi-qol not active — reagent auto-consume hook not registered.`);
    }
  }

// ---- Helper: copy reagent key (and UUID) from compendium source onto an actor item
async function _rtBackfillReagentKeyFromCompSource(item) {
  try {
    if (!(item?.parent instanceof Actor)) return false;

    // Foundry v13 stores this here (not core.sourceId)
    const src = item._stats?.compendiumSource ?? "";
    if (!src || !src.startsWith("Compendium.world.reagents.Item.")) return false;

    // Already has a flag? nothing to do
    const already = item.getFlag("reagent-tracker", "reagentKey");
    if (already) return true;

    // src = "Compendium.world.reagents.Item.<id>"
    const parts = src.split(".");
    const packId = `${parts[1]}.${parts[2]}`; // "world.reagents"
    const compId = parts[4]; // document id
    const pack = game.packs.get(packId);
    if (!pack) return false;

    const doc = await pack.getDocument(compId);
    if (!doc) return false;

    // Read data from the compendium record
    const reagentKey = doc.getFlag("reagent-tracker", "key");
    const reagentUUID = doc.uuid; // canonical compendium UUID

    if (!reagentKey) return false;

    // Write flags to the embedded document
    await item.parent.updateEmbeddedDocuments("Item", [{
      _id: item.id,
      [`flags.${MODULE_ID}.reagentKey`]: reagentKey,
      // Optional but handy for debugging/linking:
      [`flags.${MODULE_ID}.reagentUUID`]: reagentUUID
    }]);

    console.log(`[${MODULE_ID}] linked '${item.name}' → key=${reagentKey}, uuid=${reagentUUID}`);
    return true;
  } catch (e) {
    console.warn(`[${MODULE_ID}] backfill reagent key failed`, e);
    return false;
  }
}

// ---- Hook: when a new embedded Item is created, defer and backfill the key
Hooks.on("createItem", (item, _opts, _userId) => {
  // Only care about actor-owned items; compendium docs also fire this hook in some cases
  if (!(item?.parent instanceof Actor)) return;

  // Defer slightly so compendiumSource is populated and the item is fully registered
  setTimeout(() => { _rtBackfillReagentKeyFromCompSource(item); }, 300);
});

// ---- One-time sweep on world load: fix any existing actor items that still lack the flag
(async () => {
  try {
    const actors = game.actors.contents ?? [];
    for (const a of actors) {
      // Iterate items that appear to be from reagent pack but lack our flag
      const items = a.items.contents ?? [];
      const candidates = items.filter(it =>
        !it.getFlag("reagent-tracker", "reagentKey") &&
        it._stats?.compendiumSource?.startsWith("Compendium.world.reagents.Item.")
      );
      for (const it of candidates) await _rtBackfillReagentKeyFromCompSource(it);
    }
  } catch (e) {
    console.warn(`[${MODULE_ID}] ready-time reagent key sweep failed`, e);
  }
})();

  // --- Core echo + consumption hooks ---
  installEchoOnlyHooks();
});


/* -------------------------------------------------------------------------------------------------
 *  DATA ACCESS LAYERS
 * ------------------------------------------------------------------------------------------------- */
//const ReagentData = (globalThis.ReagentData && typeof globalThis.ReagentData.getTable === "function")
//  ? globalThis.ReagentData
//  : {
//      getTable: () => game.settings.get(MODULE_ID, "reagentTable") ?? [],
//      setTable: (rows) => game.settings.set(MODULE_ID, "reagentTable", Array.isArray(rows) ? rows : []),
//      importBase: async () => {},
//    };

const SpellMapData = (globalThis.SpellMapData && typeof globalThis.SpellMapData.getMap === "function")
  ? globalThis.SpellMapData
  : {
      getMap: () => game.settings.get(MODULE_ID, "spellReagentMap") ?? [],
      setMap: (rows) => game.settings.set(MODULE_ID, "spellReagentMap", Array.isArray(rows) ? rows : []),
      packsToScan: () => {
        const raw = game.settings.get(MODULE_ID, "spellPacksToScan") ?? "";
        return String(raw).split(",").map(s => s.trim()).filter(Boolean);
      }
    };

function getConfiguredPacks() {
  const raw = game.settings.get(MODULE_ID, "compendiumPacks") ?? "";
  return String(raw).split(",").map(s => s.trim()).filter(Boolean);
}

// ---- midi-qol integration: single source of truth for reagent consumption
const _onPostPreambleComplete = (wf) => {
  try {
    if (!wf?.item) return;
    // Use the per-cast workflow id so our guard never collides between casts
    maybeConsumeForCast(wf.item, wf.id);
  } catch (e) {
    console.warn("[reagent-tracker] postPreambleComplete handler failed", e);
  }
};


/* -------------------------------------------------------------------------------------------------
 *  UI: REAGENT EDITOR
 * ------------------------------------------------------------------------------------------------- */
//class ReagentEditor extends FormApplication {
//  static get defaultOptions() {
//    return foundry.utils.mergeObject(super.defaultOptions, {
//      id: "reagent-editor",
//      title: "Reagent Table",
//      template: `modules/${MODULE_ID}/templates/reagent-editor.hbs`,
//      width: 700,
//      height: "auto",
//      closeOnSubmit: true
//    });
//  }
//  get isGM() { return game.user.isGM; }

//  async getData() {
//    if (!this.isGM) ui.notifications.warn("Only the GM can edit the reagent table.");
//    const table = ReagentData.getTable();
//    return {
//      tableJson: JSON.stringify(table, null, 2),
//      configuredPacks: getConfiguredPacks().join(", ")
//    };
//  }

//  activateListeners(html) {
//    super.activateListeners(html);
//    html.find("button.close").on("click", () => this.close());
//  }

//  async _updateObject(_event, formData) {
//    let rows;
//    try {
//      rows = JSON.parse(formData.table);
//      if (!Array.isArray(rows)) throw new Error("JSON must be an array.");
//      const seen = new Set();
//      for (const r of rows) {
//        if (r?.key) {
//          if (seen.has(r.key)) throw new Error(`Duplicate key: ${r.key}`);
//          seen.add(r.key);
//        }
//      }
//    } catch (err) {
//      console.error(err);
//      return ui.notifications.error(`Invalid JSON: ${err.message}`);
//    }
//    await ReagentData.setTable(rows);
//    ui.notifications.info("Reagent table saved.");
//  }
//}

/* -------------------------------------------------------------------------------------------------
 *  UI: REAGENT PICKER
 * ------------------------------------------------------------------------------------------------- */
class ReagentPicker extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "reagent-picker",
      title: "Pick Reagent",
      template: `modules/${MODULE_ID}/templates/reagent-picker.hbs`,
      width: 560,
      height: "auto",
      closeOnSubmit: true
    });
  }

  static async pick({ current } = {}) {
    return new Promise((resolve) => {
      const dlg = new this(current ?? {});
      dlg._resolver = resolve;
      dlg.render(true);
    });
  }

  constructor(current) {
    super(current);
    this.current = current || {};
  }

  /* -------------------------------------------- */
  activateListeners(html) {
    super.activateListeners(html);

    // Cancel → close
    html.find("button.cancel").on("click", () => this.close());

    // Replace the current unlink-reagent listener in activateListeners with this:
    html.find("[data-action='clear-mapping']").on("click", async (ev) => {
      ev.preventDefault();

      // Clear dropdown visually
      const select = html.find("select[name='compUuid']");
      select.val("");

      // Reset all internal state cleanly
      this.current.reagentUUID = null;
      this.current.reagentNameCached = null;
      this.current.reagentKey = null;
      this.current.minCost = null;
      this.current.quantity = 1;
      this.current.consumed = false;

      // Also clear reagent array form if present
      if (Array.isArray(this.current.reagents)) {
        this.current.reagents = [];
      }

      // Notify and re-render
      ui.notifications.info("Reagent link removed — not saved until you click Save.");

      await this.render(true);
    });



    // “Open in Compendium” link
    html.find("[data-action='open-compendium']").on("click", async (ev) => {
      ev.preventDefault();
      const uuid = ev.currentTarget.dataset.uuid;
      if (!uuid) return;
      try {
        const doc = await fromUuid(uuid);
        if (doc?.sheet) return doc.sheet.render(true);
        ui.notifications.warn("This reagent cannot be opened directly.");
      } catch (err) {
        console.warn("Failed to open reagent from compendium:", err);
        ui.notifications.error("Unable to open compendium entry.");
      }
    });
  }

  /* -------------------------------------------- */
  async getData() {
    const packKeys = getConfiguredPacks();
    const compendium = [];

    for (const key of packKeys) {
      const pack = game.packs.get(key);
      if (!pack) continue;

      const index = await pack.getIndex({ fields: ["name"] });
      const coll = pack.collection?.startsWith("Compendium.")
        ? pack.collection
        : `Compendium.${pack.collection}`;

      compendium.push(...index.map(e => ({
        pack: key,
        id: e._id,
        name: e.name,
        uuid: `${coll}.${e._id}`
      })));
    }

    // Sort alphabetically
    compendium.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // Flatten reagent info
    const reagent = this.current?.reagents?.[0] ? this.current.reagents[0] : this.current;
    reagent.spellNameCached = this.current?.spellNameCached || reagent.spellNameCached;

    const showUnlink = !!reagent?.reagentUUID;

    return { current: reagent, compendium, showUnlink };
  }

  /* -------------------------------------------- */
  async _updateObject(_event, formData) {
    const out = {
      reagentUUID: null,
      reagentNameCached: null,
      reagentKey: null,
      minCost: Number(formData.minCost || 0) || null,
      quantity: Number(formData.quantity || 1) || 1,
      consumed: !!formData.consumed
    };

    const uuid = formData.compUuid;

    // If dropdown cleared (de-linked) → resolve null
    if (!uuid) {
      this._resolver?.(null);
      return;
    }

    try {
      const doc = await fromUuid(uuid);
      out.reagentUUID = uuid;
      out.reagentNameCached = doc?.name ?? uuid;
      out.reagentKey = doc?.getFlag(MODULE_ID, "key") ?? null;
    } catch {
      out.reagentUUID = uuid;
      out.reagentNameCached = uuid;
    }

    this._resolver?.(out);
  }
}


//This should be the orignal ReagentPicker code before trying to remove the reagent data pieces (not the compendium - that was to stay)
//class ReagentPicker extends FormApplication {
//  static get defaultOptions() {
//    return foundry.utils.mergeObject(super.defaultOptions, {
//      id: "reagent-picker",
//      title: "Pick Reagent",
//      template: `modules/${MODULE_ID}/templates/reagent-picker.hbs`,
//      width: 520,
//      height: "auto",
//      closeOnSubmit: true
//    });
//  }

//  static async pick({ current } = {}) {
//    return new Promise((resolve) => {
//      const dlg = new this(current ?? {});
//      dlg._resolver = resolve;
//      dlg.render(true);
//    });
//  }

//  constructor(current) {
//    super(current);
//    this.current = current || {};
//  }

  
//  async getData() {
//    const table = ReagentData.getTable();

//    const packKeys = getConfiguredPacks();
//    const compendium = [];
//    for (const key of packKeys) {
//      const pack = game.packs.get(key);
//      if (!pack) continue;
//      const index = await pack.getIndex({ fields: ["name"] });
//      const coll  = pack.collection?.startsWith("Compendium.") ? pack.collection : `Compendium.${pack.collection}`;
//      compendium.push(...index.map(e => ({
//        pack: key,
//        id: e._id,
//        name: e.name,
//        uuid: `${coll}.${e._id}`
//      })));
//    }
//    return { current: this.current, table, compendium };
//  }

//async _updateObject(_event, formData) {
//  const out = {
//    reagentUUID: null,
//    reagentNameCached: null,
//    reagentKey: null,
//    minCost: Number(formData.minCost || 0) || null,
//    quantity: Number(formData.quantity || 1) || 1,
//    consumed: !!formData.consumed
//  };

//  const src = formData.source || "table";
//  if (src === "table") {
//    const key = formData.tableKey;
//    const row = ReagentData.getTable().find(r => r.key === key);
//    if (!row) { this._resolver?.(null); return; }
//    out.reagentKey = row.key;
//    out.reagentNameCached = row.name ?? row.key;
//    if (out.minCost == null && row.cost) out.minCost = Number(row.cost) || null;

    // --- NEW: try to resolve UUID automatically ---
//    const pack = game.packs.get("world.reagents");
//    if (pack) {
//      const idx = await pack.getIndex({ fields: ["name"] });
//      const match = idx.find(e => e.name.toLowerCase() === (row.name ?? row.key).toLowerCase());
//      if (match) out.reagentUUID = `Compendium.world.reagents.Item.${match._id}`;
//    }
//  } 
//  else if (src === "compendium") {
//    const uuid = formData.compUuid;
//    if (!uuid) { this._resolver?.(null); return; }
//    out.reagentUUID = uuid;
//    try {
//      const doc = await fromUuid(uuid);
//      out.reagentNameCached = doc?.name ?? uuid;
//    } catch { out.reagentNameCached = uuid; }
//  }

//  this._resolver?.(out);
//}

//}


/* -------------------------------------------------------------------------------------------------
 *  UI: SPELL MAP MANAGER
 * ------------------------------------------------------------------------------------------------- */

class SpellMapManager extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "spell-map-manager",
      title: "Spell Map",
      template: `modules/${MODULE_ID}/templates/spell-map.hbs`,
      width: 980,
      height: "auto",
      closeOnSubmit: false,
      resizable: true
    });
  }

  get isGM() { return game.user.isGM; }

  async getData() {
    if (!this.isGM) {
      ui.notifications.warn("Only the GM can manage the spell map.");
      return { rows: [], packs: "", counts: {}, empty: true };
    }

    const rows = SpellMapData.getMap();
    const packs = SpellMapData.packsToScan().join(", ");
    const counts = {
      total: rows.length,
      unmapped: rows.filter(r => r.status === "unmapped").length,
      guessed: rows.filter(r => r.status === "guessed").length,
      confirmed: rows.filter(r => r.status === "confirmed").length,
      stale: rows.filter(r => r.status === "staleUUID").length
    };

    return { rows, packs, counts, empty: rows.length === 0 };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='scan-packs']").on("click", async () => {
      try {
        const btn = html.find("[data-action='scan-packs']");
        btn.prop("disabled", true);
        const res = await runSpellMapBuilder();
        ui.notifications.info(`Spell scan: added ${res.added}, total ${res.total}`);
        this.render(true);
      } finally {
        html.find("[data-action='scan-packs']").prop("disabled", false);
      }
    });

    html.find("[data-action='save']").on("click", async () => {
      try {
        const payload = SpellMapData.getMap();
        await SpellMapData.setMap(payload);
        ui.notifications.info("Spell map saved.");
      } catch (e) {
        console.error(e);
        ui.notifications.error("Failed to save spell map.");
      }
    });

    html.find("[name='filter'], [name='search']").on("input change", () => this.#applyFilter(html));

    // 🧪 Updated Reagent Picker logic with de-link support
    html.find("[data-action='pick-reagent']").on("click", async (ev) => {
      const idx = Number(ev.currentTarget.dataset.index);
      const rows = SpellMapData.getMap();
      const row = rows[idx];
      if (!row) return;

      const picked = await ReagentPicker.pick({ current: row });

      if (!picked) {
        // 🧹 De-linked: clear the reagent mapping entirely
        rows[idx].reagents = [];
        rows[idx].status = "unmapped";
        ui.notifications.info(`Reagent link removed for "${row.spellNameCached}".`);
      } else {
        // ✅ Normal confirmed mapping
        rows[idx].reagents = [{
          reagentUUID: picked.reagentUUID ?? null,
          reagentNameCached: picked.reagentNameCached ?? null,
          reagentKey: picked.reagentKey ?? null,
          minCost: picked.minCost ?? null,
          quantity: picked.quantity ?? 1,
          consumed: picked.consumed ?? true
        }];
        rows[idx].status = "confirmed";
        ui.notifications.info(`Reagent linked: "${picked.reagentNameCached}" → "${row.spellNameCached}".`);
      }

      await SpellMapData.setMap(rows);
      this.render(true);
    });

    html.find("[data-action='mark-confirmed']").on("click", async (ev) => {
      const idx = Number(ev.currentTarget.dataset.index);
      const rows = SpellMapData.getMap();
      if (rows[idx]) {
        rows[idx].status = "confirmed";
        await SpellMapData.setMap(rows);
        this.render(true);
      }
    });

    html.find("[data-action='mark-unmapped']").on("click", async (ev) => {
      const idx = Number(ev.currentTarget.dataset.index);
      const rows = SpellMapData.getMap();
      if (rows[idx]) {
        rows[idx].status = "unmapped";
        rows[idx].reagents = [];
        await SpellMapData.setMap(rows);
        this.render(true);
      }
    });

    html.find("[data-action='delete']").on("click", async (ev) => {
      const idx = Number(ev.currentTarget.dataset.index);
      const rows = SpellMapData.getMap();
      rows.splice(idx, 1);
      await SpellMapData.setMap(rows);
      this.render(true);
    });

    if (this.isGM) {
      html.find("button.repair-compendium").on("click", async () => {
        const repaired = await reagentTracker.repairReagentCompendium();
        ui.notifications.info(`Repaired ${repaired} reagent(s) in world.reagents.`);
      });
    }
  }

  #applyFilter(html) {
    const filter = html.find("[name='filter']").val();
    const q = String(html.find("[name='search']").val() || "").toLowerCase();
    const rows = html.find("tbody tr");
    rows.each((_, tr) => {
      const $tr = $(tr);
      const status = $tr.data("status");
      const name = String($tr.data("spellname") || "").toLowerCase();
      const reagent = String($tr.find(".reagent-cell").text() || "").toLowerCase();
      let show = true;
      if (filter && status !== filter) show = false;
      if (q && !(name.includes(q) || reagent.includes(q))) show = false;
      $tr.toggle(show);
    });
  }
}



/* -------------------------------------------------------------------------------------------------
 *  SPELL MAP BUILDER
 * ------------------------------------------------------------------------------------------------- */
async function runSpellMapBuilder() {
  const packs = SpellMapData.packsToScan();
  if (!packs.length) {
    ui.notifications.warn(`${MODULE_ID}: No spell packs configured to scan.`);
    return { scanned: 0, added: 0, skipped: 0, errors: 0, total: SpellMapData.getMap().length };
  }

  const existing = SpellMapData.getMap();
  const byUUID = new Map(existing.map(e => [e.spellUUID, e]));

  let scanned = 0, added = 0, skipped = 0, errors = 0;

  for (const key of packs) {
    try {
      const pack = game.packs.get(key);
      if (!pack) { console.warn(`${MODULE_ID}: Pack not found: ${key}`); continue; }
      const docs = await pack.getDocuments();
      for (const doc of docs) {
        try {
          if (doc.type !== "spell") continue;
          scanned++;
          const m = doc.system?.materials ?? {};
          const costly = Number(m.cost || 0) > 0;
          const consumed = !!m.consumed;
          if (!(costly || consumed)) { skipped++; continue; }

          const entry = {
            spellUUID: doc.uuid,
            spellNameCached: doc.name,
            spellPackCached: key,
            reagents: [],
            status: "unmapped",
            notes: "",
            lastChecked: new Date().toISOString()
          };

          if (!byUUID.has(doc.uuid)) {
            byUUID.set(doc.uuid, entry);
            added++;
          } else {
            const prev = byUUID.get(doc.uuid);
            prev.spellNameCached = doc.name;
            prev.spellPackCached = key;
            prev.lastChecked = new Date().toISOString();
            byUUID.set(doc.uuid, prev);
          }
        } catch (e) { console.error(`${MODULE_ID}: Error processing spell in ${key}`, e); errors++; }
      }
    } catch (e) { console.error(`${MODULE_ID}: Error scanning pack ${key}`, e); errors++; }
  }

  const merged = Array.from(byUUID.values());
  await SpellMapData.setMap(merged);

  // Keep the GM whisper, but it's not console spam.
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `<div class="reagent-tracker-msg">🧭 <b>${MODULE_ID}</b>: Scanned ${scanned} spells; added <b>${added}</b>, skipped ${skipped}, errors ${errors}. Total entries: ${merged.length}.</div>`,
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id)
  });

  return { scanned, added, skipped, errors, total: merged.length };
}

// ------------------------------------------------------------------------------------------------
// 🧭 Repair Compendium Reagents — add missing reagent-tracker keys to all compendium entries
// ------------------------------------------------------------------------------------------------
async function repairReagentCompendium() {
  const pack = game.packs.get("world.reagents");
  if (!pack) return ui.notifications.warn("Reagent pack not found (expected world.reagents)");
  
  const docs = await pack.getDocuments();
  let fixed = 0;

  for (const doc of docs) {
    const existing = doc.getFlag("reagent-tracker", "key");
    if (!existing) {
      const newKey = doc.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_");
      await doc.setFlag("reagent-tracker", "key", newKey);
      console.log(`[reagent-tracker] Repaired ${doc.name} → key=${newKey}`);
      fixed++;
    }
  }

  ui.notifications.info(`Repaired ${fixed} reagent(s)`);
  return fixed;
}

// Expose for console / UI access
game.reagentTrackerRepair = repairReagentCompendium;


/* -------------------------------------------------------------------------------------------------
 *  SPELL→REAGENT LOOKUP + INVENTORY CHECK + ECHO
 * ------------------------------------------------------------------------------------------------- */
function getSpellMapArray() {
  try {
    const rows = SpellMapData?.getMap?.();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    D.warn("SpellMapData.getMap failed", { error: e });
    return [];
  }
}

function findSpellMapEntryForItem(item) {
  const rows = getSpellMapArray();
  if (!rows.length) return null;

  const uuid = item?.uuid ?? item?._uuid ?? null;
  const name = (item?.name || "").toLowerCase();

  if (uuid) {
    const byUUID = rows.find(r => r?.spellUUID === uuid && Array.isArray(r?.reagents) && r.reagents.length);
    if (byUUID) return byUUID;
  }

  const byName = rows.find(r =>
    (r?.spellNameCached || "").toLowerCase() === name &&
    Array.isArray(r?.reagents) && r.reagents.length
  );
  if (byName) return byName;

  const partial = rows.find(r =>
    typeof r?.spellNameCached === "string" &&
    r.spellNameCached.toLowerCase().startsWith(name) &&
    r.status === "confirmed" &&
    Array.isArray(r?.reagents) && r.reagents.length
  );
  return partial ?? null;
}

function _normalize(str) { return String(str || "").trim().toLowerCase(); }

/** Return all matching reagent items (best-effort) on an actor. */
function findReagentItemOnActor_Auto(actor, reagent) {
  if (!actor) return [];
  const targetName = _normalize(reagent?.reagentNameCached || reagent?.reagentKey || reagent?.reagentUUID);
  const targetKey  = _normalize(reagent?.reagentKey);
  const out = [];

  // Actor5e.items is a Collection; iterate contents (or fallback)
  const iter = actor.items?.contents ?? actor.items ?? [];
  for (const it of iter) {
    const iname = _normalize(it?.name);
    const ikey  = _normalize(it?.flags?.[MODULE_ID]?.reagentKey);

    if (ikey && targetKey && ikey === targetKey) { out.push(it); continue; }
    if (targetName && iname === targetName) { out.push(it); continue; }
    if (targetName && iname.startsWith(targetName)) { out.push(it); continue; }
  }
  return out;
}

function countActorReagent(actor, reagent) {
  const items = findReagentItemOnActor_Auto(actor, reagent);
  let qty = 0;
  for (const it of items) qty += Number(it?.system?.quantity ?? 1) || 0;
  // annotate the match “type” just for logs
  let match = null;
  if (items.length) {
    const hadKey   = items.some(it => _normalize(it.flags?.[MODULE_ID]?.reagentKey) &&
                                      _normalize(it.flags?.[MODULE_ID]?.reagentKey) === _normalize(reagent?.reagentKey));
    const hadExact = items.some(it => _normalize(it.name) === _normalize(reagent?.reagentNameCached));
    match = hadKey ? "reagentKey" : (hadExact ? "cachedName" : "nameStartsWith");

  }
  return { qty, match, items };
}

function echoReagentRequirement(item) {
  const entry = findSpellMapEntryForItem(item);
  if (!entry) return;

  const g = entry.reagents[0] ?? null;
  if (!g) return;

  // Inventory check
  const actor = item?.actor;
  const needQty = g.quantity ?? 1;
  const { qty: haveQty, match } = countActorReagent(actor, g);
  const haveStr = haveQty > 0 ? `HAS ×${haveQty}` : "MISSING";
  const matchStr = match ? ` [match=${match}]` : "";

  const info = `${item?.actor?.name ?? "(actor)"} casts ${item?.name ?? "(spell)"} → reagent: ${g.reagentNameCached ?? g.reagentKey ?? g.reagentUUID ?? "(unnamed)"}${g.minCost ? ` (${g.minCost}gp)` : ""} ×${needQty}${g.consumed ? " (consumed)" : ""} [${entry.status ?? "?"}] → ${haveStr}${matchStr}`;

  // Always echo to console for these tests (independent of DEBUG)
  console.log(`[${MODULE_ID}] t+${D.now()}ms | ${info}`);

  const shouldPopup = game.settings.get(MODULE_ID, "showEchoNotice");
  if (shouldPopup) {
    try {
      const name = g.reagentNameCached ?? g.reagentKey ?? g.reagentUUID ?? "(unnamed)";
      const consumed = g.consumed ? " (consumed)" : "";
      ui.notifications?.info?.(`Reagent: ${name} ×${needQty}${consumed} → ${haveStr}`);
    } catch {}
  }
}

/* -------------------------------------------------------------------------------------------------
 *  CONSUMPTION CORE
 * ------------------------------------------------------------------------------------------------- */

/**
 * Consume up to `needQty` across matching stacks on the actor.
 * Returns { consumed: number, updates: number, deleted: number }
 */
async function consumeReagent_Auto(actor, reagent, needQty) {
  if (!actor || !reagent || !needQty || needQty <= 0) return { consumed: 0, updates: 0, deleted: 0 };

  const matches = findReagentItemOnActor_Auto(actor, reagent);
  if (!matches.length) return { consumed: 0, updates: 0, deleted: 0 };

  // Sort smallest stacks first to keep inventory neat
  const stacks = matches
    .map(it => ({ it, q: Number(it?.system?.quantity ?? 1) || 0 }))
    .filter(s => s.q > 0)
    .sort((a,b) => a.q - b.q);

  let remaining = needQty;
  const updates = [];
  const deletions = [];

  for (const s of stacks) {
    if (remaining <= 0) break;
    const take = Math.min(s.q, remaining);
    const newQty = s.q - take;
    remaining -= take;

    if (newQty > 0) {
      updates.push({ _id: s.it.id, "system.quantity": newQty });
    } else {
      deletions.push(s.it.id);
    }
  }

  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (deletions.length) await actor.deleteEmbeddedDocuments("Item", deletions);

  const consumed = needQty - Math.max(remaining, 0);
  return { consumed, updates: updates.length, deleted: deletions.length };
}

// Guard so we don't double-consume if both core + midi fire
const _castConsumeGuards = new Set(); // keys like `${actorId}:${itemId}:${ctxId}`
function _makeConsumeKey(item, ctxId) {
  const a = item?.actor?.id ?? "noactor";
  const i = item?.id ?? "noitem";

  // Prefer the ctxId we pass from midi workflow (wf.id).
  // Fall back to a *unique* id (not item.uuid, which is stable across casts).
  const rnd = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : (typeof randomID === "function" ? randomID() : `${a}:${i}:${Date.now()}:${Math.random()}`);

  const c = (ctxId != null ? ctxId : rnd);
  return `${a}:${i}:${c}`;
}


async function maybeConsumeForCast(item, ctxId) {
  try {
    if (!game.settings.get(MODULE_ID, "autoConsumeOnCast")) return true;

    const entry = findSpellMapEntryForItem(item);
    const g = entry?.reagents?.[0];
    if (!g) return true;
    if (!g.consumed) return true; // mapping says not consumed

    const actor = item?.actor;
    const needQty = g.quantity ?? 1;

    // ensure we have something to consume; echo already told us amounts
    const { qty: haveQty } = countActorReagent(actor, g);
    if (haveQty <= 0) return true; // do not block here

    const key = _makeConsumeKey(item, ctxId);
    if (_castConsumeGuards.has(key)) return true;
    _castConsumeGuards.add(key);

    const res = await consumeReagent_Auto(actor, g, Math.min(needQty, haveQty));

    const who  = actor?.name ?? "(actor)";
    const sNam = item?.name ?? "(spell)";
    const rNam = g.reagentNameCached ?? g.reagentKey ?? g.reagentUUID ?? "(reagent)";
    console.log(`[${MODULE_ID}] t+${D.now()}ms | CONSUME ${who} ${sNam}: ${rNam} → used ${res.consumed} (updates=${res.updates}, deleted=${res.deleted})`);

    return true;
  } catch (e) {
    D.warn("maybeConsumeForCast failed", e);
    return true;
  }
}

/* -------------------------------------------------------------------------------------------------
 *  HOOKS (echo + consumption; no blocking)
 * ------------------------------------------------------------------------------------------------- */
function installEchoOnlyHooks() {
  onHook("dnd5e.preUseItem", (item /*, config*/) => {
    if (!item || item.type !== "spell") return;
    echoReagentRequirement(item);
  });

  // Core DnD5e: consume once per item use
  onHook("dnd5e.useItem", async (item /*, config, options */) => {
    if (!item || item.type !== "spell") return;
    await maybeConsumeForCast(item, "dnd5e.useItem");
  });

  const midiActive = !!game.modules.get("midi-qol")?.active;
  if (midiActive) {
    const echoMidi = (workflow /*, label */) => {
      const item = workflow?.item;
      if (item?.type !== "spell") return true;
      echoReagentRequirement(item);
      return true; // never block
    };

    onHook("midi-qol.preItemUse",          (wf) => echoMidi(wf));
    onHook("midi-qol.preItemRoll",         (wf) => echoMidi(wf));
    onHook("midi-qol.preItemRollV2",       (wf) => echoMidi(wf));
    onHook("midi-qol.prePreambleComplete", (wf) => echoMidi(wf));

    // Consume once the preamble completes (one time per cast path)
    onHook("midi-qol.postPreambleComplete", async (wf) => {
      const item = wf?.item;
      if (item?.type !== "spell") return;
      const ctxId = wf?.uuid || wf?.id || "midi.postPreamble";
      await maybeConsumeForCast(item, ctxId);
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 *  BOOT + SETTINGS
 * ------------------------------------------------------------------------------------------------- */
function registerSettings() {
  game.settings.register(MODULE_ID, "healthcheck", {
    name: "Healthcheck",
    hint: "If you can see this, settings registered.",
    scope: "world", config: true, type: Boolean, default: true
  });
  
  game.settings.register(MODULE_ID, "preferMidi", {
    name: "Use Midi-QOL if available",
    hint: "If enabled and Midi-QOL is active, enforcement runs on Midi’s workflow too.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "showBlockChat", {
    name: "Show Chat Message When Blocked",
    scope: "client", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "showFallbackNotice", {
    name: "GM Notice on Fallback",
    scope: "world", config: true, type: Boolean, default: true
  });

  //game.settings.register(MODULE_ID, "reagentTable", {
  //  name: "Reagent Table",
  //  hint: "World storage for the reagent table.",
  //  scope: "world", config: false, type: Object, default: []
  //});
  game.settings.register(MODULE_ID, "compendiumPacks", {
    name: "Reagent Compendium Packs",
    hint: "Comma-separated list of packs, e.g. 'reagent-tracker.reagents,my-xge.reagents'",
    scope: "world", config: true, type: String, default: `${MODULE_ID}.reagents`
  });

  // Echo popup toggle (off by default to avoid noise)
  game.settings.register(MODULE_ID, "showEchoNotice", {
    name: "Popup Reagent Reminder on Cast",
    hint: "Show a small notification when a mapped spell is cast.",
    scope: "client", config: true, type: Boolean, default: false
  });

  game.settings.register(MODULE_ID, "spellReagentMap", {
    name: "Spell→Reagent Map (World)",
    scope: "world", config: false, type: Object, default: []
  });

  game.settings.register(MODULE_ID, "spellPacksToScan", {
    name: "Spell Packs to Scan",
    hint: "Comma-separated compendium keys (e.g., 'dnd5e.spells,my-pack.spells').",
    scope: "world", config: true, type: String, default: "dnd5e.spells"
  });

  // NEW: auto-consume toggle
  game.settings.register(MODULE_ID, "autoConsumeOnCast", {
    name: "Auto-consume reagents on cast",
    hint: "When a mapped spell is cast and the mapping marks the reagent as consumed, automatically deduct it from the caster’s inventory.",
    scope: "world", config: true, type: Boolean, default: true
  });

  //game.settings.registerMenu(MODULE_ID, "openEditor", {
  //  name: "Open Reagent Table",
  //  label: "Open Reagent Table",
  //  icon: "fas fa-flask",
  //  type: ReagentEditor, restricted: true
  //});

  game.settings.registerMenu(MODULE_ID, "openSpellMap", {
    name: "Open Spell Map",
    label: "Open Spell Map",
    icon: "fas fa-wand-sparkles",
    type: SpellMapManager, restricted: true
  });
}

Hooks.once("ready", () => {
  globalThis.repairReagentCompendium = repairReagentCompendium;
  game.reagentTrackerRepair = repairReagentCompendium;
});
