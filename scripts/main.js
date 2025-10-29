import { findUpgradedReagentOnActor } from "./reagent-intel.js";


// --- Reagent Tracker (quiet build: no global hook spam, DEBUG off) ---
"use strict";

const MODULE_ID = "reagent-tracker";
const DEBUG = false;

console.log("[reagent-tracker] main.js loaded — waiting for ready...");
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

// ============================================================================
// 🌐 Global transient state: track actors mid-cast
// ============================================================================

if (!globalThis.reagentTracker) globalThis.reagentTracker = {};

// Initialize a Set that holds actor IDs currently performing a reagent-tracked cast.
// This is in-memory only (resets on reload) and prevents rebuilds while casting.
if (!globalThis.reagentTracker._castingActors) {
  globalThis.reagentTracker._castingActors = new Set();
  console.log("[reagent-tracker] _castingActors Set initialized");
}

// ======================================================================================
// 🧩 _rtBackfillReagentKeyFromCompSource (v31j-trace)
// Purpose: Log every stage of reagent backfill and inspect how 'consumed' is derived
// ======================================================================================
async function _rtBackfillReagentKeyFromCompSource(item) {
  const TAG = "[reagent-tracker][backfill:v31k-trace]";
  try {
    // --- R0: sanity --------------------------------------------------------
    if (!item) {
      console.warn(`${TAG} R0: no item passed`);
      return false;
    }

    const parent = item?.parent;
    if (!(parent instanceof Actor)) {
      console.log(`${TAG} R1: parent is not Actor →`, parent?.documentName);
      return false;
    }

    // --- Load existing reagent flags early --------------------------------
    const existing = item.flags?.[MODULE_ID] ?? item.flags?.["reagent-tracker"] ?? {};

    // --- R2: if already linked check consumed flag - otherwise skip -------
    if (existing?.reagentKey) {
      console.log(`${TAG} R2: already linked → ${item.name} key=${existing.reagentKey}`);

      // 🧭 Even if linked, re-evaluate consumed flag against SpellMap
      try {
        const map = game.settings.get(MODULE_ID, "spellMap") ?? [];
        const mapMatch = map.find(e =>
          e.reagents?.some(r => r.reagentKey === existing.reagentKey)
        );
        if (mapMatch) {
          const r = mapMatch.reagents.find(r => r.reagentKey === existing.reagentKey);
          if (r && typeof r.consumed === "boolean") {
            const current = item.getFlag("reagent-tracker", "consumed");
            console.log(`${TAG} DEBUG SpellMap reagent entry`, {
              itemName: item.name,
              reagentKey: existing.reagentKey,
              currentFlag: item.getFlag("reagent-tracker", "consumed"),
              reagentEntry: mapMatch.reagents.find(r => r.reagentKey === existing.reagentKey),
              spellLevelFlag: mapMatch.consumed
            });
            if (current !== r.consumed) {
              await item.setFlag("reagent-tracker", "consumed", r.consumed);
              console.log(`${TAG} 🔁 updated consumed=${r.consumed} for '${item.name}'`);
            } else {
              console.log(`${TAG} No change needed — consumed already ${current} for '${item.name}'`);
            }
          } else {
            console.log(`${TAG} ⚪ SpellMap entry found but consumed flag missing for ${item.name}`);
          }
        } else {
          console.log(`${TAG} ⚪ No SpellMap entry found for ${item.name}`);
        }
      } catch (err) {
        console.warn(`${TAG} SpellMap re-alignment failed for ${item.name}`, err);
      }

      // 🧩 NEW: ensure actor cache stays in sync even if reagent was already linked
      try {
        if (parent && globalThis.reagentTracker?.reagentIntel) {
          console.log(`${TAG} 🔁 Triggering reagentIntel rebuild for '${parent.name}'`);
          reagentTracker.reagentIntel.invalidateReagentState(parent);
          await reagentTracker.reagentIntel.buildActorReagentState(parent);
        }
      } catch (err) {
        console.warn(`${TAG} ⚠️ cache rebuild failed for '${parent?.name}'`, err);
      }

      // ✅ Return only after alignment + rebuild attempt
      return true;
    }

    // --- R3: detect origin -------------------------------------------------
    let src = item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? "";
    let packId = null, compId = null;

    if (src && src.startsWith("Compendium.")) {
      const parts = src.split(".");
      packId = `${parts[1]}.${parts[2]}`; // e.g. world.reagents
      compId = parts[4];
      console.log(`${TAG} R3a: using origin → src=${src} pack=${packId} id=${compId}`);
    } else {
      packId = "world.reagents";
      const pack = game.packs.get(packId);
      if (!pack) {
        console.warn(`${TAG} R3b: pack ${packId} missing`);
        return false;
      }
      const index = await pack.getIndex({ fields: ["name", "flags"] });
      const wanted = (item.name || "").toLowerCase();
      const hit = index.find(e => (e.name || "").toLowerCase() === wanted);
      if (!hit) {
        console.warn(`${TAG} R3b: name match not found in ${packId} for '${item.name}'`);
        return false;
      }
      compId = hit._id;
      console.log(`${TAG} R3b: name fallback matched → ${hit.name} (${compId})`);
    }

    const pack = game.packs.get(packId);
    if (!pack) {
      console.warn(`${TAG} R4: pack not found → ${packId}`);
      return false;
    }

    const doc = await pack.getDocument(compId);
    if (!doc) {
      console.warn(`${TAG} R5: compendium doc not found id=${compId}`);
      return false;
    }

    // --- R6: extract new-schema flags -------------------------------------
    const rFlags = doc.flags?.["reagent-tracker"] ?? doc.flags?.[MODULE_ID] ?? {};
    let reagentKey = rFlags.reagentKey ?? null;
    if (!reagentKey) {
      reagentKey = (doc.name || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_");
      console.log(`${TAG} R6: synthesized reagentKey='${reagentKey}' from name.`);
    }

    const reagentUUID = doc.uuid;
    const reagentType = rFlags.reagentType ?? item.type ?? "loot";
    const isLootable = rFlags.isLootable ?? true;

    // --- 🧭 Check SpellMap for authoritative consumed flag ----------------
    let consumed = null;
    try {
      const map = game.settings.get(MODULE_ID, "spellMap") ?? [];
      const mapMatch = map.find(e =>
        e.reagents?.some(r => r.reagentKey === reagentKey)
      );
      if (mapMatch) {
        const r = mapMatch.reagents.find(r => r.reagentKey === reagentKey);
        if (r && typeof r.consumed === "boolean") {
          consumed = r.consumed;
          console.log(`${TAG} 🟢 SpellMap override found for ${item.name} → consumed=${consumed}`);
        } else {
          console.log(`${TAG} ⚪ SpellMap entry found, but reagent.consumed undefined`);
        }
      } else {
        console.log(`${TAG} ⚪ No SpellMap match for reagentKey=${reagentKey}`);
      }
    } catch (err) {
      console.warn(`${TAG} SpellMap lookup failed`, err);
    }

    // --- Fallback to compendium flag if no SpellMap override found --------
    if (consumed === null) {
      consumed = rFlags.hasOwnProperty("consumed") ? rFlags.consumed : false;
      console.log(`${TAG} 🟠 Using compendium fallback for ${item.name} → consumed=${consumed}`);
    }

    // --- Metadata (for trace completeness) --------------------------------
    const aliases = rFlags.aliases ?? [];
    const sources = rFlags.sources ?? [];
    const dualType = doc.system?.reagentTracker?.dualType ?? [];

    // --- R7: write to actor-owned item ------------------------------------
    const updateData = {
      _id: item.id,
      "flags.reagent-tracker.reagentKey": reagentKey,
      "flags.reagent-tracker.reagentUUID": reagentUUID,
      "flags.reagent-tracker.reagentType": reagentType,
      "flags.reagent-tracker.isLootable": isLootable,
      "flags.reagent-tracker.consumed": consumed,
      "flags.reagent-tracker.aliases": aliases,
      "flags.reagent-tracker.sources": sources,
      "flags.reagent-tracker.dualType": dualType
    };

    console.log(`${TAG} R7: updating actor item '${item.name}' →`, updateData);
    await parent.updateEmbeddedDocuments("Item", [updateData]);

    console.log(`${TAG} ✅ linked '${item.name}' → key=${reagentKey}, uuid=${reagentUUID}, consumed=${consumed}`);
    console.groupEnd?.();
    return true;
  } catch (err) {
    console.groupEnd?.();
    console.warn(`${TAG} ERROR`, err);
    return false;
  }
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

// ============================================================================
// ⚙️ Foundry Init — register settings + initialize SpellMapData
// ============================================================================
Hooks.once("init", () => {
  const MODULE_ID = "reagent-tracker";
  console.log(`[${MODULE_ID}] Initializing module...`);

  // --- Register base settings ----------------------------------------------
  registerSettings();

  game.settings.register(MODULE_ID, "autoConsumeOnCast", {
    name: "Auto-consume reagents on cast",
    hint: "Disable to stop all reagent consumption globally until re-enabled.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => {
      ui.notifications.info(
        value
          ? "Auto-consume re-enabled. Restart Foundry to restore consume flags."
          : "Auto-consume disabled. Restart Foundry to apply changes."
      );
    }
  });

  // --- Initialize SpellMapData early ---------------------------------------
  console.log(`[${MODULE_ID}] Initializing SpellMapData...`);

  const SpellMapData =
    globalThis.SpellMapData && typeof globalThis.SpellMapData.getMap === "function"
      ? globalThis.SpellMapData
      : {
          // 🧩 Retrieve Spell → Reagent mappings
          getMap: () => {
            const data = game.settings.get(MODULE_ID, "spellMap");
            if (!Array.isArray(data)) return [];
            return data.map(entry => ({
              ...entry,
              reagentKey:
                entry?.reagentKey ??
                entry?.flags?.["reagent-tracker"]?.reagentKey ??
                null,
              reagentUUID: entry?.reagentUUID ?? null,
              priceInGP:
                entry?.priceInGP ??
                entry?.system?.priceInGP ??
                entry?.system?.price?.value ??
                null,
            }));
          },

          // 🧩 Write SpellMap to settings
          setMap: async (rows) => game.settings.set(MODULE_ID, "spellMap", rows),

          // 🧩 Optional helper: list world packs
          packsToScan: () => game.packs.filter(p => p.metadata.packageType === "world"),
        };

  // --- Expose globally for other scripts -----------------------------------
  globalThis.reagentTracker = globalThis.reagentTracker || {};
  globalThis.reagentTracker.SpellMapData = SpellMapData;
  globalThis.SpellMapData = SpellMapData;

// ========================================================================
// 🗃️ backupSpellMap (real implementation)
// ========================================================================
  globalThis.backupSpellMap = async function backupSpellMap(payload) {
    const MODULE_ID = "reagent-tracker";
    try {
      // Respect Auto-Consume toggle
      const autoEnabled = game.settings.get(MODULE_ID, "autoConsumeOnCast");
      if (!autoEnabled) {
        console.log(`[${MODULE_ID}] backupSpellMap skipped — Auto-Consume disabled.`);
        return false;
      }

      // Determine which map to back up
      const mapData = Array.isArray(payload)
        ? payload
        : globalThis.SpellMapData?.getMap?.() ?? [];

      if (!Array.isArray(mapData) || !mapData.length) {
        console.warn(`[${MODULE_ID}] backupSpellMap found no map entries to back up.`);
        return false;
      }

      // Ensure the hidden world setting exists
      if (!game.settings.settings.has(`${MODULE_ID}.spellMapBackup`)) {
        game.settings.register(MODULE_ID, "spellMapBackup", {
          name: "Spell Map Backup Data",
          scope: "world",
          config: false,   // hidden
          type: String,
          default: "",
        });
      }

      // Serialize + persist
      const json = JSON.stringify(mapData);
      await game.settings.set(MODULE_ID, "spellMapBackup", json);
      console.log(`[${MODULE_ID}] backupSpellMap stored ${mapData.length} entries in world setting.`);
      return true;
    } catch (err) {
      console.error(`[${MODULE_ID}] backupSpellMap error`, err);
      return false;
    }
  };

    // Optional: simple restore utility (future use)
    globalThis.restoreSpellMap = async function restoreSpellMap() {
      const MODULE_ID = "reagent-tracker";
      try {
        const json = game.settings.get(MODULE_ID, "spellMapBackup");
        if (!json) {
          console.log(`[${MODULE_ID}] restoreSpellMap → no backup data found.`);
          return false;
        }

        const data = JSON.parse(json);
        if (!Array.isArray(data) || !data.length) {
          console.warn(`[${MODULE_ID}] restoreSpellMap → backup empty or invalid.`);
          return false;
        }

        if (typeof globalThis.SpellMapData?.setMap === "function") {
          await globalThis.SpellMapData.setMap(data);
          console.log(`[${MODULE_ID}] restoreSpellMap restored ${data.length} entries to SpellMap.`);
          return true;
        }

        console.warn(`[${MODULE_ID}] restoreSpellMap → SpellMapData.setMap missing.`);
        return false;
      } catch (err) {
        console.error(`[${MODULE_ID}] restoreSpellMap error`, err);
        return false;
      }
    };

  console.log(`[${MODULE_ID}] SpellMapData initialized and backupSpellMap stub registered.`);

  // --- Hidden backup store -----------------------------------------
  game.settings.register(MODULE_ID, "spellMapBackup", {
    name: "Auto-Consume SpellMap backup data",
    scope: "world",
    config: false,      // hidden from the settings UI
    type: String,
    default: "",
  });

});



Hooks.once("ready", async () => {
  const mod = game.modules.get(MODULE_ID);
  console.log("[reagent-tracker] Hook ready fired!");
  console.group("[reagent-tracker] Ready diagnostics");
  console.log("reagentTracker pre-init:", globalThis.reagentTracker);
  console.log("reagentIntel pre-init:", globalThis.reagentTracker?.reagentIntel);
  console.log("cache type:", typeof globalThis.reagentTracker?.reagentIntel?.cache);
  console.groupEnd();

  if (mod) {
    mod.api = {
      ...(mod.api ?? {}),
      setTable: (rows) => ReagentData.setTable(rows),
      getSpellMap: () => SpellMapData.getMap(),
      setSpellMap: (rows) => SpellMapData.setMap(rows),
      runSpellMapBuilder,
      openSpellMap: () => new SpellMapManager().render(true),
      repairReagentCompendium,
      _postPreambleRegistered: mod.api?._postPreambleRegistered ?? false,
      _rtBackfillReagentKeyFromCompSource, // 🧩 added to module API
    };

    // 🔗 Global bindings
    globalThis.reagentTracker = {
      ...(globalThis.reagentTracker ?? {}),
      ...mod.api,
    };

    globalThis.runSpellMapBuilder = runSpellMapBuilder;
    globalThis.reagentTracker.hasReagentsSync = hasReagentsSync;
    globalThis.reagentTracker.consumeReagentFromInventory = consumeReagentFromInventory;
    globalThis.reagentTracker._rtBackfillReagentKeyFromCompSource = _rtBackfillReagentKeyFromCompSource;
    globalThis.repairReagentCompendium = repairReagentCompendium;
    game.reagentTrackerRepair = repairReagentCompendium;
    globalThis.reagentTracker.consumptionLogic = consumptionLogic;
      
    // 🔗 Also attach the reagentIntel subsystem if not already initialized
    if (globalThis.reagentTracker?.reagentIntel) {
      globalThis.reagentTracker.reagentIntel.findUpgradedReagentOnActor = findUpgradedReagentOnActor;
      console.log(
        `[${MODULE_ID}] reagentIntel upgrade finder attached successfully (existing subsystem).`
      );
    } else {
      globalThis.reagentTracker.reagentIntel = { findUpgradedReagentOnActor };
      console.log(
        `[${MODULE_ID}] reagentIntel subsystem created and upgrade finder attached.`
      );
    }

    console.log(`[${MODULE_ID}] _rtBackfillReagentKeyFromCompSource exposed via mod.api and globalThis`);
  }

// =============================================================
//  REAGENT ENFORCEMENT (sync + async from intel cache)
// =============================================================

  function hasReagentsSync(actor, item) {
    try {
      if (!actor || !item)
        return { ok: true, reason: "no actor/item" };

      const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
      if (!intel)
        return { ok: true, reason: "intel not ready" }; // cache not ready → fail open

      const spellState = intel.spells?.[item.id];
      if (!spellState)
        return { ok: true, reason: "unmapped" }; // unmapped → allow cast

      const key = spellState.reagentKey;
      const hasExact = !!actor.items.find(i => i.getFlag(MODULE_ID, "reagentKey") === key);
      const hasUpgrade = !!(spellState.hasUpgrade && spellState.upgrade?.itemId);
      const upgrade = hasUpgrade ? spellState.upgrade : null;

      if (hasExact) return { ok: true, hasExact, hasUpgrade, upgrade };
      if (hasUpgrade) return { ok: false, hasExact, hasUpgrade, upgrade, reason: "upgrade-available" };

      console.warn(`[${MODULE_ID}] ${actor.name} lacks reagent for ${item.name}`);
      return { ok: false, hasExact, hasUpgrade, reason: "missing" };

    } catch (err) {
      console.error(`[${MODULE_ID}] hasReagentsSync error`, err);
      return { ok: true, reason: "error" };
    }
  }

// ============================================================================
// 💎 promptUseHigherValue — marks approvedUpgrade only (no recast here)
// ============================================================================
  async function promptUseHigherValue(actor, item, upgraded) {
    const MODULE_ID = "reagent-tracker";
    try {
      const speaker     = ChatMessage.getSpeaker({ actor });
      const upgradeName = upgraded?.itemName ?? upgraded?.item?.name ?? "(unknown)";
      const valueGP     = upgraded?.valueGP ?? "?";
      const baseCost    = upgraded?.minCost ?? 0;

      // 🔍 Diagnostic snapshot
      {
        const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
        const spellState = intel?.spells?.[item.id];
        console.log(`[${MODULE_ID}] [prompt] opening prompt for ${actor.name}/${item.name}`, {
          upgradeName, valueGP, baseCost,
          cacheHasIntel: !!intel,
          cacheHasSpellEntry: !!spellState,
          approvedUpgrade_beforePrompt: spellState?.approvedUpgrade
        });
      }

      // Build the chat prompt
      const content = `
        <div class="reagent-tracker-prompt" style="padding:.5rem;">
          💎 <b>${actor.name}</b> has a more valuable reagent available for <b>${item.name}</b>:<br>
          <b>${upgradeName}</b> (${valueGP} gp) vs minimum ${baseCost} gp.<br><br>
          Use it to cast the spell?<br><br>
          <button class="rt-accept" style="background:#4a7350;color:white;padding:.25rem .75rem;border:none;border-radius:4px;margin-right:.5rem;">✅ Use</button>
          <button class="rt-decline" style="background:#a33;color:white;padding:.25rem .75rem;border:none;border-radius:4px;">❌ Decline</button>
        </div>`;

      // Create the chat message
      await new Promise(r => setTimeout(r, 150));
      const chat = await ChatMessage.create({
        speaker, content, whisper: [],
        flags: { [MODULE_ID]: { isPrompt: true } }
      });
      console.log(`[${MODULE_ID}] promptUseHigherValue message created id=${chat.id}`);

      // Wait briefly to ensure DOM ready
      await new Promise(r => setTimeout(r, 250));
      const html = document.querySelector(`[data-message-id="${chat.id}"]`);
      const safeDelete = async () => { await new Promise(r => setTimeout(r, 200)); try { await chat.delete(); } catch (_) {} };

      if (!html) {
        console.warn(`[${MODULE_ID}] promptUseHigherValue: could not locate message HTML for ${chat.id}`);
        return { ok: false };
      }

      const acceptBtn  = html.querySelector(".rt-accept");
      const declineBtn = html.querySelector(".rt-decline");

      // ✅ ACCEPT → mark approval only
      acceptBtn?.addEventListener("click", async ev => {
        ev.preventDefault();
        console.log(`[${MODULE_ID}] ✅ ACCEPT clicked for ${chat.id}`);

        const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
        const spellState = intel?.spells?.[item.id];

        if (spellState) {
          // Mark approval and store upgradeChoice — DO NOT clear later
          spellState.approvedUpgrade = true;
          spellState.upgradeChoice = {
            reagentKey: upgraded?.reagentKey ?? upgraded?.item?.getFlag?.(MODULE_ID,"reagentKey") ?? null,
            itemId: upgraded?.item?.id ?? null,
            valueGP: upgraded?.valueGP ?? null,
            name: upgradeName
          };
          reagentTracker.reagentIntel?.cache?.set(actor.id, intel);
        }

        console.log(`[${MODULE_ID}] [prompt] set approvedUpgrade`, {
          approvedUpgrade_after: spellState?.approvedUpgrade,
          upgradeChoice_after: spellState?.upgradeChoice
        });

        ui.notifications.info(`${actor.name} approved use of a higher-value reagent for ${item.name}.`);
        await safeDelete();

        // ✅ Signal to dnd5e that approval is complete; dnd5e will handle recast.
        Hooks.callAll(`rtPrompt:${chat.id}`, { ok: true });
      });

      // ❌ DECLINE → cleanup and exit
      declineBtn?.addEventListener("click", async ev => {
        ev.preventDefault();
        console.log(`[${MODULE_ID}] ❌ DECLINE clicked for ${chat.id}`);
        const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
        const spellState = intel?.spells?.[item.id];
        if (spellState) {
          delete spellState.upgradeChoice;
          reagentTracker.reagentIntel?.cache?.set(actor.id, intel);
        }
        ui.notifications.warn(`${actor.name} declined the higher-value reagent for ${item.name}.`);
        await safeDelete();
        Hooks.callAll(`rtPrompt:${chat.id}`, { ok: false });
      });

      // Diagnostic resolver
      return new Promise(resolve => {
        Hooks.once(`rtPrompt:${chat.id}`, result => {
          console.log(`[${MODULE_ID}] 🧩 promptUseHigherValue resolved for ${item.name}:`, result);
          resolve(result);
        });
      });

    } catch (err) {
      console.error(`[${MODULE_ID}] promptUseHigherValue error`, err);
      return { ok: false };
    }
  }

  // ---- Link existing backupSpellMap (do NOT define it here) -------------------
  (() => {
    const TAG = `[${MODULE_ID}][backupLinker:v32b]`;

    // prefer already-loaded hoisted function; otherwise retry briefly for late-bound const
    const tryLink = () => {
      const fn =
        (typeof backupSpellMap === "function" ? backupSpellMap : undefined) ||
        globalThis.backupSpellMap; // if you chose to attach it globally elsewhere

      if (typeof fn === "function") {
        // expose on API + global
        mod.api = { ...(mod.api ?? {}), backupSpellMap: fn };
        globalThis.reagentTracker = { ...(globalThis.reagentTracker ?? {}), backupSpellMap: fn };
        console.log(`${TAG} linked backupSpellMap to mod.api and reagentTracker.`);
        return true;
      }
      return false;
    };

    if (tryLink()) return;

    // retry up to ~1s for late-bound const backupSpellMap defined below
    let tries = 0;
    const id = setInterval(() => {
      if (tryLink() || ++tries > 20) {
        if (tries > 20) console.warn(`${TAG} no backupSpellMap found to link.`);
        clearInterval(id);
      }
    }, 50);
  })();



  // --- Debounced notification helper (prevents double toasts) ---
  let _rtToastShown = false;
  function safeNotify(type, msg, timeout = 900) {
    if (_rtToastShown) return;
    _rtToastShown = true;
    ui.notifications[type](msg);
    setTimeout(() => { _rtToastShown = false; }, timeout);
  }


  // Prevent double-consumption during the same cast
  const _castConsumeGuards = new Set();
  function _makeConsumeKey(item, ctxId) {
    const a = item?.actor?.id ?? "noactor";
    const i = item?.id ?? "noitem";
    const c =
      ctxId ??
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${a}:${i}:${Date.now()}:${Math.random()}`);
    return `${a}:${i}:${c}`;
  }

// ============================================================================
// 🧩 Global helper: applyAutoConsumeChange(value, prev)
// Handles backup/restore logic when the Auto-Consume checkbox changes
// ============================================================================
globalThis.reagentTracker.applyAutoConsumeChange = async function (value, prev) {
  const MODULE_ID = "reagent-tracker";
  try {
    // --------------------------------------------------------------
    // ♻️ Re-enable → restore from backup
    // --------------------------------------------------------------
    if (value && prev === false) {
      console.log(`[${MODULE_ID}] Auto-Consume re-enabled → attempting restore from backup...`);
      const json = game.settings.get(MODULE_ID, "spellMapBackup");
      if (json && json.length > 10) {
        try {
          const data = JSON.parse(json);
          if (Array.isArray(data) && data.length) {
            await globalThis.SpellMapData.setMap(data);
            console.log(`[${MODULE_ID}] Restored ${data.length} Spell Map entries from backup.`);
            await game.settings.set(MODULE_ID, "spellMapBackup", ""); // optional cleanup
          } else {
            console.warn(`[${MODULE_ID}] Backup empty or invalid; skipped restore.`);
          }
        } catch (err) {
          console.error(`[${MODULE_ID}] Restore error:`, err);
        }
      } else {
        console.log(`[${MODULE_ID}] No Spell Map backup data to restore.`);
      }

      // 🔄 Clear cache bypass on re-enable
      const cache = reagentTracker?.reagentIntel?.cache;
      if (cache && cache.size) {
        for (const [actorId, intel] of cache.entries()) {
          intel.bypassEnforcement = false;
        }
        console.log(`[${MODULE_ID}] Cache updated → bypassEnforcement = false for ${cache.size} actor(s).`);
      }
    }

    // --------------------------------------------------------------
    // ⛔ Disable → backup and strip all consumption flags
    // --------------------------------------------------------------
    else if (value === false) {
      console.log(`[${MODULE_ID}] Auto-Consume disabled → backing up and stripping consumption flags…`);
      const map = globalThis.SpellMapData?.getMap?.() ?? [];
      if (Array.isArray(map) && map.length) {
        // 1️⃣ Backup current map
        await game.settings.set(MODULE_ID, "spellMapBackup", JSON.stringify(map));

        // 2️⃣ Clone and strip consumption flags (top-level + nested)
        const stripped = map.map(entry => {
          const e = { ...entry, consumed: false };

          // Ensure reagents are non-consumable
          if (Array.isArray(e.reagents)) {
            e.reagents = e.reagents.map(r => ({ ...r, consumed: false }));
          }

          // Ensure system.materials.consumed = false if present
          e.system = {
            ...(e.system ?? {}),
            materials: {
              ...(e.system?.materials ?? {}),
              consumed: false
            }
          };

          return e;
        });

        // 3️⃣ Mark cache to bypass enforcement
        const cache = reagentTracker?.reagentIntel?.cache;
        if (cache && cache.size) {
          for (const [actorId, intel] of cache.entries()) {
            intel.bypassEnforcement = true;
          }
          console.log(`[${MODULE_ID}] Cache updated → bypassEnforcement = true for ${cache.size} actor(s).`);
        }

        // 4️⃣ Save stripped map back to settings
        await globalThis.SpellMapData.setMap(stripped);
        console.log(`[${MODULE_ID}] Stripped consumption flags from ${stripped.length} Spell Map entries.`);
      } else {
        console.warn(`[${MODULE_ID}] Auto-Consume disabled but Spell Map empty or invalid.`);
      }
    }

    // --------------------------------------------------------------
    // 🪧 User-facing toast
    // --------------------------------------------------------------
    const msg = value
      ? "Auto-consume has been re-enabled."
      : "Auto-consume has been disabled. Reagents will not be consumed until re-enabled.";
    ui.notifications.info(msg);

  } catch (err) {
    console.error(`[${MODULE_ID}] applyAutoConsumeChange error`, err);
  }
};



// =====================================================================================
//  CONSUMPTION LOGIC — v31r (stable, post-consumption rebuild)
//  • Fixes over-consumption bug
//  • Ensures post-cast rebuild after inventory updates
//  • Clears approvedUpgrade flag and casting guard safely
// =====================================================================================
  async function consumptionLogic(actor, item) {
    const MODULE_ID = "reagent-tracker";

    try {
      if (!actor || !item) return true;
      console.log(`[${MODULE_ID}] [consumptionLogic] ENTER → ${actor.name}/${item.name}`);

      const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
      if (!intel) {
        console.log(`[${MODULE_ID}] [consumptionLogic] no intel in cache for actor ${actor.name}`);
        reagentTracker._castingActors.delete(actor.id);
        return true;
      }

      const originalId = item.getFlag(MODULE_ID, "originalItemId");
      const spellEntry = intel.spells?.[originalId ?? item.id];

      // Snapshot
      console.log(`[${MODULE_ID}] [consumptionLogic] cache snapshot`, {
        actor: actor.name, item: item.name,
        originalId: originalId ?? null,
        hasSpellEntry: !!spellEntry,
        approvedUpgrade: spellEntry?.approvedUpgrade,
        hasUpgrade: !!spellEntry?.hasUpgrade,
        hasExact: !!spellEntry?.hasExact,
        reagentKey: spellEntry?.reagentKey,
        upgrade: spellEntry?.upgrade
      });

      if (!spellEntry) {
        console.log(`[${MODULE_ID}] ${item.name} → not reagent-linked or cache missing`);
        reagentTracker._castingActors.delete(actor.id);
        return true;
      }

      if (spellEntry.missing || spellEntry.hasMissing) {
        console.log(`[${MODULE_ID}] ${actor.name} ${item.name} skipped consumption (missing reagent).`);
        reagentTracker._castingActors.delete(actor.id);
        return true;
      }

      let reagentItem = null;
      let logLabel = "(unknown)";

      // ---------------------------------------------------------------------
      // 🔹 Case 1 — Approved Upgrade
      // ---------------------------------------------------------------------
      if (spellEntry.approvedUpgrade === true) {
        const upgradeData = spellEntry.upgrade ?? {};
        const upName = upgradeData.itemName?.toLowerCase() ?? "";

        console.log(`[${MODULE_ID}] [consumptionLogic] attempting UPGRADE consumption`, upgradeData);

        const upgradeItem =
          actor.items.get(upgradeData.itemId) ||
          actor.items.find(i =>
            i.name?.toLowerCase() === upName ||
            i.getFlag(MODULE_ID, "reagentKey") === upgradeData.reagentKey
          );

        console.log(`[${MODULE_ID}] [consumptionLogic] resolved upgrade item:`, {
          found: !!upgradeItem,
          id: upgradeItem?.id,
          name: upgradeItem?.name,
          key: upgradeItem?.getFlag?.(MODULE_ID, "reagentKey")
        });

        if (!upgradeItem) {
          ui.notifications.warn(`${actor.name} → ${item.name}: upgrade reagent missing, skipping consumption.`);
          reagentTracker._castingActors.delete(actor.id);
          return true;
        }

        const expectedKey = upgradeData.reagentKey;
        const foundKey = upgradeItem.getFlag(MODULE_ID, "reagentKey");
        if (expectedKey && foundKey && foundKey !== expectedKey) {
          ui.notifications.warn(`${item.name}: upgrade reagent mismatch, skipping consumption.`);
          console.warn(`[${MODULE_ID}] ${actor.name} ${item.name}: key mismatch (expected ${expectedKey}, found ${foundKey}).`);
          reagentTracker._castingActors.delete(actor.id);
          return true;
        }

        reagentItem = upgradeItem;
        logLabel = upgradeItem.name ?? upgradeData.itemName ?? "(upgrade)";
        console.log(`[${MODULE_ID}] ${actor.name} ${item.name} consuming approved upgrade.`);
      }

      // ---------------------------------------------------------------------
      // 🔹 Case 2 — Standard Exact Reagent
      // ---------------------------------------------------------------------
      else if (spellEntry.hasExact && spellEntry.reagentKey) {
        console.log(`[${MODULE_ID}] [consumptionLogic] attempting STANDARD consumption`, {
          reagentKey: spellEntry.reagentKey
        });

        reagentItem = actor.items.find(i => {
          const key =
            i.flags?.[MODULE_ID]?.reagentKey ??
            i.getFlag?.(MODULE_ID, "reagentKey");
          return key === spellEntry.reagentKey;
        });

        console.log(`[${MODULE_ID}] [consumptionLogic] resolved standard item:`, {
          found: !!reagentItem, id: reagentItem?.id, name: reagentItem?.name
        });

        logLabel = reagentItem?.name ?? spellEntry.reagentKey;
        console.log(`[${MODULE_ID}] ${actor.name} ${item.name} consuming standard reagent.`);
      }

      // ---------------------------------------------------------------------
      // 🔹 Case 3 — Upgrade Available But Not Approved
      // ---------------------------------------------------------------------
      else if (spellEntry.hasUpgrade && !spellEntry.approvedUpgrade) {
        console.log(`[${MODULE_ID}] [consumptionLogic] Upgrade available but NOT approved → skipping consumption`);
        reagentTracker._castingActors.delete(actor.id);
        return true;
      }

      // ---------------------------------------------------------------------
      // 🔹 Safety
      // ---------------------------------------------------------------------
      if (!reagentItem) {
        console.warn(`[${MODULE_ID}] ${actor.name} ${item.name} could not locate reagent item — skipping consumption.`);
        reagentTracker._castingActors.delete(actor.id);
        return true;
      }

      const guardKey = _makeConsumeKey(item, Date.now());
      if (_castConsumeGuards.has(guardKey)) {
        console.log(`[${MODULE_ID}] duplicate consumption guard for ${item.name} — skipping.`);
        reagentTracker._castingActors.delete(actor.id);
        return true;
      }
      _castConsumeGuards.add(guardKey);

      // ---------------------------------------------------------------------
      // 🔹 Determine quantity (fixed)
      // ---------------------------------------------------------------------
      let qtyNeeded = 1;
      const spellQty = Number(spellEntry?.quantity ?? 0);
      if (spellQty > 1) qtyNeeded = spellQty;

      console.log(`[${MODULE_ID}] [consumptionLogic] using qtyNeeded=${qtyNeeded}`);

      // ---------------------------------------------------------------------
      // 🔹 Consume
      // ---------------------------------------------------------------------
      const res = await consumeReagentFromInventory(actor, reagentItem, qtyNeeded);
      console.log(
        `[${MODULE_ID}] CONSUME ${actor.name} ${item.name}: ${logLabel} → used ${res.consumed} (updates=${res.updates}, deleted=${res.deleted})`
      );

      // ---------------------------------------------------------------------
      // 🔹 Clear flags and guards
      // ---------------------------------------------------------------------
      if (spellEntry.approvedUpgrade) {
        console.log(`[${MODULE_ID}] [consumptionLogic] clearing approvedUpgrade after consumption`);
        delete spellEntry.approvedUpgrade;
      }

      reagentTracker._castingActors.delete(actor.id);
      console.log(`[${MODULE_ID}] cleared casting guard after ${item.name}`);

      // ---------------------------------------------------------------------
      // 🧠 Post-consumption cache rebuild (delayed)
      // ---------------------------------------------------------------------
      setTimeout(async () => {
        try {
          console.log(`[${MODULE_ID}] [consumptionLogic] rebuilding reagent cache for ${actor.name} post-consumption`);
          await reagentTracker.reagentIntel?.buildActorReagentState(actor);
        } catch (err) {
          console.warn(`[${MODULE_ID}] post-consumption rebuild failed for ${actor.name}`, err);
        }
      }, 500);

      return true;

    } catch (err) {
      console.error(`[${MODULE_ID}] consumptionLogic error`, err);
      if (actor) reagentTracker._castingActors.delete(actor.id);
      return true;
    }
}



// -------------------------------------------------------------------------------------
// Canonical consumer: decrement a specific reagent in the actor's inventory
// Accepts either an Item (preferred) or a reagent descriptor with { reagentKey }
// -------------------------------------------------------------------------------------
  async function consumeReagentFromInventory(actor, reagentOrItem, qty = 1) {
    try {
      if (!actor || !reagentOrItem || qty <= 0) {
        console.warn("[reagent-tracker] consumeReagentFromInventory invalid args");
        return { consumed: 0, updates: 0, deleted: 0 };
      }

      // 🧩 Resolve the correct Item document
      let itemDoc = null;

      // A) Direct Item5e document or object
      if (reagentOrItem?.document || reagentOrItem?.type) {
        const id = reagentOrItem.id ?? null;
        itemDoc = id ? actor.items.get(id) : reagentOrItem;
      }

      // B) Cached reagent object (has itemId)
      if (!itemDoc && reagentOrItem?.itemId) {
        itemDoc = actor.items.get(reagentOrItem.itemId);
      }

      // C) Descriptor containing a reagentKey (new schema)
      if (!itemDoc && reagentOrItem?.reagentKey) {
        itemDoc = actor.items.find(i => {
          const key =
            i.flags?.["reagent-tracker"]?.reagentKey ??
            i.getFlag?.("reagent-tracker", "reagentKey");
          return key === reagentOrItem.reagentKey;
        });
      }

      if (!itemDoc) {
        console.warn("[reagent-tracker] consumeReagentFromInventory could not resolve inventory item to consume.");
        return { consumed: 0, updates: 0, deleted: 0 };
      }

      const name =
        itemDoc.name ??
        reagentOrItem.name ??
        reagentOrItem.reagentNameCached ??
        reagentOrItem.reagentKey ??
        "(reagent)";

      // --- Quantity
      const current = Number(itemDoc.system?.quantity ?? 0) || 0;
      if (current <= 0) {
        console.warn(`[reagent-tracker] ${name} has quantity 0 — nothing to consume.`);
        return { consumed: 0, updates: 0, deleted: 0 };
      }

      const take = Math.min(qty, current);
      const newQty = current - take;

      // --- Determine if the reagent is actually consumed (schema flag)
      const consumedFlag =
        itemDoc.flags?.["reagent-tracker"]?.consumed ??
        itemDoc.getFlag?.("reagent-tracker", "consumed") ??
        true; // default: true

      if (!consumedFlag) {
        console.log(`[reagent-tracker] ${name} marked non-consumable; quantity unchanged.`);
        return { consumed: 0, updates: 0, deleted: 0 };
      }

      // --- Update or delete
      if (newQty > 0) {
        await actor.updateEmbeddedDocuments("Item", [
          { _id: itemDoc.id, "system.quantity": newQty },
        ]);
        console.log(`[reagent-tracker] consumed ${take} of ${name} (remaining ${newQty}).`);
        return { consumed: take, updates: 1, deleted: 0 };
      } else {
        await actor.deleteEmbeddedDocuments("Item", [itemDoc.id]);
        console.log(`[reagent-tracker] consumed ${take} and removed empty stack: ${name}.`);
        return { consumed: take, updates: 0, deleted: 1 };
      }
    } catch (err) {
      console.error("[reagent-tracker] consumeReagentFromInventory error", err);
      return { consumed: 0, updates: 0, deleted: 0, error: err };
    }
  }


// ============================================================================
// 🧱 dnd5e.preUseActivity — reagent enforcement with upgrade prompt + recast
// ============================================================================
Hooks.on("dnd5e.preUseActivity", (activity, config, options, userId) => {
  const MODULE_ID = "reagent-tracker";
  try {
    const actor = activity?.actor;
    const item  = activity?.item;
    if (!actor || !item) return true;
    if (item.type !== "spell") return true;

    // -----------------------------------------------------------------------
    // 🧠 Guard: skip reagent logic if the spell cannot actually be cast
    // -----------------------------------------------------------------------
    const level = item.system.level ?? 0;
    const consumesSlot =
      item.system.preparation?.mode === "prepared" ||
      item.system.preparation?.mode === "always" ||
      item.system.preparation?.mode === "pact"; // include warlocks

    if (consumesSlot && level > 0) {
      const slotData = Object.values(actor.system.spells).find(s => s.level === level);
      const slotsAvailable = slotData?.value ?? 0;
      if (slotsAvailable <= 0) {
        console.log(
          `[${MODULE_ID}] [preUseActivity] skipping reagent check — no spell slots left (level ${level})`
        );
        return true;
      }
    }

    // -----------------------------------------------------------------------
    // --- Cache snapshot (diagnostic)
    // -----------------------------------------------------------------------
    const intel      = reagentTracker.reagentIntel?.cache?.get(actor.id);
    const spellState = intel?.spells?.[item.id];
    console.log(`[${MODULE_ID}] [preUseActivity] ${actor.name}/${item.name} cache snapshot:`, {
      hasIntel: !!intel,
      hasSpellEntry: !!spellState,
      approvedUpgrade: spellState?.approvedUpgrade,
      hasUpgrade: !!spellState?.hasUpgrade,
      hasExact: !!spellState?.hasExact,
      reagentKey: spellState?.reagentKey,
      upgradeKey: spellState?.upgrade?.reagentKey,
      bypassEnforcement: intel?.bypassEnforcement
    });

    // -----------------------------------------------------------------------
    // 🧩 0) Global bypassEnforcement check (Auto-Consume disabled)
    // -----------------------------------------------------------------------
    if (intel?.bypassEnforcement) {
      console.log(
        `[${MODULE_ID}] [preUseActivity] bypassEnforcement active → ${actor.name}/${item.name} will cast without reagent checks.`
      );
      reagentTracker._castingActors.add(actor.id); // prevent rebuild interference
      return true;
    }

    // -----------------------------------------------------------------------
    // 1) If an upgrade was approved earlier → allow cast
    // -----------------------------------------------------------------------
    if (spellState?.approvedUpgrade) {
      console.log(
        `[${MODULE_ID}] ⚡ approvedUpgrade=true → allow ${item.name} (consumption will handle clearing later)`
      );
      reagentTracker._castingActors.add(actor.id);
      return true;
    }

    // -----------------------------------------------------------------------
    // 2) Normal reagent enforcement
    // -----------------------------------------------------------------------
    const state = reagentTracker.hasReagentsSync(actor, item);
    console.debug(
      `[${MODULE_ID}] [preUseActivity] ${actor.name}/${item.name} hasReagentsSync →`,
      state
    );

    if (state.ok === true) {
      console.log(`[${MODULE_ID}] ✅ exact reagent available → allow ${item.name}`);
      reagentTracker._castingActors.add(actor.id);
      return true;
    }

    // -----------------------------------------------------------------------
    // 3) Missing reagent: either prompt for upgrade or hard block
    // -----------------------------------------------------------------------
    ui.notifications.warn(`${item.name} was not cast — missing or upgraded reagents.`);
    console.warn(
      `[${MODULE_ID}] [preUseActivity] blocking ${item.name} (reason=${state.reason})`
    );

    if (state.hasUpgrade && !spellState?.approvedUpgrade) {
      console.log(`[${MODULE_ID}] [preUseActivity] prompting for higher-value reagent`, {
        upgradeName: state.upgrade?.itemName,
        upgradeKey: state.upgrade?.reagentKey
      });

      Promise.resolve()
        .then(() => promptUseHigherValue(actor, item, state.upgrade))
        .then(async (res) => {
          console.log(`[${MODULE_ID}] [preUseActivity] prompt resolved for ${item.name}:`, res);
          if (!res?.ok) return;

          const updatedIntel = reagentTracker.reagentIntel?.cache?.get(actor.id);
          const updatedState = updatedIntel?.spells?.[item.id];
          if (!updatedState?.approvedUpgrade) {
            console.warn(`[${MODULE_ID}] approval expected but missing — aborting recast`, {
              updatedState,
            });
            return;
          }

          console.log(`[${MODULE_ID}] ♻️ recasting ${item.name} after approval`);
          try {
            const tempItem = new CONFIG.Item.documentClass(item.toObject(), { parent: actor });
            await tempItem.use();
          } catch (err) {
            console.error(`[${MODULE_ID}] recast error for ${item.name}`, err);
          }
        })
        .catch((err) => console.error(`[${MODULE_ID}] prompt/recast chain error`, err));
    }

    return false;

  } catch (err) {
    console.error(`[${MODULE_ID}] Error in preUseActivity`, err);
    return true;
  }
});


// =====================================================================================
//  D&D5e native consumption trigger
// =====================================================================================
Hooks.on("dnd5e.activityConsumption", async (activity, config, options) => {
  const MODULE_ID = "reagent-tracker";
  try {
    const actor = activity?.actor;
    const item  = activity?.item;
    if (!actor || !item || item.type !== "spell") return;

    const intel = reagentTracker?.reagentIntel?.cache?.get(actor.id);
    if (intel?.bypassEnforcement) {
      console.log(
        `[${MODULE_ID}] [activityConsumption] bypassEnforcement active → skipping reagent consumption for ${actor.name}/${item.name}.`
      );
      return; // 🚫 Skip consumption entirely
    }

    console.log(`[${MODULE_ID}] ⚡ dnd5e.activityConsumption → ${actor.name}/${item.name}`);
    await consumptionLogic(actor, item);

  } catch (err) {
    console.error(`[${MODULE_ID}] dnd5e.activityConsumption error`, err);
  } finally {
    reagentTracker._castingActors.delete(activity?.actor?.id);
  }
});



});

/* -------------------------------------------------------------------------------------------------
 *  DATA ACCESS LAYERS  (v31a unified → spellMap)
 * ------------------------------------------------------------------------------------------------- */

// --- Unified Spell Map storage interface -------------------------------------
const SpellMapData =
  globalThis.SpellMapData && typeof globalThis.SpellMapData.getMap === "function"
    ? globalThis.SpellMapData
    : {
        // 🧩 Retrieve Spell → Reagent mappings
        getMap: () => {
          const data = game.settings.get(MODULE_ID, "spellMap");
          if (!Array.isArray(data)) return [];
          return data.map(entry => ({
            ...entry,
            reagentKey:
              entry?.reagentKey ??
              entry?.flags?.["reagent-tracker"]?.reagentKey ??
              null,
            reagentUUID: entry?.reagentUUID ?? null,
            priceInGP:
              entry?.priceInGP ??
              entry?.system?.priceInGP ??
              entry?.system?.price?.value ??
              null,
          }));
        },

        // 🧩 Enhanced setter with update broadcast
        setMap: async (rows) => {
          const arr = Array.isArray(rows) ? rows : [];
          await game.settings.set(MODULE_ID, "spellMap", arr);

          // 🔔 Notify all listeners (e.g., reagentIntel) that Spell Map has changed
          Hooks.callAll(`${MODULE_ID}.spellMapUpdated`, arr);

          console.log(
            `[${MODULE_ID}] Spell Map updated → ${arr.length} entries (schema v31a)`
          );
          return arr;
        },

        // 🧩 Configured spell packs to scan (comma-delimited setting)
        packsToScan: () => {
          const raw = game.settings.get(MODULE_ID, "spellPacksToScan") ?? "";
          return String(raw)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        },
        
      };

// --- Retrieve reagent compendium packs configured for scanning ---------------
  function getConfiguredPacks() {
    // Hard-code the reagent source now that we’ve dropped the user-selectable pack
    return ["world.reagents"];
  }


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
      closeOnSubmit: true,
    });
  }

  // --- Static factory shortcut
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

    // 🟥 Cancel → close dialog
    html.find("button.cancel").on("click", () => this.close());

    // 🟨 Clear / unlink reagent mapping
    html.find("[data-action='clear-mapping']").on("click", async (ev) => {
      ev.preventDefault();

      // Reset dropdown visually
      html.find("select[name='compUuid']").val("");

      // Reset internal state to schema defaults
      Object.assign(this.current, {
        reagentUUID: null,
        reagentNameCached: null,
        reagentKey: null,
        reagentType: "material",
        priceInGP: null,
        minCost: null,
        quantity: 1,
        consumed: false,
        reagents: [],
        flags: { "reagent-tracker": {} },
        system: { price: { value: 0, denomination: "gp" }, priceInGP: 0 },
      });

      ui.notifications.info(
        "Reagent link removed — not saved until you click Save."
      );
      await this.render(true);
    });

    // 🟩 “Open in Compendium” link
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
    // --- Gather available reagent entries from configured packs
    const packKeys = getConfiguredPacks();
    const compendium = [];

    for (const key of packKeys) {
      const pack = game.packs.get(key);
      if (!pack) continue;

      // Index only name + flags fields (for reagentKey if available)
      const index = await pack.getIndex({ fields: ["name", "flags"] });
      const coll = pack.collection?.startsWith("Compendium.")
        ? pack.collection
        : `Compendium.${pack.collection}`;

      for (const e of index) {
        const reagentKey =
          e.flags?.["reagent-tracker"]?.reagentKey ??
          e.flags?.[MODULE_ID]?.reagentKey ??
          null;

        compendium.push({
          pack: key,
          id: e._id,
          name: e.name,
          uuid: `${coll}.${e._id}`,
          reagentKey,
        });
      }
    }

    // Sort alphabetically (case-insensitive)
    compendium.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );

    // Prepare currently linked reagent (normalize structure)
    const reagent =
      this.current?.reagents?.[0] ? this.current.reagents[0] : this.current;

    reagent.spellNameCached =
      this.current?.spellNameCached || reagent.spellNameCached;
    reagent.priceInGP =
      reagent?.priceInGP ??
      reagent?.system?.priceInGP ??
      reagent?.system?.price?.value ??
      null;
    reagent.reagentKey =
      reagent?.reagentKey ??
      reagent?.flags?.["reagent-tracker"]?.reagentKey ??
      null;

    const showUnlink = !!reagent?.reagentUUID;

    return { current: reagent, compendium, showUnlink };
  }

  /* -------------------------------------------- */
  async _updateObject(_event, formData) {
    const out = {
      reagentUUID: null,
      reagentNameCached: null,
      reagentKey: null,
      reagentType: "material",
      minCost: Number(formData.minCost || 0) || null,
      quantity: Number(formData.quantity || 1) || 1,
      consumed: !!formData.consumed,
    };

    const uuid = formData.compUuid;

    // If dropdown cleared → resolve null
    if (!uuid) {
      this._resolver?.(null);
      return;
    }

    try {
      const doc = await fromUuid(uuid);
      const rFlags =
        doc.flags?.["reagent-tracker"] ??
        doc.flags?.[MODULE_ID] ??
        {};

      out.reagentUUID = uuid;
      out.reagentNameCached = doc?.name ?? uuid;
      out.reagentKey = rFlags.reagentKey ?? null;
      out.priceInGP =
        doc.system?.priceInGP ??
        doc.system?.price?.value ??
        null;
      out.reagentType = rFlags.reagentType ?? "material";
      // Only fall back if form didn't define a boolean
      if (typeof out.consumed !== "boolean") {
        out.consumed =
          rFlags.consumed ??
          doc.system?.reagentTracker?.consumed ??
          false;
}

    } catch (err) {
      console.warn(`[${MODULE_ID}] Failed to resolve reagent for picker`, err);
      out.reagentUUID = uuid;
      out.reagentNameCached = uuid;
    }

    this._resolver?.(out);
  }
}


/* -------------------------------------------------------------------------------------------------
 *  UI: SPELL MAP MANAGER (v33-clean)
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
      resizable: true,
    });
  }

  get isGM() { return game.user.isGM; }

  /* -------------------------------------------- */
  async getData() {
    if (!this.isGM) {
      ui.notifications.warn("Only the GM can manage the spell map.");
      return { rows: [], packs: "", counts: {}, empty: true };
    }

    // Normalize map for schema safety
    const rows = SpellMapData.getMap().map(r => ({
      ...r,
      reagents: (r.reagents || []).map(x => ({
        ...x,
        reagentKey:
          x.reagentKey ??
          x.flags?.["reagent-tracker"]?.reagentKey ??
          null,
        priceInGP:
          x.priceInGP ??
          x.system?.priceInGP ??
          x.system?.price?.value ??
          null,
      })),
    }));

    const counts = {
      total: rows.length,
      unmapped: rows.filter(r => r.status === "unmapped").length,
      guessed: rows.filter(r => r.status === "guessed").length,
      confirmed: rows.filter(r => r.status === "confirmed").length,
      stale: rows.filter(r => r.status === "staleUUID").length,
    };

    return { rows, counts, empty: rows.length === 0 };
  }

  /* -------------------------------------------- */
  activateListeners(html) {
    super.activateListeners(html);

    // --- Core controls ------------------------------------------------------

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

    // --- Reagent Picker -----------------------------------------------------

    html.find("[data-action='pick-reagent']").on("click", async (ev) => {
      const idx = Number(ev.currentTarget.dataset.index);
      const rows = SpellMapData.getMap();
      const row = rows[idx];
      if (!row) return;

      const picked = await ReagentPicker.pick({ current: row });

      if (!picked) {
        // 🧹 De-linked
        rows[idx].reagents = [];
        rows[idx].status = "unmapped";
        ui.notifications.info(`Reagent link removed for "${row.spellNameCached}".`);
      } else {
        // ✅ Confirmed mapping using new schema fields
        rows[idx].reagents = [{
          reagentUUID: picked.reagentUUID ?? null,
          reagentNameCached: picked.reagentNameCached ?? null,
          reagentKey:
            picked.reagentKey ??
            picked.flags?.["reagent-tracker"]?.reagentKey ??
            null,
          priceInGP:
            picked.priceInGP ??
            picked.system?.priceInGP ??
            picked.system?.price?.value ??
            null,
          reagentType: picked.reagentType ?? "material",
          minCost: picked.minCost ?? null,
          quantity: picked.quantity ?? 1,
          consumed: picked.consumed ?? false,
        }];
        rows[idx].status = "confirmed";
        ui.notifications.info(`Reagent linked: "${picked.reagentNameCached}" → "${row.spellNameCached}".`);
      }

      await SpellMapData.setMap(rows);
      this.render(true);
    });

    // --- Row controls -------------------------------------------------------

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
  }

  /* -------------------------------------------- */
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
 *  SPELL MAP BUILDER (v31d unified → spellMap, full rebuild + alphabetical order)
 *  - Clears existing spellMap before rebuild
 *  - Includes ALL spells from configured packs
 *  - Sorts alphabetically by spell name
 *  - Reports scanned / added / errors / total
 * ------------------------------------------------------------------------------------------------- */
async function runSpellMapBuilder() {
  const packs = SpellMapData.packsToScan();
  if (!packs.length) {
    ui.notifications.warn(`${MODULE_ID}: No spell packs configured to scan.`);
    return {
      scanned: 0,
      added: 0,
      errors: 0,
      total: 0
    };
  }

  // 🧹 Clear old spellMap to ensure a true rebuild
  console.log(`[${MODULE_ID}] Clearing existing spellMap before rebuild...`);
  await SpellMapData.setMap([]); // flushes current entries
  const byUUID = new Map();

  let scanned = 0, added = 0, errors = 0;

  for (const key of packs) {
    try {
      const pack = game.packs.get(key);
      if (!pack) {
        console.warn(`[${MODULE_ID}] Pack not found: ${key}`);
        continue;
      }

      const docs = await pack.getDocuments();
      for (const doc of docs) {
        try {
          if (doc.type !== "spell") continue;
          scanned++;

          const mats = doc.system?.materials ?? {};
          const cost = Number(mats.cost || 0);
          const consumed = !!mats.consumed;

          const spellUUID = doc._stats?.compendiumSource ?? doc.uuid;
          const timestamp = new Date().toISOString();

          const entry = {
            spellUUID,
            spellNameCached: doc.name,
            spellPackCached: key,
            reagents: [],
            status: "unmapped",
            blockIfMissing: true,
            notes: "",
            lastChecked: timestamp,
            system: {
              materials: {
                cost,
                consumed,
                description: mats?.value ?? mats?.material ?? "",
              },
            },
          };

          byUUID.set(spellUUID, entry);
          added++;
        } catch (e) {
          console.error(`[${MODULE_ID}] Error processing spell in ${key}`, e);
          errors++;
        }
      }
    } catch (e) {
      console.error(`[${MODULE_ID}] Error scanning pack ${key}`, e);
      errors++;
    }
  }

  // --- Convert map to array and sort alphabetically by spell name
  const merged = Array.from(byUUID.values()).sort((a, b) =>
    a.spellNameCached.localeCompare(b.spellNameCached, undefined, { sensitivity: "base" })
  );

  await SpellMapData.setMap(merged);

  // 🧭 GM Whisper Summary
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `<div class="reagent-tracker-msg">
      🧭 <b>${MODULE_ID}</b>: Spell Map rebuilt (alphabetical).<br>
      Scanned: <b>${scanned}</b><br>
      Added: <b>${added}</b><br>
      Errors: <b>${errors}</b><br>
      Total: <b>${merged.length}</b>
    </div>`,
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
  });

  // Console summary
  console.log(
    `[${MODULE_ID}] Spell Map rebuild complete → scanned=${scanned}, added=${added}, errors=${errors}, total=${merged.length} (sorted alphabetically)`
  );
  ui.notifications.info(`✅ Spell Map rebuilt — ${merged.length} spells (sorted A→Z).`);

  return { scanned, added, errors, total: merged.length };
}


// ------------------------------------------------------------------------------------------------
// 🧭 Repair Compendium + Spell Map + Actor Items  (v31a unified → spellMap)
// ------------------------------------------------------------------------------------------------
async function repairReagentCompendium() {
  const pack = game.packs.get("world.reagents");
  if (!pack)
    return ui.notifications.warn("Reagent pack not found (expected world.reagents)");

  const docs = await pack.getDocuments();
  let fixedComp = 0, fixedMap = 0, fixedActors = 0;

  // --- STEP 1: Ensure every reagent in the compendium has a proper schema key ---
  for (const doc of docs) {
    const nameKey = doc.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_");

    const f = doc.flags?.["reagent-tracker"] ?? {};
    const oldKey = f.key ?? f.reagentKey ?? null;
    const needsKey = !oldKey || oldKey !== nameKey;

    if (needsKey) {
      await doc.setFlag("reagent-tracker", "reagentKey", nameKey);
      await doc.unsetFlag?.("reagent-tracker", "key"); // remove legacy key field
      fixedComp++;
      console.log(`[${MODULE_ID}] Compendium fixed: ${doc.name} → reagentKey=${nameKey}`);
    }

    // Optional normalization of extra fields
    const schemaDefaults = {
      reagentType: f.reagentType ?? "material",
      isLootable: f.isLootable ?? true,
      consumed: f.consumed ?? false,
    };
    for (const [k, v] of Object.entries(schemaDefaults)) {
      if (f[k] === undefined) await doc.setFlag("reagent-tracker", k, v);
    }
  }

  // --- STEP 2: Build canonical lookup map from compendium reagents ---
  const canonical = new Map();
  for (const d of docs) {
    const key = d.flags?.["reagent-tracker"]?.reagentKey ??
                d.flags?.["reagent-tracker"]?.key ??
                d.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_");
    canonical.set(d.name.toLowerCase(), key);
  }

  // --- STEP 3: Repair Spell Map reagent keys ---
  // v31a: use unified spellMap instead of spellReagentMap
  const map = game.settings.get(MODULE_ID, "spellMap") ?? [];
  for (const row of map) {
    if (!row.reagents?.length) continue;
    for (const g of row.reagents) {
      const nameKey = (g.reagentNameCached ?? "").toLowerCase();
      const correctKey = canonical.get(nameKey);
      if (correctKey && g.reagentKey !== correctKey) {
        console.log(
          `[${MODULE_ID}] Spell Map fixed: ${row.spellNameCached} reagentKey ${g.reagentKey} → ${correctKey}`
        );
        g.reagentKey = correctKey;
        fixedMap++;
      }
    }
  }

  await SpellMapData.setMap(map); // persists repaired spellMap

  // --- STEP 4: Repair actor-owned reagent items ---
  for (const actor of game.actors.contents ?? []) {
    for (const it of actor.items.contents ?? []) {
      const src = it._stats?.compendiumSource ?? "";
      if (!src.startsWith("Compendium.world.reagents.Item.")) continue;

      const nameKey = it.name.toLowerCase();
      const correctKey = canonical.get(nameKey);
      const currentKey =
        it.flags?.["reagent-tracker"]?.reagentKey ??
        it.getFlag?.("reagent-tracker", "reagentKey") ??
        it.getFlag?.("reagent-tracker", "key");

      if (correctKey && currentKey !== correctKey) {
        await it.setFlag("reagent-tracker", "reagentKey", correctKey);
        await it.unsetFlag?.("reagent-tracker", "key");
        fixedActors++;
        console.log(
          `[${MODULE_ID}] Actor fixed: ${actor.name} item ${it.name} → key=${correctKey}`
        );
      }
    }
  }

  ui.notifications.info(
    `Repaired ${fixedComp} compendium reagent(s), ${fixedMap} spell-map entry(ies), and ${fixedActors} actor item(s).`
  );

  return { fixedComp, fixedMap, fixedActors };
}

// -----------------------------------------------------------------------------
// 🌱 v32a Define helper function immediately (available globally to main.js)
// -----------------------------------------------------------------------------
async function applyAutoConsumeSetting() {
  const MODULE_ID = "reagent-tracker";
  try {
    const setting = game.settings.get(MODULE_ID, "autoConsumeOnCast");
    const spellMap = reagentTracker?.reagentIntel?.spellMap;
    if (!spellMap) {
      console.warn(`[${MODULE_ID}] Spell Map is undefined or null at init.`);
    } else {
      console.log(`[${MODULE_ID}] Spell Map object detected at init.`, spellMap);
      console.log(`[${MODULE_ID}] Spell Map keys:`, Object.keys(spellMap ?? {}));
      console.log(`[${MODULE_ID}] Spell Map type:`, Array.isArray(spellMap) ? "Array" : typeof spellMap);
    }

    const backupKey = "consumeBackup";

    if (setting === false) {
      const backup = {};
      for (const [spellId, entry] of Object.entries(spellMap)) {
        backup[spellId] = entry?.consumed ?? false;
        if (entry?.consumed) entry.consumed = false;
      }
      await game.settings.set(MODULE_ID, backupKey, JSON.stringify(backup));
      console.log(`[${MODULE_ID}] Auto-consume disabled: ${Object.keys(backup).length} entries backed up.`);
      return;
    }

    const backupJSON = game.settings.get(MODULE_ID, backupKey);
    if (backupJSON) {
      const backup = JSON.parse(backupJSON);
      let restored = 0;
      for (const [spellId, consumeFlag] of Object.entries(backup)) {
        if (spellMap[spellId]) {
          spellMap[spellId].consumed = consumeFlag;
          restored++;
        }
      }
      await game.settings.set(MODULE_ID, backupKey, "");
      console.log(`[${MODULE_ID}] Auto-consume re-enabled: restored ${restored} entries.`);
    }
  } catch (err) {
    console.error(`[${MODULE_ID}] Error applying AutoConsume setting:`, err);
  }
}



// ------------------------------------------------------------------------------------------------
// 🧩 registerSettings (v31a unified)
// ------------------------------------------------------------------------------------------------
function registerSettings() {

    //Removing the option of which compendium pack to use
    game.settings.register(MODULE_ID, "compendiumPacks", {
    scope: "world",
    config: false,
    type: String,
    default: "world.reagents"
  });


  // --- Unified persistent spell map (replaces spellReagentMap) -------------
  game.settings.register(MODULE_ID, "spellMap", {
    name: "Spell→Reagent Map (World)",
    scope: "world", config: false, type: Object, default: []
  });

  game.settings.register(MODULE_ID, "spellPacksToScan", {
    name: "Spell Packs to Scan",
    hint: "Comma-separated compendium keys (e.g., 'dnd5e.spells,my-pack.spells').",
    scope: "world", config: true, type: String, default: "dnd5e.spells"
  });


  // ---AutoConsumeOnCast checkbox-----------------------------------
  game.settings.register(MODULE_ID, "autoConsumeOnCast", {
    name: "Auto-consume reagents on cast",
    hint:
      "When disabled, reagent consumption is turned off globally. " +
      "Re-enabling will restore your previous consume states (if a backup exists).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,

    onChange: async (value) => {
      try {
        const prev = game.settings.get(MODULE_ID, "autoConsumeLastState");
        await game.settings.set(MODULE_ID, "autoConsumeLastState", value);
        await reagentTracker.applyAutoConsumeChange(value, prev);
      } catch (err) {
        console.error(`[${MODULE_ID}] Error calling applyAutoConsumeChange:`, err);
      }
    }
  });

  // --- Hidden tracking of previous Auto-Consume state --------------
  game.settings.register(MODULE_ID, "autoConsumeLastState", {
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });



  // --- Menu: Open Spell Map ------------------------------------------------
  game.settings.registerMenu(MODULE_ID, "openSpellMap", {
    name: "Open Spell Map",
    label: "Open Spell Map",
    icon: "fas fa-wand-sparkles",
    type: SpellMapManager,
    restricted: true
  });

  // --- Menu: Build Spell Map ----------------------------------------------
  game.settings.registerMenu(MODULE_ID, "openSpellMapBuilder", {
    name: "Build Spell Map",
    label: "Build Spell Map",
    icon: "fas fa-hammer",
    type: class SpellMapBuilderButton extends FormApplication {
      async render() {
        ui.notifications.info("Building Spell Map...");
        const res = await runSpellMapBuilder();
        ui.notifications.info(
          `✅ Spell Map rebuild complete — scanned ${res.scanned}, added ${res.added}, skipped ${res.skipped}, total ${res.total}.`
        );
      }
    },
    restricted: true
  });

  // --- Menu: Build Reagent Compendium -------------------------------------
  game.settings.registerMenu(MODULE_ID, "openReagentCompendiumBuilder", {
    name: "Repair Reagent Compendium",
    label: "Repair Data Sources",
    icon: "fas fa-boxes-stacked",
    type: class ReagentCompendiumBuilderButton extends FormApplication {
      async render() {
        ui.notifications.info("Rebuilding Reagent Compendium...");
        await repairReagentCompendium();  // existing repair / builder function
        ui.notifications.info("Reagent Compendium rebuild complete.");
      }
    },
    restricted: true
  });
}

/* -------------------------------------------------------------------------------------------------
 *  MENU CLASS (separate to avoid brace confusion)
 * ------------------------------------------------------------------------------------------------- */
class BuildReagentCompendiumMenu extends FormApplication {
  async render(...args) {
    const confirmed = await Dialog.confirm({
      title: "Rebuild Reagent Compendium?",
      content: `
        <p>This will <b>overwrite</b> your existing
        <i>world.reagents</i> compendium with default reagent entries.</p>
        <p>Are you sure?</p>`
    });
    if (!confirmed) return;
    await buildDefaultReagentCompendium();
    // Optional: close the menu sheet if Foundry opened one
    try { return super.render(...args); } catch (_) { /* noop */ }
  }
}

/* -------------------------------------------------------------------------------------------------
 *  INITIALIZATION HOOKS
 * ------------------------------------------------------------------------------------------------- */
Hooks.once("init", () => {
  // Register settings first
  registerSettings();

  // Add the “Build Default Compendium” menu entry
  game.settings.registerMenu(MODULE_ID, "buildDefaultCompendium", {
    name: "Build Default Compendium",
    label: "Build Compendium",
    icon: "fas fa-flask",
    hint: "Creates or overwrites the 'world.reagents' compendium with default reagent items.",
    type: BuildReagentCompendiumMenu,
    restricted: true
  });
});

Hooks.once("ready", () => {
  globalThis.repairReagentCompendium = repairReagentCompendium;
  game.reagentTrackerRepair = repairReagentCompendium;
});

/* =====================================================================================
 *  Build or Reset the world.reagents Compendium from default-reagents.json (Foundry v13+)
 * ===================================================================================== */
async function buildDefaultReagentCompendium() {
  try {
    const packId = "world.reagents";
    let pack = game.packs.get(packId);

    // 🟩 Create compendium if it doesn't exist
    if (!pack) {
      ui.notifications.info(`Creating ${packId} compendium...`);
      await CompendiumCollection.createCompendium({
        type: "Item",
        label: "Reagents",
        name: "reagents",
        package: "world"
      });
      pack = game.packs.get(packId);
    }

    // 🟨 Confirm Overwrite
    const docs = await pack.getDocuments().catch(() => []);
    if (docs.length > 0) {
      const confirm = await Dialog.confirm({
        title: "Overwrite Existing Reagents?",
        content: `<p>This will delete <b>${docs.length}</b> items currently in <i>${packId}</i>.</p>`
      });
      if (!confirm) return;

      // 🧹 True Physical Clear (v13+ Safe)
      console.log(`[${MODULE_ID}] Deleting ${docs.length} documents...`);
      await pack.documentClass.deleteDocuments(docs.map(d => d.id), { pack: pack.metadata.id });
      await pack.getIndex({ reload: true });

      // Foundry v13+ compatibility: safely clear cached docs if API present
      if (typeof pack.clear === "function") {
        await pack.clear();
        console.log(`[${MODULE_ID}] ${packId} cache cleared via pack.clear()`);
      } else if (pack.documentCache && typeof pack.documentCache.clear === "function") {
        pack.documentCache.clear();
        console.log(`[${MODULE_ID}] ${packId} cache cleared via documentCache.clear()`);
      }

      console.log(`[${MODULE_ID}] ${packId} cleared.`);

    }

    // 📦 Load Default Reagent Data
    const dataUrl = `modules/${MODULE_ID}/data/default-reagents.json`;
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error(`Failed to load ${dataUrl}`);
    const items = await res.json();

    // 🧭 Import and Normalize
    let importedCount = 0;
    for (const raw of items) {
      try {
        const r = foundry.utils.duplicate(raw);
        const flags = r.flags?.[MODULE_ID] ?? r.flags?.["reagent-tracker"] ?? {};

        const nameKey = r.name?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_") ?? "reagent";
        const reagentKey = flags.reagentKey ?? `${nameKey}_`;

        r.flags = {
          ...(r.flags ?? {}),
          [MODULE_ID]: {
            reagentKey,
            reagentType: flags.reagentType ?? "material",
            isLootable: flags.isLootable ?? true,
            consumed: flags.consumed ?? true
          }
        };

        // Remove legacy sourceId (v13 deprecated)
        if (r.flags?.core?.sourceId) delete r.flags.core.sourceId;

        await pack.importDocument(new Item.implementation(r));
        importedCount++;
      } catch (innerErr) {
        console.warn(`[${MODULE_ID}] Failed to import reagent`, raw?.name, innerErr);
      }
    }

    ui.notifications.info(`✅ Imported ${importedCount} reagents into ${packId}.`);
    console.log(`[${MODULE_ID}] Rebuilt ${packId} with ${importedCount} reagents.`);

    // 🔍 Verification Pass
    const rebuiltDocs = await pack.getDocuments();
    for (const d of rebuiltDocs) {
      const f = d.flags?.[MODULE_ID] ?? d.flags?.["reagent-tracker"] ?? {};
      if (!f.reagentKey) {
        const fallbackKey = d.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_") + "_";
        await d.update({ [`flags.${MODULE_ID}.reagentKey`]: fallbackKey });
        console.log(`[${MODULE_ID}] Added missing reagentKey to ${d.name} → ${fallbackKey}`);
      }
    }

    console.log(`[${MODULE_ID}] buildDefaultReagentCompendium completed successfully.`);
  } catch (err) {
    console.error(`[${MODULE_ID}] buildDefaultReagentCompendium error:`, err);
    ui.notifications.error("❌ Failed to build reagent compendium. See console for details.");
  }
}

// Test for final load verification:
console.log("✅ main.js loaded without syntax errors");
