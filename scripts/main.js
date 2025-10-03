// --- Reagent Tracker (v13) ---
const MODULE_ID = "reagent-tracker";

/** ----- Hooks ----- **/
Hooks.once("init", () => {
    console.log(`${MODULE_ID} | init hook firing`);
    registerSettings();
});

/** ----- Hook registration (Midi-QOL or core dnd5e) ----- **/
function registerSpellHooks() {
  const preferMidi = game.settings.get(MODULE_ID, "preferMidi");
  const midiActive = !!game.modules.get("midi-qol")?.active;

  if (preferMidi && midiActive) {
    console.log(`${MODULE_ID} | Using Midi-QOL hooks`);
    Hooks.on("midi-qol.preItemRoll", async (workflow) => {
      const item = workflow?.item;
      if (!item || item.type !== "spell") return;
      if (!shouldConsumeForSpell(item)) return;  // don't touch free/non-consumed components

      const mat = getSpellMaterialText(item).text;
      if (!mat) return;

      const api = game.modules.get(MODULE_ID)?.api;
      const table = api?.getTable() ?? [];
      const row = findRowFromMaterialText(table, mat);
      if (!row) return;

      const res = await api.consumeReagent(item.actor, row, 1);
      if (!res.ok) {
        ui.notifications.warn(`${item.name}: missing/insufficient reagent (${row.name ?? row.key}).`);
        // Cancel the cast if reagent is required
        return false;
      }
    });
    return;
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
}

Hooks.once("ready", () => {
    console.log(`${MODULE_ID} | ready hook firing`);

    if (game.user.isGM) {
        console.log(`${MODULE_ID} | Ready. Open via Settings → Module Settings → Reagent Tracker → Open Reagent Table`);
    }

    const mod = game.modules.get(MODULE_ID);
    if (!mod) {
        console.error(`${MODULE_ID} | Could not find module record to attach API.`);
        return;
    }

    mod.api = {
        getTable: () => game.settings.get(MODULE_ID, "reagentTable") ?? [],
        findReagentItemOnActor: findReagentItemOnActor_Auto,
        consumeReagent: consumeReagent_Auto
    };

    registerSpellHooks();

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
        return duplicate(rows);
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

function reagentAliases(row) {
    const base = [row.name || "", row.key || ""];
    const extra = Array.isArray(row.aliases) ? row.aliases : [];
    const set = new Set([...base, ...extra].map(normalizeName).filter(Boolean));
    return [...set];
}

function candidateReagentItems(actor) {
    const items = actor?.items ?? [];
    return items.filter(i => {
        if (i.type !== "consumable") return false;
        const ctype = getProperty(i, "system.consumableType");
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
  for (const row of table) {
    const aliases = reagentAliases(row); // from your zero-tag helpers
    if (aliases.some(a => norm.includes(a))) return row;
  }
  return null;
}

// Decide if we should actually consume for this spell
function shouldConsumeForSpell(item) {
  const { consumed, cost } = getSpellMaterialText(item);
  // Typical rule of thumb: consume if the spell says it's consumed OR has a non-zero cost
  return consumed || cost > 0;
}


async function consumeReagent_Auto(actor, reagentRow, amount = 1) {
    const item = findReagentItemOnActor_Auto(actor, reagentRow);
    if (!item) {
        ui.notifications.warn(`${actor?.name ?? "Actor"}: Missing reagent "${reagentRow.name ?? reagentRow.key}".`);
        return { ok: false, reason: "missing" };
    }

    const mode = reagentRow.consume?.mode ?? "quantity";
    const perCast = reagentRow.consume?.perCast ?? amount;

    if (mode === "quantity") {
        const q = getProperty(item, "system.quantity") ?? 0;
        if (q < perCast) {
            ui.notifications.warn(`${actor.name}: Not enough ${item.name} (need ${perCast}, have ${q}).`);
            return { ok: false, reason: "insufficient", have: q, item };
        }
        await item.update({ "system.quantity": q - perCast });
        return { ok: true, left: q - perCast, item };
    }

    if (mode === "uses") {
        const uses = getProperty(item, "system.uses.value") ?? 0;
        if (uses < perCast) {
            ui.notifications.warn(`${actor.name}: Not enough uses of ${item.name} (need ${perCast}, have ${uses}).`);
            return { ok: false, reason: "insufficient", have: uses, item };
        }
        await item.update({ "system.uses.value": uses - perCast });
        return { ok: true, left: uses - perCast, item };
    }

    ui.notifications.error(`Unknown consume mode: ${mode}`);
    return { ok: false, reason: "mode" };
}
