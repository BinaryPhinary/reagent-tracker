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

  // ------------------------------------------------------------
  // Build state for a single actor — Spell Map is the only source of truth
  // ------------------------------------------------------------
  buildActorReagentState(actor) {
  // --- Safety: only process valid player-controlled characters ---
  if (!(actor instanceof Actor)) {
    console.log(`[${MODULE_ID}] Skipped non-Actor input.`);
    return null;
  }
  if (actor.type !== "character") {
    console.log(`[${MODULE_ID}] Skipped ${actor.name} (type=${actor.type}).`);
    return null;
  }
  if (!actor.hasPlayerOwner && !actor.isOwner) {
    console.log(`[${MODULE_ID}] Skipped ${actor.name} (no player/GM ownership).`);
    return null;
  }

  console.log(
    `[${MODULE_ID}] buildActorReagentState → processing actor '${actor.name}' (id=${actor.id}).`
  );


  const spellMap = reagentTracker?.getSpellMap?.() ?? [];
  const out = {
    ts: Date.now(),
    id: actor.id,
    name: actor.name,
    spells: {},
    summary: { hasMissing: false, hasUpgrades: false, mappedCount: 0, totalSpells: 0 }
  };

  // --- Actor must have at least one spell to continue ---
  const spellItems = actor.items.filter(i => i.type === "spell");
  if (spellItems.length === 0) return null;
  out.summary.totalSpells = spellItems.length;

  // --- Build reagent index from inventory ---
  const invKeys = new Map();
  for (const it of actor.items) {
    const key = it.getFlag(MODULE_ID, "reagentKey");
    const qty = Number(it.system?.quantity ?? 0);
    if (key && qty > 0) invKeys.set(key, (invKeys.get(key) ?? 0) + qty);
  }

  // --- Build lookup of spell mappings (by UUID first, then fallback by name)
  const mappedByUUID = new Map(spellMap.map(e => [e.spellUUID, e]));
  const mappedByName = new Map(spellMap.map(e => [e.spellNameCached?.toLowerCase(), e]));

  // --- Iterate through all actor spells that are explicitly mapped
  for (const spell of spellItems) {
    const mapped = mappedByUUID.get(spell.uuid) || mappedByName.get(spell.name.toLowerCase());
    if (!mapped) continue;

    const reagents = mapped.reagents ?? [];
    if (reagents.length === 0) continue;

    const need = reagents[0];
    const needKey = need?.reagentKey;
    if (!needKey) continue;

    const needCost = Number(need?.minCost ?? 0) || 0;
    const entry = {
      mapped: true,
      reagentKey: needKey,
      spellName: spell.name,
      spellUUID: spell.uuid,
      hasExact: false,
      hasUpgrade: false,
      missing: false,
      upgrade: null
    };

    // --- Check for exact reagent
    const qty = invKeys.get(needKey) ?? 0;
    entry.hasExact = qty > 0;

    // --- Check for higher-value reagent upgrade
    if (!entry.hasExact && typeof findUpgradedReagentOnActor === "function") {
      const up = findUpgradedReagentOnActor(actor, need);
      if (up?.item) {
        entry.hasUpgrade = true;
        entry.upgrade = {
          itemId: up.item.id,
          itemName: up.item.name,
          valueGP: up.valueGP ?? null
        };
      }
    }

    entry.missing = !entry.hasExact && !entry.hasUpgrade;
    out.spells[spell.id] = entry;
  }

  // --- Skip actors with no reagent-mapped spells
  if (Object.keys(out.spells).length === 0) return null;

  // --- Compute summaries
  const all = Object.values(out.spells);
  out.summary = {
    hasMissing: all.some(s => s.missing),
    hasUpgrades: all.some(s => s.hasUpgrade),
    mappedCount: all.length,
    totalSpells: out.summary.totalSpells
  };

  this.cache.set(actor.id, out);
  console.log(`[${MODULE_ID}] ${actor.name} → tracked ${all.length} reagent-linked spell(s).`);
  return out;
},



  // ------------------------------------------------------------
  // Rebuild for all player casters in world
  // ------------------------------------------------------------
  rebuildAllCasters() {
    this.cache.clear();
    const actors = game.actors.contents ?? [];
    for (const a of actors) {
      if (a.type !== "character") continue;
      if (!a.hasPlayerOwner) continue;
      this.buildActorReagentState(a)     
    }
    console.log(`[${MODULE_ID}] reagentIntel → cache built for ${this.cache.size} player caster(s).`);
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
    if (!state.isCaster) continue;
    rows.push({
      Actor: state.name,
      Missing: state.summary.hasMissing ? "❌" : "✅",
      Upgrades: state.summary.hasUpgrades ? "⬆️" : "",
      Mapped: state.summary.mappedCount,
      TotalSpells: state.summary.totalSpells
    });
  }
  console.table(rows.sort((a, b) => a.Actor.localeCompare(b.Actor)));
  console.log(`[${MODULE_ID}] reagentIntel → ${rows.length} player caster(s) in cache.`);
};


// ------------------------------------------------------------
//  Developer helper: list all *active* casters (on map or in party)
// ------------------------------------------------------------
reagentIntel.listCasters = function () {
  // Always rebuild to ensure freshness
  this.rebuildAllCasters();

  // 1️⃣ Gather actors that are either on the current scene or owned by a player
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

  // 2️⃣ Build rows for actors in cache that match this criteria
  const rows = [];
  for (const [id, state] of this.cache.entries()) {
    if (!state.isCaster) continue;
    if (!activeIds.has(id)) continue;

    const actor = game.actors.get(id);
    if (!actor) continue;

    rows.push({
      Actor: actor.name,
      SpellsTracked: state.summary.mappedCount,
      Missing: state.summary.hasMissing ? "❌" : "",
      Upgrades: state.summary.hasUpgrades ? "⬆️" : "",
      TotalSpells: state.summary.totalSpells ?? Object.keys(state.spells).length
    });
  }

  console.table(rows);
  console.log(`[${MODULE_ID}] Found ${rows.length} active caster(s) (in party or on scene).`);
  return rows;
};


// ------------------------------------------------------------
//  Developer helper: inspect one actor's reagent intel
// ------------------------------------------------------------
reagentIntel.inspectActor = function (nameOrId) {
  const actor =
    game.actors.get(nameOrId) ??
    game.actors.getName(nameOrId) ??
    null;

  if (!actor) {
    console.warn(`[${MODULE_ID}] reagentIntel.inspectActor: actor not found → ${nameOrId}`);
    return;
  }

  const state = this.ensureReagentState(actor);
  if (!state || !state.spells) {
    console.warn(`[${MODULE_ID}] reagentIntel.inspectActor: no reagent intel for ${actor.name}`);
    return;
  }

  const rows = Object.entries(state.spells).map(([id, s]) => ({
    Spell: s.name,
    ReagentKey: s.reagentKey || "(none)",
    HasExact: s.hasExact ? "✅" : "",
    HasUpgrade: s.hasUpgrade ? "⬆️" : "",
    Missing: s.missing ? "❌" : ""
  }));

  console.table(rows);
  console.log(
    `[${MODULE_ID}] ${actor.name} → ${rows.length} spells | Missing=${state.summary.hasMissing ? "✅" : "❌"}, Upgrades=${state.summary.hasUpgrades ? "✅" : "❌"}`
  );

  return rows;
};

// ------------------------------------------------------------
//  Developer helper: compare reagent keys (Inventory vs Compendium vs SpellMap)
// ------------------------------------------------------------
reagentIntel.compareReagentKeys = async function (nameOrId) {
  const actor =
    game.actors.get(nameOrId) ??
    game.actors.getName(nameOrId) ??
    null;

  if (!actor) {
    console.warn(`[${MODULE_ID}] reagentIntel.compareReagentKeys: actor not found → ${nameOrId}`);
    return;
  }

  const pack = game.packs.get("world.reagents");
  let compendiumKeys = new Map();

  if (pack) {
    try {
      const docs = await pack.getDocuments();
      for (const d of docs) {
        const key = d.getFlag(MODULE_ID, "key");
        if (key) compendiumKeys.set(key, d.name);
      }
    } catch (e) {
      console.warn(`[${MODULE_ID}] reagentIntel.compareReagentKeys: failed to read world.reagents`, e);
    }
  }

  const spellMap = game.settings.get(MODULE_ID, "spellReagentMap") ?? [];
  const spellKeys = new Map();
  for (const row of spellMap) {
    if (row.reagents?.length) {
      for (const r of row.reagents) {
        if (r.reagentKey) spellKeys.set(r.reagentKey, row.spellNameCached);
      }
    }
  }

  const rows = [];

  for (const it of actor.items.contents) {
    if (!["loot", "consumable"].includes(it.type)) continue;
    const key = it.getFlag(MODULE_ID, "reagentKey");
    const src = it._stats?.compendiumSource ?? "";
    const inComp = key && compendiumKeys.has(key);
    const inMap = key && spellKeys.has(key);

    rows.push({
      Item: it.name,
      Key: key ?? "(none)",
      InCompendium: inComp ? "✅" : "❌",
      InSpellMap: inMap ? "✅" : "❌",
      Source: src || "(manual/world)"
    });
  }

  console.table(rows);
  console.log(
    `[${MODULE_ID}] ${actor.name} → ${rows.length} inventory items compared against compendium + spell map.`
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
// 🔄 Refresh triggers (unchanged)
// ============================================================================
Hooks.on("updateActor", (actor, diff) => {
  if (actor?.type === "npc") return;
  if (diff?.system?.spells || diff?.items) {
    reagentIntel.invalidateReagentState(actor);
    reagentIntel.buildActorReagentState(actor);
  }
});

Hooks.on("updateItem", (item) => {
  const actor = item.parent;
  if (!(actor instanceof Actor) || actor.type === "npc") return;
  reagentIntel.invalidateReagentState(actor);
  reagentIntel.buildActorReagentState(actor);
});

Hooks.on("createItem", (item) => {
  const actor = item.parent;
  if (!(actor instanceof Actor) || actor.type === "npc") return;
  reagentIntel.invalidateReagentState(actor);
  reagentIntel.buildActorReagentState(actor);
});

Hooks.on("deleteItem", (item) => {
  const actor = item.parent;
  if (!(actor instanceof Actor) || actor.type === "npc") return;
  reagentIntel.invalidateReagentState(actor);
  reagentIntel.buildActorReagentState(actor);
});

Hooks.on(`${MODULE_ID}.spellMapUpdated`, () => {
  console.log(`[${MODULE_ID}] Spell map updated — rebuilding reagent intel cache.`);
  reagentTracker.reagentIntel.rebuildAllCasters();
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

// --- NEW: refresh when the Spell Map itself changes
Hooks.on("updateSetting", (setting, data) => {
  if (setting.key === `${MODULE_ID}.spellReagentMap`) {
    console.log(`[${MODULE_ID}] Spell Map changed → rebuilding reagent intel cache`);
    reagentIntel.rebuildAllCasters();
  }
});

