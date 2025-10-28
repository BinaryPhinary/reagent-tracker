// ============================================================================
// 🧭 reagent-intel.js — Actor Intelligence Cache (Phase 2) + Scene Awareness
// ============================================================================
"use strict";

const MODULE_ID = "reagent-tracker";

// ============================================================================
// 💎 Reagent Upgrade Intelligence
// ============================================================================

/** Safely extract gp value from an item (from system or name text). */
function _gpValueOfItem(it) {
  if (!it) return 0;
  const sys = it.system ?? {};
  const price = Number(sys.price?.valueInGP ?? sys.price?.value ?? sys.cost ?? 0);
  if (price > 0) return price;
  const m = String(it.name || "").match(/([\d,]+)\s*gp/i);
  if (m) return Number(String(m[1]).replace(/,/g, ""));
  return 0;
}

/** Compare if item belongs to the same reagent family as the need (base name or key). */
function _isSameReagentFamily(it, reagent) {
  if (!it || !reagent) return false;
  const itemKey = it.getFlag(MODULE_ID, "reagentKey")?.toLowerCase();
  const needKey = reagent.reagentKey?.toLowerCase();
  if (itemKey && needKey && itemKey.split("_")[0] === needKey.split("_")[0]) return true;

  const baseName = (reagent.reagentNameCached ?? reagent.name ?? "")
    .toLowerCase()
    .replace(/\s*\(\d[\d,\s]*gp\)\s*/i, "")
    .trim();
  return it.name.toLowerCase().includes(baseName);
}

/** Find the best upgraded reagent owned by the actor. */
export function findUpgradedReagentOnActor(actor, need) {
  if (!(actor instanceof Actor) || !need?.reagentKey) return null;

  const minCost = Number(need.minCost ?? need.gpValue ?? 0) || 0;
  let best = null;

  for (const it of actor.items?.contents ?? []) {
    if (!["loot", "consumable"].includes(it.type)) continue;
    const qty = Number(it.system?.quantity ?? 0);
    if (qty <= 0) continue;
    if (!_isSameReagentFamily(it, need)) continue;

    const val = _gpValueOfItem(it);
    if (val <= minCost) continue;

    if (!best || val > best.valueGP) best = { item: it, valueGP: val };
  }
  return best;
}


// ============================================================================
// 🧩 Reagent Intelligence Subsystem
// ============================================================================
const reagentIntel = {
  cache: new Map(),

  // ------------------------------------------------------------
  // Determine if an actor is a player-caster (no NPCs)
  // ------------------------------------------------------------
  isCaster(actor) {
    if (!(actor instanceof Actor)) return false;
    if (actor.type === "npc") return false; // 🧩 exclude NPCs entirely
    const spellItems = actor.items.filter(i => i.type === "spell");
    return spellItems.length > 0;
  },
  
/* -------------------------------------------------------------------------------------------------
 *  buildActorReagentState (v31e-async)
 *  - Async: allows compendium fallback using await
 * ------------------------------------------------------------------------------------------------- */
async buildActorReagentState(actor) {
  const TAG = `[${MODULE_ID}][buildActorReagentState:v31e-async]`;

  // --- Safety guards ------------------------------------------------------
  if (!(actor instanceof Actor)) {
    console.log(`${TAG} Skipped non-Actor input.`);
    return null;
  }
  if (actor.type !== "character") {
    console.log(`${TAG} Skipped ${actor.name} (type=${actor.type}).`);
    return null;
  }
  if (!actor.hasPlayerOwner && !actor.isOwner) {
    console.log(`${TAG} Skipped ${actor.name} (no player/GM ownership).`);
    return null;
  }

  console.log(`${TAG} Processing actor '${actor.name}' (id=${actor.id}).`);

  const spellMap = reagentTracker?.getSpellMap?.() ?? [];
  const out = {
    ts: Date.now(),
    id: actor.id,
    name: actor.name,
    spells: {},
    summary: { hasMissing: false, hasUpgrades: false, mappedCount: 0, totalSpells: 0 }
  };

  const spellItems = actor.items.filter(i => i.type === "spell");
  if (spellItems.length === 0) return null;
  out.summary.totalSpells = spellItems.length;

  // --- Build reagent index from inventory ---------------------------------
  const invKeys = new Map();
  for (const it of actor.items) {
    const flags = it.flags?.[MODULE_ID] ?? it.flags?.["reagent-tracker"] ?? {};
    const reagentKey = flags.reagentKey || null;

    // read from whichever field actually carries quantity
    const qty = Number(
      it.system?.quantity ??
      it.system?.uses?.value ??
      0
    );

    if (reagentKey && qty > 0) {
      const keyNorm = reagentKey.toLowerCase().replace(/\s+/g, "_");
      invKeys.set(keyNorm, (invKeys.get(keyNorm) ?? 0) + qty);
    }
  }


  // --- Build quick maps for faster SpellMap lookups -----------------------
  const mappedByUUID = new Map(spellMap.map(e => [e.spellUUID, e]));
  const mappedByName = new Map(spellMap.map(e => [e.spellNameCached?.toLowerCase(), e]));

  // --- Process each spell -------------------------------------------------
  for (const spell of spellItems) {
    const mapped =
      mappedByUUID.get(spell.uuid) ||
      mappedByName.get(spell.name.toLowerCase());
    if (!mapped) continue;

    const reagents = mapped.reagents ?? [];
    if (reagents.length === 0) continue;

    const need = reagents[0];
    const needKey = need?.reagentKey?.toLowerCase().replace(/\s+/g, "_");
    if (!needKey) continue;

    const needCost = Number(need?.minCost ?? 0) || 0;

    // 🧩 Determine 'consumed' flag — SpellMap first, Compendium fallback ----
    let consumed = null;
    if (typeof need?.consumed === "boolean") {
      consumed = need.consumed;
      console.log(`${TAG} SpellMap flag → ${spell.name} reagent ${need.reagentKey} consumed=${consumed}`);
    } else {
      // Fallback: read from compendium if SpellMap entry missing the flag
      try {
        const pack = game.packs.get("world.reagents");
        if (pack) {
          const index = await pack.getIndex({ fields: ["name", "flags"] });
          const hit = index.find(e =>
            (e.flags?.["reagent-tracker"]?.reagentKey ?? "")
              .toLowerCase() === needKey
          );
          if (hit) {
            consumed = hit.flags?.["reagent-tracker"]?.consumed ?? false;
            console.log(`${TAG} Compendium fallback → ${spell.name} reagent ${need.reagentKey} consumed=${consumed}`);
          }
        }
      } catch (err) {
        console.warn(`${TAG} Compendium lookup failed for ${need.reagentKey}`, err);
      }
    }

    // Default if still null
    if (consumed === null) consumed = false;

    const entry = {
      mapped: true,
      reagentKey: needKey,
      reagentType: need?.reagentType ?? null,
      spellName: spell.name,
      spellUUID: spell.uuid,
      hasExact: false,
      hasUpgrade: false,
      missing: false,
      upgrade: null,

    // 🟩 Final authoritative metadata
    consumed,
    isLootable: need?.isLootable ?? true,
    minCost: needCost,
    blockIfMissing: mapped.blockIfMissing ?? true
    };

    // --- Check for exact reagent -----------------------------------------
    const qty = invKeys.get(needKey) ?? 0;
    entry.hasExact = qty > 0;
    entry.quantity = qty; // ✅ reflects current actor inventory


    // --- Check for higher-value upgrade ----------------------------------
    if (!entry.hasExact && typeof findUpgradedReagentOnActor === "function") {
      const up = findUpgradedReagentOnActor(actor, need);
      if (up?.item) {
        entry.hasUpgrade = true;
        entry.upgrade = {
          itemId: up.item.id,
          itemName: up.item.name,
          reagentKey: up.item.flags?.[MODULE_ID]?.reagentKey ?? null,
          reagentType: up.item.flags?.[MODULE_ID]?.reagentType ?? null,
          valueGP: up.valueGP ?? null
        };
      }
    }

    // --- Compute missing flag after evaluating upgrade -------------------
    entry.missing = !entry.hasExact && !entry.hasUpgrade;

    out.spells[spell.id] = entry;
  }

  // --- Skip if no reagent-mapped spells ----------------------------------
  if (Object.keys(out.spells).length === 0) return null;

  // --- Compute summaries -------------------------------------------------
  const all = Object.values(out.spells);
  out.summary = {
    hasMissing: all.some(s => s.missing),
    hasUpgrades: all.some(s => s.hasUpgrade),
    mappedCount: all.length,
    totalSpells: spellItems.length
    
  };

  out.bypassEnforcement = game.settings.get("reagent-tracker", "autoConsumeOnCast") === false;



  // --- Cache + Log -------------------------------------------------------
  this.cache.set(actor.id, out);
  console.log(`${TAG} ${actor.name} → tracked ${all.length} reagent-linked spell(s).`);
  return out;
},


// ------------------------------------------------------------
// Rebuild for all relevant casters (player, GM, or scene actors)
// ------------------------------------------------------------
rebuildAllCasters() {
  const TAG = `[${MODULE_ID}][rebuildAllCasters:v31e+]`;
  console.log(`${TAG} rebuilding reagent intel cache...`);

  this.cache.clear();

  // Collect scene actors (for GM safety + visibility)
  const sceneActors = new Set(
    (canvas.scene?.tokens ?? [])
      .map(t => t.actor)
      .filter(a => !!a)
      .map(a => a.id)
  );

  // Collect all character-type actors that are relevant
  const actors = game.actors.contents.filter(a =>
    a.type === "character" &&
    (a.hasPlayerOwner || a.isOwner || game.user.isGM || sceneActors.has(a.id))
  );

  if (!actors.length) {
    console.warn(`${TAG} no eligible actors found (none match ownership or scene criteria).`);
    return;
  }

  // Async rebuild for each
  for (const actor of actors) {
    try {
      this.buildActorReagentState(actor);
    } catch (err) {
      console.warn(`${TAG} failed to rebuild ${actor.name}`, err);
    }
  }

  console.log(`${TAG} cache rebuild triggered for ${actors.length} actor(s).`);
},

// ------------------------------------------------------------
// Lazy access — rebuild if stale or missing
// ------------------------------------------------------------
ensureReagentState(actor) {
  if (actor?.type === "npc") return null;
  const cur = this.cache.get(actor.id);
  if (!cur) return this.buildActorReagentState(actor);
  const age = Date.now() - cur.ts;
  if (age > 60_000) return this.buildActorReagentState(actor); // 1 min stale
  return cur;
},

// ------------------------------------------------------------
// Invalidate (e.g., inventory/spell update)
// ------------------------------------------------------------
invalidateReagentState(actor) {
  if (actor?.type === "npc") return;
  this.cache.delete(actor.id);
}
};

// ============================================================================
// 🌍 Scene awareness + dynamic listeners (players only)
// ============================================================================
const activeSceneActors = new Set();

function initializeSceneCasters() {
  if (!canvas?.scene) return;
  activeSceneActors.clear();

  const tokens = canvas.scene.tokens.contents ?? [];
  for (const token of tokens) {
    const actor = token.actor;
    if (!actor || actor.type === "npc") continue;

    activeSceneActors.add(actor.id);
    const state = reagentIntel.ensureReagentState(actor);
    if (state?.isCaster) console.log(`[${MODULE_ID}] Scene init → cached caster: ${actor.name}`);
  }

  console.log(`[${MODULE_ID}] initializeSceneCasters → ${activeSceneActors.size} player actor(s) on scene.`);
  Hooks.callAll("reagent-tracker.spellMapReady", reagentTracker.reagentIntel.spellMap);

}

function onTokenCreate(tokenDoc) {
  const actor = tokenDoc.actor;
  if (!actor || actor.type === "npc" || activeSceneActors.has(actor.id)) return;

  activeSceneActors.add(actor.id);
  const state = reagentIntel.ensureReagentState(actor);
  if (state?.isCaster) console.log(`[${MODULE_ID}] Token added → caster joined scene: ${actor.name}`);
}

function onTokenDelete(tokenDoc) {
  const actor = tokenDoc.actor;
  if (!actor) return;
  activeSceneActors.delete(actor.id);
  console.log(`[${MODULE_ID}] Token removed → ${actor.name} left scene.`);
}

// Hooks for scene activity
Hooks.on("canvasReady", () => setTimeout(initializeSceneCasters, 1000)); // ⏳ small delay on load
Hooks.on("createToken", onTokenCreate);
Hooks.on("deleteToken", onTokenDelete);
Hooks.on("updateScene", (scene, diff) => {
  if (diff.active) setTimeout(initializeSceneCasters, 1000);
});


// ============================================================================
// 🧪 Developer Diagnostic Helpers
// ============================================================================
reagentIntel.debugTable = function () {
  const rows = [];

  for (const state of this.cache.values()) {
    // --- Safety: ignore malformed or NPC entries ---
    if (!state?.name || !state?.summary) continue;

    // --- Optional field retained for GM-only diagnostic context ---
    const isCaster = state.isCaster ?? (Object.keys(state.spells ?? {}).length > 0);
    if (!isCaster) continue;

    // --- Build display row ---
    rows.push({
      Actor: state.name,
      Missing: state.summary.hasMissing ? "❌" : "✅",
      Upgrades: state.summary.hasUpgrades ? "⬆️" : "",
      Mapped: state.summary.mappedCount ?? 0,
      TotalSpells: state.summary.totalSpells ?? 0,
      LastUpdated: new Date(state.ts).toLocaleTimeString(),
    });
  }

  // --- Sort alphabetically for predictable debug output ---
  rows.sort((a, b) => a.Actor.localeCompare(b.Actor));

  console.table(rows);
  console.log(
    `[${MODULE_ID}] reagentIntel → ${rows.length} tracked player caster(s) in cache.`
  );
};


// ------------------------------------------------------------
// 🧪 Developer Helper — List all *active* casters (on map or in party)
// ------------------------------------------------------------
reagentIntel.listCasters = function ({ forceRebuild = true } = {}) {
  // 1️⃣ Optionally rebuild to ensure cache freshness
  if (forceRebuild && typeof this.rebuildAllCasters === "function") {
    this.rebuildAllCasters();
  }

  // 2️⃣ Gather actors that are on the current scene or owned by players
  const sceneActors = new Set(
    (canvas.scene?.tokens ?? [])
      .map(t => t.actor)
      .filter(a => !!a)
      .map(a => a.id)
  );

  const ownedActors = new Set(
    game.actors.contents
      .filter(a => a.isOwner && a.hasPlayerOwner)
      .map(a => a.id)
  );

  // Merge both sets → “active” actor IDs
  const activeIds = new Set([...sceneActors, ...ownedActors]);

  // 3️⃣ Build output rows for actors in cache matching criteria
  const rows = [];

  for (const [id, state] of this.cache.entries()) {
    if (!state) continue;

    // Defensive check for new schema fields
    const spells = state.spells ?? {};
    const summary = state.summary ?? {};
    const isCaster = (state.isCaster ?? (Object.keys(spells).length > 0)) || false;

    if (!isCaster) continue;
    if (!activeIds.has(id)) continue;

    const actor = game.actors.get(id);
    if (!actor) continue;

    rows.push({
      Actor: actor.name,
      Mapped: summary.mappedCount ?? Object.keys(spells).length ?? 0,
      Missing: summary.hasMissing ? "❌" : "✅",
      Upgrades: summary.hasUpgrades ? "⬆️" : "",
      TotalSpells: summary.totalSpells ?? Object.keys(spells).length ?? 0,
      LastUpdated: new Date(state.ts).toLocaleTimeString(),
    });
  }

  // 4️⃣ Sort alphabetically for predictable debug output
  rows.sort((a, b) => a.Actor.localeCompare(b.Actor));

  // 5️⃣ Display in console
  console.table(rows);
  console.log(
    `[${MODULE_ID}] reagentIntel → ${rows.length} active caster(s) (party or on scene).`
  );

  return rows;
};


// ------------------------------------------------------------
// 🧪 Developer Helper — Inspect one actor's reagent intel
// ------------------------------------------------------------
reagentIntel.inspectActor = function (nameOrId) {
  // --- 1️⃣ Resolve actor by ID or name ---
  const actor =
    game.actors.get(nameOrId) ??
    game.actors.getName(nameOrId) ??
    null;

  if (!actor) {
    console.warn(`[${MODULE_ID}] reagentIntel.inspectActor: actor not found → ${nameOrId}`);
    return;
  }

  // --- 2️⃣ Ensure reagent state exists ---
  const state = this.ensureReagentState(actor);
  if (!state || !state.spells) {
    console.warn(`[${MODULE_ID}] reagentIntel.inspectActor: no reagent intel for ${actor.name}`);
    return;
  }

  const spells = state.spells ?? {};
  const summary = state.summary ?? {};
  const rows = [];

  // --- 3️⃣ Build rows from updated schema ---
  for (const [id, s] of Object.entries(spells)) {
    const reagentKey = s.reagentKey ?? "(none)";
    const reagentType = s.reagentType ?? "";
    const upgrade = s.upgrade ?? {};

    rows.push({
      Spell: s.spellName ?? "(unnamed spell)",
      ReagentKey: reagentKey,
      Type: reagentType,
      HasExact: s.hasExact ? "✅" : "",
      HasUpgrade: s.hasUpgrade ? "⬆️" : "",
      UpgradeItem: upgrade.itemName ?? "",
      UpgradeValueGP: upgrade.valueGP ?? "",
      Missing: s.missing ? "❌" : "",
    });
  }

  // --- 4️⃣ Sort alphabetically by spell name for clarity ---
  rows.sort((a, b) => a.Spell.localeCompare(b.Spell));

  // --- 5️⃣ Display nicely formatted diagnostic output ---
  console.groupCollapsed(
    `%c[${MODULE_ID}] ${actor.name} → ${rows.length} reagent-tracked spell(s)`,
    "color: #00b5ad; font-weight: bold;"
  );
  console.table(rows);
  console.groupEnd();

  console.log(
    `[${MODULE_ID}] Summary for ${actor.name}: Missing=${summary.hasMissing ? "❌" : "✅"}, Upgrades=${summary.hasUpgrades ? "⬆️" : "✅"}, Total=${summary.mappedCount ?? rows.length}`
  );

  return rows;
};
// ------------------------------------------------------------
// 🧪 Developer Helper — Compare reagent keys (Inventory vs Compendium vs SpellMap)
// ------------------------------------------------------------
reagentIntel.compareReagentKeys = async function (nameOrId) {
  // --- 1️⃣ Resolve actor by ID or name ---
  const actor =
    game.actors.get(nameOrId) ??
    game.actors.getName(nameOrId) ??
    null;

  if (!actor) {
    console.warn(`[${MODULE_ID}] reagentIntel.compareReagentKeys: actor not found → ${nameOrId}`);
    return;
  }

  // --- 2️⃣ Load compendium reagents using new flag schema ---
  const pack = game.packs.get("world.reagents");
  const compendiumKeys = new Map();

  if (pack) {
    try {
      const docs = await pack.getDocuments();
      for (const d of docs) {
        const flags = d.flags?.[MODULE_ID] ?? d.flags?.["reagent-tracker"] ?? {};
        const reagentKey = flags.reagentKey?.toLowerCase().replace(/\s+/g, "_");
        if (reagentKey) compendiumKeys.set(reagentKey, d.name);
      }
    } catch (e) {
      console.warn(`[${MODULE_ID}] reagentIntel.compareReagentKeys: failed to read world.reagents`, e);
    }
  }

  // --- 3️⃣ Load spell map reagent keys (already structured JSON) ---
  const spellMap = game.settings.get(MODULE_ID, "spellReagentMap") ?? [];
  const spellKeys = new Map();

  for (const row of spellMap) {
    if (!row?.reagents?.length) continue;
    for (const r of row.reagents) {
      const rKey = r?.reagentKey?.toLowerCase().replace(/\s+/g, "_");
      if (rKey) spellKeys.set(rKey, row.spellNameCached);
    }
  }

  // --- 4️⃣ Compare actor inventory reagents ---
  const rows = [];

  for (const it of actor.items.contents) {
    if (!["loot", "consumable"].includes(it.type)) continue;

    const flags = it.flags?.[MODULE_ID] ?? it.flags?.["reagent-tracker"] ?? {};
    const reagentKey = flags.reagentKey?.toLowerCase().replace(/\s+/g, "_") ?? null;
    const reagentType = flags.reagentType ?? it.type ?? "(unknown)";
    const src = it._stats?.compendiumSource ?? "";
    const inCompendium = reagentKey && compendiumKeys.has(reagentKey);
    const inSpellMap = reagentKey && spellKeys.has(reagentKey);

    rows.push({
      Item: it.name,
      ReagentKey: reagentKey ?? "(none)",
      Type: reagentType,
      InCompendium: inCompendium ? "✅" : "❌",
      InSpellMap: inSpellMap ? "✅" : "❌",
      CompendiumName: inCompendium ? compendiumKeys.get(reagentKey) : "",
      LinkedSpell: inSpellMap ? spellKeys.get(reagentKey) : "",
      Source: src || "(manual/world)",
    });
  }

  // --- 5️⃣ Sort and display diagnostics ---
  rows.sort((a, b) => a.Item.localeCompare(b.Item));
  console.groupCollapsed(
    `%c[${MODULE_ID}] ${actor.name} → ${rows.length} reagent items compared`,
    "color: #ff9800; font-weight: bold;"
  );
  console.table(rows);
  console.groupEnd();

  console.log(
    `[${MODULE_ID}] ${actor.name} → ${rows.length} inventory items checked against compendium + spell map.`
  );

  return rows;
};


// ============================================================================
// 🔌 Expose globally once ready
// ============================================================================
Hooks.once("ready", () => {
  if (!globalThis.reagentTracker) globalThis.reagentTracker = {};
  globalThis.reagentTracker.reagentIntel = reagentIntel;
  globalThis.reagentTracker.activeSceneActors = activeSceneActors;
  console.log(`[${MODULE_ID}] reagentIntel subsystem initialized (player-only, scene-aware).`);
});


// ============================================================================
// 🔄 Refresh triggers (v13-compatible) — guarded to skip mid-cast rebuilds
// ============================================================================

Hooks.on("updateActor", (actor, diff) => {
  if (actor?.type === "npc") return;

  // 🛡️ Skip intel rebuilds while this actor is mid-cast
  if (globalThis.reagentTracker?._castingActors?.has(actor.id)) {
    console.log(`[${MODULE_ID}] [updateActor] Skip rebuild for '${actor.name}' (casting in progress)`);
    return;
  }

  if (diff?.system?.spells || diff?.items) {
    reagentIntel.invalidateReagentState(actor);
    reagentIntel.buildActorReagentState(actor);
  }
});

Hooks.on("createItem", async (item) => {
  const actor = item?.parent;
  if (!(actor instanceof Actor) || actor.type === "npc") return;
  if (globalThis.reagentTracker?._castingActors?.has(actor.id)) return;

  try {
    const backfill = globalThis.reagentTracker?._rtBackfillReagentKeyFromCompSource;
    if (typeof backfill === "function") {
      const res = await backfill(item);
      if (res) console.log(`[${MODULE_ID}] [createItem] Backfilled reagentKey for '${item.name}'`);
    } else {
      console.warn(`[${MODULE_ID}] [createItem] Backfill function not yet available`);
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] [createItem] Backfill error for '${item.name}':`, err);
  }

  reagentIntel.invalidateReagentState(actor);
  reagentIntel.buildActorReagentState(actor);
});


// 🟡 Item Updated (quantity / uses / flag changes)
Hooks.on("updateItem", (item, diff) => {
  const actor = item?.parent;
  if (!(actor instanceof Actor) || actor.type === "npc") return;
  if (globalThis.reagentTracker?._castingActors?.has(actor.id)) return;

  const hasQtyChange =
    foundry.utils.hasProperty(diff, "system.quantity") ||
    foundry.utils.hasProperty(diff, "system.uses.value");

  if (!hasQtyChange) return;

  setTimeout(async () => {
    console.log(`[${MODULE_ID}] [updateItem] '${item.name}' qty/uses changed → rebuilding cache for ${actor.name}`);
    reagentIntel.invalidateReagentState(actor);
    await reagentIntel.buildActorReagentState(actor);
  }, 50);
});

// 🔴 Item Deleted
Hooks.on("deleteItem", (item) => {
  const actor = item?.parent;
  if (!(actor instanceof Actor) || actor.type === "npc") return;
  if (globalThis.reagentTracker?._castingActors?.has(actor.id)) return;

  console.log(`[${MODULE_ID}] [deleteItem] '${item.name}' removed → rebuilding cache for ${actor.name}`);
  reagentIntel.invalidateReagentState(actor);
  reagentIntel.buildActorReagentState(actor);
});


// -- v31e this should update the inventories of actors if the spellmap data changes
Hooks.on("reagent-tracker.spellMapUpdated", async () => {
  const TAG = `[${MODULE_ID}][spellMapUpdatedHook:v31e]`;
  console.log(`${TAG} triggered → rebuilding reagent intel for all casters.`);
  try {
    await reagentTracker.reagentIntel.rebuildAllCasters();
    console.log(`${TAG} cache rebuilt successfully (${reagentTracker.reagentIntel.cache.size} actor(s)).`);
  } catch (err) {
    console.error(`${TAG} failed to rebuild cache:`, err);
  }
});

Hooks.on("reagent-tracker.spellMapUpdated", async (map) => {
  const TAG = `[${MODULE_ID}][spellMapBackup:v32c]`;
  try {
    // Safely resolve stored value from world scope
    const store = game.settings.storage?.get("world");
    const setting = store?.getItem
      ? JSON.parse(store.getItem(`${MODULE_ID}.autoConsumeOnCast`) ?? "true")
      : game.settings.get(MODULE_ID, "autoConsumeOnCast");

    if (!setting) {
      console.log(`${TAG} skipped — AutoConsume disabled (world value).`);
      return;
    }

    const backupFn =
      globalThis.reagentTracker?.backupSpellMap ??
      game.modules.get(MODULE_ID)?.api?.backupSpellMap ??
      globalThis.backupSpellMap;

    if (typeof backupFn !== "function") {
      console.warn(`${TAG} skipped — no backup function exposed.`);
      return;
    }

    const payload = Array.isArray(map) && map.length ? map : SpellMapData.getMap();
    console.log(`${TAG} running backup after Spell Map update...`);
    await backupFn(payload);
    console.log(`${TAG} backup complete.`);
  } catch (err) {
    console.error(`${TAG} backup failed:`, err);
  }
});


// Do a refresh of the cache on a long rest v31j
Hooks.on("dnd5e.restCompleted", async (actor, data, options) => {
  if (!(actor instanceof Actor) || actor.type === "npc") return;

  // 🛡️ Avoid conflicts if mid-cast
  if (globalThis.reagentTracker?._castingActors?.has(actor.id)) {
    console.log(`[${MODULE_ID}] [restCompleted] Skip rebuild for '${actor.name}' (casting in progress)`);
    return;
  }

  console.log(`[${MODULE_ID}] [restCompleted] Rebuilding reagent cache for '${actor.name}' after rest`);
  reagentIntel.invalidateReagentState(actor);
  await reagentIntel.buildActorReagentState(actor);
});


Hooks.once("midi-qol.preItemRollV2", async (wrapper) => {
  const wf = wrapper?.workflow ?? wrapper;
  if (!wf?.item) {
    console.warn("[reagent-tracker] DEBUG: No item on workflow!", wf);
    return;
  }

  console.log("=== SPELL DEBUG ===");
  console.log("Actor:", wf.actor?.name);
  console.log("Name:", wf.item.name);
  console.log("ID:", wf.item.id);
  console.log("UUID:", wf.item.uuid);
  console.log("CompSource:", wf.item._stats?.compendiumSource);
  console.log("Flags:", wf.item.flags);
});

