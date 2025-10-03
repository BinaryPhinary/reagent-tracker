const MODULE_ID = "reagent-tracker";

/** ----- Settings (single table) ----- **/
function registerSettings() {
    game.settings.register(MODULE_ID, "reagentTable", {
        name: "Reagent Table",
        hint: "World storage for the reagent table.",
        scope: "world",
        config: false,
        type: Object,
        default: [] // Array<ReagentRow>
    });

    // Settings menu for GM to open the editor
    game.settings.registerMenu(MODULE_ID, "openEditor", {
        name: "Open Reagent Table",
        label: "Open Reagent Table",
        icon: "fas fa-flask",
        type: ReagentEditor,
        restricted: true
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
        return { tableJson: JSON.stringify(table, null, 2) };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html.find("button.close").on("click", () => this.close());
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
    }

    async _updateObject(_event, formData) {
        let rows;
        try {
            rows = JSON.parse(formData.table);
            if (!Array.isArray(rows)) throw new Error("JSON must be an array.");
            // Minimal validation: enforce unique "key" if present
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

// ---------- Zero-tag reagent resolution by name/type ----------
function normalizeName(s) {
    return String(s ?? "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

// Toggle strict matching if you want later (or expose as a module setting)
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

/** ----- Hooks ----- **/
Hooks.once("init", () => registerSettings());

Hooks.once("ready", () => {
    if (game.user.isGM) {
        console.log(`${MODULE_ID} | Ready. Open via Settings → Module Settings → Reagent Tracker → Open Reagent Table`);
    }

    // Be safe: ensure the module record exists
    const mod = game.modules.get(MODULE_ID) || game.modules.get("reagent-tracker");
    if (!mod) {
        console.error("reagent-tracker | Could not find module record to attach API.");
        return;
    }

    mod.api = {
        getTable: () => game.settings.get(MODULE_ID, "reagentTable") ?? [],
        findReagentItemOnActor: findReagentItemOnActor_Auto,
        consumeReagent: consumeReagent_Auto
    };
});


