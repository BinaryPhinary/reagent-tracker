// --- Reagent Tracker (v13) ---
const MODULE_ID = "reagent-tracker";

/** ----- Hooks ----- **/
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init hook firing`);
  registerSettings();
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready hook firing`);

  const mod = game.modules.get(MODULE_ID);
  if (!mod) {
    console.error(`${MODULE_ID} | Could not find module record to attach API.`);
    return;
  }

  // Attach everything (existing + new helpers)
  mod.api = {
    ...(mod.api ?? {}),
    getTable: () => game.settings.get(MODULE_ID, "reagentTable") ?? [],
    findReagentItemOnActor: findReagentItemOnActor_Auto,
    consumeReagent: consumeReagent_Auto,

    // Expose for console/tests
    logMat,
    shouldConsumeForSpell,
    enforceReagents
  };

  // Optional: easy global handle for console debugging
  globalThis.reagentTracker = mod.api;
  console.log(`${MODULE_ID} | API exposed on globalThis.reagentTracker`);

  registerSpellHooks();
});

/** ----- Hook registration (Midi-QOL or core dnd5e) ----- **/
function registerSpellHooks() {
  const preferMidi = game.settings.get(MODULE_ID, "preferMidi");
  const midiActive = !!game.modules.get("midi-qol")?.active;

  if (preferMidi && midiActive) {
    console.log(`${MODULE_ID} | Using Midi-QOL hooks`);

    // Fire-and-forget card cleanup when we cancel
    function scrubCardIfCancelled(workflow) {
      const itemId = workflow?.item?.id;
      if (!itemId) return;
      const once = Hooks.on("createChatMessage", (msg) => {
        try {
          const fromSameItem =
            msg?.flags?.dnd5e?.itemId === itemId ||
            msg?.flags?.midiqol?.itemId === itemId;
          if (fromSameItem && workflow?.aborted) msg.delete();
        } finally {
          Hooks.off("createChatMessage", once);
        }
      });
    }

    // Synchronous cancel helper (marks aborted and removes any card that slipped out)
    function cancelMidi(workflow) {
      try { workflow.aborted = true; } catch (_) {}
      const cardId = workflow?.itemCardId ?? workflow?.chatCard?.id;
      if (cardId) {
        const msg = game.messages.get(cardId);
        msg?.delete?.();
      }
      scrubCardIfCancelled(workflow);
      return false; // Explicit cancel for Midi-QOL
    }

    // Shared handler for all Midi pre hooks
    const midiPreHandler = async (workflow) => {
      try {
        const r = await enforceReagents(workflow); // { handled, cancel }
        if (r?.cancel) return cancelMidi(workflow);
      } catch (e) {
        console.error(`${MODULE_ID} | Midi pre-hook error`, e);
      }
      return true; // allow
    };

    Hooks.on("midi-qol.preItemRoll", midiPreHandler);
    Hooks.on("midi-qol.preItemRollV2", midiPreHandler);
    Hooks.on("midi-qol.prePreambleComplete", midiPreHandler);
    return;
  }

  // Fallback: core dnd5e (no Midi-QOL)
  console.log(`${MODULE_ID} | Using dnd5e hooks`);

  Hooks.on("dnd5e.preUseItem", async (item /*, config, options */) => {
    try {
      if (!item || item.type !== "spell") return;
      const r = await enforceReagents(item); // { handled, cancel }
      if (r?.cancel) {
        // Returning false here cancels the item use and prevents the chat card
        return false;
      }
    } catch (e) {
      console.error(`${MODULE_ID} | dnd5e.preUseItem error`, e);
    }
  });
}


  // Fallback: core dnd5e hook (no Midi)
  console.log(`${MODULE_ID} | Using dnd5e hooks`);
  Hooks.on("dnd5e.preUseItem", async (item, config, options) => {
    try {
      if (!item || item.type !== "spell") return;
      if (!shouldConsumeForSpell(item)) return;

      const mat = getSpellMaterialText(item).text;
      if (!mat) return;

      const api = game.modules.get(MODULE_ID)?.api;
      const table = api?.getTable() ?? [];
      const row = findRowFromMaterialText(table, mat);
      if (!row) return;

      const res = await api.consumeReagent(item.actor, row, 1);
      if (!res.ok) {
        ui.notifications.warn(`${item.name}: missing/insufficient reagent (${row.name ?? row.key}).`);
        // Returning false cancels the item usage in dnd5e
        return false;
      }
    } catch (e) {
      console.error(`${MODULE_ID} | dnd5e.preUseItem error`, e);
    }
  });

/** ----- Settings (single table) ----- **/
function registerSettings() {
  // Visible healthcheck to confirm registration
  game.settings.register(MODULE_ID, "healthcheck", {
    name: "Healthcheck",
    hint: "If you can see this, settings registered.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Hidden reagent table store
  game.settings.register(MODULE_ID, "reagentTable", {
    name: "Reagent Table",
    hint: "World storage for the reagent table.",
    scope: "world",
    config: false,
    type: Object,
    default: [] // Array<ReagentRow>
  });

  // User-configured compendium packs to sync
  game.settings.register(MODULE_ID, "compendiumPacks", {
    name: "Compendium Packs to Sync",
    hint: "Comma-separated list of packs, e.g. 'reagent-tracker.reagents,my-xge.reagents'",
    scope: "world",
    config: true,
    type: String,
    default: `${MODULE_ID}.reagents`
  });

  // GM menu to open the editor
  game.settings.registerMenu(MODULE_ID, "openEditor", {
    name: "Open Reagent Table",
    label: "Open Reagent Table",
    icon: "fas fa-flask",
    type: ReagentEditor,   // class is defined below; file parses fully before hooks fire
    restricted: true
  });

  game.settings.register(MODULE_ID, "preferMidi", {
    name: "Use Midi-QOL if available",
    hint: "If checked and Midi-QOL is active, reagent consumption hooks use Midi's workflow. Otherwise falls back to core dnd5e.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}

/** ----- Data helpers ----- **/
class ReagentData {
  static getTable() {
    const rows = game.settings.get(MODULE_ID, "reagentTable") ?? [];
    return foundry.utils.duplicate(rows);
  }

  static async setTable(rows) {
    await game.settings.set(MODULE_ID, "reagentTable", rows);
  }

  static async importBase(mode) {
    const path = `modules/${MODULE_ID}/data/base-reagents.json`;
    const resp = await fetch(path, { cache: "no-store" });
    if (!resp.ok) throw new Error(`Failed to load base table: ${resp.status}`);
    const base = await resp.json();
    if (!Array.isArray(base)) throw new Error("Base table must be an array.");

    if (mode === "overwrite") {
      await this.setTable(base);
      return base;
    }

    if (mode === "merge") {
      const current = this.getTable();
      const keys = new Set(current.map(r => r.key));
      const merged = current.concat(base.filter(r => !keys.has(r.key)));
      await this.setTable(merged);
      return merged;
    }

    throw new Error(`Unknown import mode: ${mode}`);
  }
}

/** ----- Compendium sync helpers ----- **/
function getConfiguredPacks() {
  const raw = game.settings.get(MODULE_ID, "compendiumPacks") ?? "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function normalizeName(s) {
  return String(s ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function deriveKeyFromName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function mergeRow(into, from) {
  into.name = into.name ?? from.name;
  into.key = into.key ?? from.key ?? deriveKeyFromName(from.name);
  into.unit = into.unit ?? from.unit ?? "ea";
  into.cost = (into.cost ?? 0) || (from.cost ?? 0);
  into.consume = into.consume ?? from.consume ?? { mode: "quantity", perCast: 1 };

  const a = Array.isArray(into.aliases) ? into.aliases : [];
  const b = Array.isArray(from.aliases) ? from.aliases : [];
  const aliasSet = new Set([...a, ...b].map(normalizeName).filter(Boolean));
  into.aliases = [...aliasSet];

  const s1 = Array.isArray(into.sources) ? into.sources : (into.source ? [into.source] : []);
  const s2 = Array.isArray(from.sources) ? from.sources : (from.source ? [from.source] : []);
  into.sources = [...s1, ...s2];
  delete into.source;
}

async function readPackRows(packKey) {
  const pack = game.packs.get(packKey);
  if (!pack) throw new Error(`Compendium not found: ${packKey}`);
  const docs = await pack.getDocuments();

  return docs.map(it => {
    const f = it.getFlag(MODULE_ID, "data") ?? {};
    return {
      key: f.key ?? it.getFlag(MODULE_ID, "key") ?? deriveKeyFromName(it.name),
      name: it.name,
      aliases: f.aliases ?? it.getFlag(MODULE_ID, "aliases") ?? [],
      unit: f.unit ?? "ea",
      cost: Number(f.cost ?? 0),
      consume: f.consume ?? { mode: "quantity", perCast: 1 },
      source: { pack: packKey }
    };
  });
}

async function importTableFromConfiguredPacks({ mode = "merge" } = {}) {
  const packs = getConfiguredPacks();
  if (!packs.length) throw new Error("No compendium packs configured.");

  const incoming = [];
  for (const pk of packs) {
    try {
      const rows = await readPackRows(pk);
      incoming.push(...rows);
    } catch (e) {
      console.warn(`Skipping pack ${pk}:`, e);
    }
  }

  if (mode === "overwrite") {
    await ReagentData.setTable(incoming);
    return { imported: incoming.length, mergedInto: 0 };
  }

  // merge mode
  const table = ReagentData.getTable();
  const byKey = new Map(table.map(r => [r.key ?? deriveKeyFromName(r.name), structuredClone(r)]));
  const byName = new Map(table.map(r => [normalizeName(r.name), r]));

  let mergedInto = 0;
  for (const row of incoming) {
    const key = row.key ?? deriveKeyFromName(row.name);
    const nameN = normalizeName(row.name);
    const existing = byKey.get(key) || byName.get(nameN);
    if (existing) {
      mergeRow(existing, row);
      byKey.set(existing.key ?? key, existing);
      mergedInto++;
    } else {
      byKey.set(key, row);
    }
  }

  await ReagentData.setTable([...byKey.values()]);
  return { imported: incoming.length, mergedInto };
}

async function exportTableToFirstConfiguredPack() {
  const [firstPack] = getConfiguredPacks();
  if (!firstPack) throw new Error("No compendium packs configured.");

  const pack = game.packs.get(firstPack);
  if (!pack) throw new Error(`Compendium not found: ${firstPack}`);

  const index = await pack.getIndex();
  const byName = new Map(index.map(e => [e.name, e._id]));
  const table = ReagentData.getTable();

  let created = 0, updated = 0;

  for (const row of table) {
    const payload = {
      name: row.name,
      type: "consumable",
      system: { description: { value: "" }, consumableType: "material", quantity: 0 },
      flags: {
        [MODULE_ID]: {
          data: {
            key: row.key,
            aliases: row.aliases ?? [],
            unit: row.unit ?? "ea",
            cost: row.cost ?? 0,
            consume: row.consume ?? { mode: "quantity", perCast: 1 }
          }
        }
      }
    };

    const existingId = byName.get(row.name);
    if (existingId) {
      const doc = await pack.getDocument(existingId);
      await doc.update(payload);
      updated++;
    } else {
      await pack.createDocument(payload);
      created++;
    }
  }

  return { created, updated, pack: firstPack };
}

/** ----- Editor UI ----- **/
class ReagentEditor extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "reagent-editor",
      title: "Reagent Table",
      template: `modules/${MODULE_ID}/templates/reagent-editor.hbs`,
      width: 700,
      height: "auto",
      closeOnSubmit: true
    });
  }

  get isGM() { return game.user.isGM; }

  async getData() {
    if (!this.isGM) ui.notifications.warn("Only the GM can edit the reagent table.");
    const table = ReagentData.getTable();
    return {
      tableJson: JSON.stringify(table, null, 2),
      configuredPacks: getConfiguredPacks().join(", ")
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Close
    html.find("button.close").on("click", () => this.close());

    // Import Base
    html.find("button.import-base").on("click", async () => {
      const mode = html.find("select[name='importMode']").val();
      try {
        await ReagentData.importBase(mode);
        ui.notifications.info(`Base table imported (${mode}).`);
        this.render(true);
      } catch (err) {
        console.error(err);
        ui.notifications.error(`Import failed: ${err.message}`);
      }
    });

    // Import from configured packs
    html.find("button.import-compendium").on("click", async () => {
      try {
        const res = await importTableFromConfiguredPacks({ mode: "merge" });
        ui.notifications.info(`Imported ${res.imported} rows; merged ${res.mergedInto}.`);
        this.render(true);
      } catch (e) {
        console.error(e);
        ui.notifications.error(e.message);
      }
    });

    // Export to first configured pack
    html.find("button.export-compendium").on("click", async () => {
      try {
        const res = await exportTableToFirstConfiguredPack();
        ui.notifications.info(`Exported to ${res.pack}: ${res.created} created, ${res.updated} updated.`);
      } catch (e) {
        console.error(e);
        ui.notifications.error(e.message);
      }
    });
  }

  async _updateObject(_event, formData) {
    let rows;
    try {
      rows = JSON.parse(formData.table);
      if (!Array.isArray(rows)) throw new Error("JSON must be an array.");
      const seen = new Set();
      for (const r of rows) {
        if (r?.key) {
          if (seen.has(r.key)) throw new Error(`Duplicate key: ${r.key}`);
          seen.add(r.key);
        }
      }
    } catch (err) {
      console.error(err);
      return ui.notifications.error(`Invalid JSON: ${err.message}`);
    }

    await ReagentData.setTable(rows);
    ui.notifications.info("Reagent table saved.");
  }
}

/** ----- Zero-tag reagent resolution by name/type ----- **/
const NAME_MATCH_STRICT = true;

function pluralizeBasic(s) {
  // very simple pluralization — good enough for common reagents
  if (s.endsWith("s")) return s;
  if (s.endsWith("y")) return s.slice(0, -1) + "ies";
  return s + "s";
}
function singularizeBasic(s) {
  if (s.endsWith("ies")) return s.slice(0, -3) + "y";
  if (s.endsWith("s")) return s.slice(0, -1);
  return s;
}

function reagentAliases(row) {
  const base = [row.name || "", row.key || ""];
  const extra = Array.isArray(row.aliases) ? row.aliases : [];
  const raw = [...base, ...extra]
    .map(normalizeName)
    .filter(Boolean);

  const withVariants = new Set();
  for (const a of raw) {
    withVariants.add(a);
    withVariants.add(pluralizeBasic(a));
    withVariants.add(singularizeBasic(a));
  }
  return [...withVariants];
}

function candidateReagentItems(actor) {
  const items = actor?.items ?? [];
  return items.filter(i => {
    if (i.type !== "consumable") return false;
    const ctype = foundry.utils.getProperty(i, "system.consumableType");
    return ["material", "trinket", "ammo", "misc"].includes(ctype) || ctype == null;
  });
}

function findReagentItemOnActor_Auto(actor, reagentRow) {
  if (!actor) return null;
  const aliases = reagentAliases(reagentRow);
  const aliasSet = new Set(aliases);
  const candidates = candidateReagentItems(actor);

  // exact alias match
  for (const it of candidates) {
    const nm = normalizeName(it.name);
    if (aliasSet.has(nm)) return it;
  }
  // optional loose match
  if (!NAME_MATCH_STRICT) {
    for (const it of candidates) {
      const nm = normalizeName(it.name);
      if (aliases.some(a => nm.includes(a))) return it;
    }
  }
  return null;
}

/** ----- Spell material parsing & row matching ----- **/

// Try to read the spell's material text across dnd5e variants
function getSpellMaterialText(item) {
  // dnd5e v13 commonly: system.materials.value, consumed, cost
  const m = item?.system?.materials ?? {};
  const legacy = item?.system?.material ?? {}; // older compat
  const text = m.value ?? legacy.value ?? legacy?.components ?? ""; // be liberal
  const consumed = !!(m.consumed ?? legacy.consumed ?? false);
  // cost can be in gp or other unit; treat >0 as costly component
  const cost = Number(m.cost ?? legacy.cost ?? 0) || 0;
  return { text: String(text || ""), consumed, cost };
}

// Given the material text, find the FIRST reagent row whose alias appears in it
function findRowFromMaterialText(table, materialText) {
  const norm = normalizeName(materialText);
  if (!norm) return null;

  const words = new Set(norm.split(/\s+/).filter(Boolean));

  for (const row of table) {
    const aliases = reagentAliases(row);

    // phrase match first (covers multi-word like "incense sticks")
    if (aliases.some(a => a.length > 1 && norm.includes(a))) return row;

    // token match (covers diamond/diamonds etc.)
    if (aliases.some(a => words.has(a))) return row;
  }
  return null;
}

// Decide if we should actually consume for this spell (single, final version)
function shouldConsumeForSpell(item) {
  const m = item?.system?.materials ?? {};
  const text = String(m.value ?? "");
  const gpInText = /worth\s+\d+\s*gp/i.test(text); // fallback when cost is only in the text
  return !!(m.consumed || (Number(m.cost) > 0) || gpInText);
}

function logMat(item, note = "") {
  const m = item?.system?.materials ?? {};
  console.log(
    `reagent-tracker | ${note} | item=${item?.name} consumed=${m.consumed} cost=${m.cost} text="${m.value ?? ""}"`
  );
}

/**
 * Try to consume a reagent item from the actor.
 * @param {Actor} actor
 * @param {object} reagentRow  - row from the reagent table
 * @param {number} amount      - how many to consume (default 1)
 * @returns {Promise<{ok:boolean, reason?:string, have?:number, item?:Item, left?:number}>}
 */
async function consumeReagent_Auto(actor, reagentRow, amount = 1) {
  const item = findReagentItemOnActor_Auto(actor, reagentRow);
  if (!item) {
    // Do not toast; let enforceReagents handle messaging
    return { ok: false, reason: "missing" };
  }

  const mode = reagentRow.consume?.mode ?? "quantity";
  const perCast = reagentRow.consume?.perCast ?? amount;

  if (mode === "quantity") {
    const q = foundry.utils.getProperty(item, "system.quantity") ?? 0;
    if (q < perCast) {
      return { ok: false, reason: "insufficient", have: q, item };
    }
    await item.update({ "system.quantity": q - perCast });
    return { ok: true, left: q - perCast, item };
  }

  if (mode === "uses") {
    const uses = foundry.utils.getProperty(item, "system.uses.value") ?? 0;
    if (uses < perCast) {
      return { ok: false, reason: "insufficient", have: uses, item };
    }
    await item.update({ "system.uses.value": uses - perCast });
    return { ok: true, left: uses - perCast, item };
  }

  ui.notifications.error(`Unknown consume mode: ${mode}`);
  return { ok: false, reason: "mode" };
}

/**
 * Validate/consume reagents for a spell. Works with Midi-QOL workflow or bare Item.
 * Returns { handled: boolean, cancel: boolean } to the caller.
 */
async function enforceReagents(workflowOrItem) {
  const item  = workflowOrItem?.item ?? workflowOrItem;   // Midi workflow or Item
  const actor = workflowOrItem?.actor ?? item?.actor ?? item?.parent;

  if (!item || item.type !== "spell") return { handled: false };

  if (!shouldConsumeForSpell(item)) {
    logMat(item, "skip (no costly/consumed mats)");
    return { handled: false };
  }

  const matText = String(item?.system?.materials?.value ?? "");
  if (!matText) {
    console.warn("reagent-tracker | no materials text on spell", item?.name);
    return { handled: false };
  }

  const api   = game.modules.get(MODULE_ID)?.api;
  const table = api?.getTable() ?? [];
  const row   = findRowFromMaterialText(table, matText);

  if (!row) {
    console.warn(`reagent-tracker | no reagent row matched for "${item.name}" from text: ${matText}`);
    return { handled: false };
  }

  const res = await api.consumeReagent(actor, row, 1);
  if (!res.ok) {
    // Prefer a chat message over system toasts
    if (typeof postReagentBlockChat === "function") {
      await postReagentBlockChat({
        actor,
        item,
        row,
        reason: res.reason ?? "missing",
        need: row?.consume?.perCast ?? 1,
        have: res.have ?? 0,
        gmOnly: false // set true if you want only the GM to see it
      });
    } else {
      // Fallback if helper isn't available
      const reagentName = row?.name ?? row?.key ?? "required reagent";
      const speaker = ChatMessage.getSpeaker({ actor });
      await ChatMessage.create({
        speaker,
        content: `⛔ <strong>${foundry.utils.escapeHTML(item.name)}</strong> was <span style="color:#b00;font-weight:600;">blocked</span> — missing <em>${foundry.utils.escapeHTML(reagentName)}</em>.`
      });
    }
    return { handled: true, cancel: true };
  }

  logMat(item, `OK (reagent ${row.name ?? row.key} ${row.consume?.perCast ? "consumed" : "checked"})`);
  return { handled: true, cancel: false };
}

function postReagentBlockChat({ actor, item, row, reason = "missing", need = 1, have = 0, gmOnly = false }) {
  const speaker = ChatMessage.getSpeaker({ actor });
  const reagentName = row?.name ?? row?.key ?? "required reagent";
  const parts = [];
  parts.push(`<strong>${foundry.utils.escapeHTML(item?.name ?? "Spell")}</strong> was <span style="color:#b00;font-weight:600;">blocked</span>`);
  if (actor?.name) parts.push(`for <strong>${foundry.utils.escapeHTML(actor.name)}</strong>`);
  parts.push(`— missing <em>${foundry.utils.escapeHTML(reagentName)}</em>`);
  if (row?.cost) parts.push(`(${row.cost} gp)`);
  if (reason === "insufficient") parts.push(` (need ${need}, have ${have})`);
  const content = `<div class="reagent-tracker-msg">⛔ ${parts.join(" ")}.</div>`;

  const data = { speaker, content };
  if (gmOnly) data.whisper = ChatMessage.getWhisperRecipients("GM").map(u => u.id);
  return ChatMessage.create(data);
}

