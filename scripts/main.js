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

Hooks.once("ready", async () => {
  const mod = game.modules.get(MODULE_ID);
  console.log("[reagent-tracker] Hook ready fired!");
  if (mod) {
    mod.api = {
      ...(mod.api ?? {}),
      setTable: (rows) => ReagentData.setTable(rows),
      getSpellMap: () => SpellMapData.getMap(),
      setSpellMap: (rows) => SpellMapData.setMap(rows),
      runSpellMapBuilder,
      openSpellMap: () => new SpellMapManager().render(true),
      repairReagentCompendium,

      _postPreambleRegistered: mod.api?._postPreambleRegistered ?? false
    };

    // 🔗 Global bindings
    globalThis.reagentTracker = {
      ...(globalThis.reagentTracker ?? {}),
      ...mod.api
    };
    globalThis.runSpellMapBuilder = runSpellMapBuilder;
    globalThis.reagentTracker.enforceReagents = enforceReagents;
    globalThis.reagentTracker.hasReagentsSync = hasReagentsSync;
    globalThis.reagentTracker.consumeReagentFromInventory = consumeReagentFromInventory

    // 🔗 Also attach the reagentIntel subsystem if not already initialized
    if (globalThis.reagentTracker?.reagentIntel) {
      globalThis.reagentTracker.reagentIntel.findUpgradedReagentOnActor = findUpgradedReagentOnActor;
      console.log(`[${MODULE_ID}] reagentIntel upgrade finder attached successfully (existing subsystem).`);
    } else {
      globalThis.reagentTracker.reagentIntel = { findUpgradedReagentOnActor };
      console.log(`[${MODULE_ID}] reagentIntel subsystem created and upgrade finder attached.`);

    }
  }


  // =============================================================
  //  REAGENT ENFORCEMENT (sync + async from intel cache)
  // =============================================================

  function hasReagentsSync(actor, item) {
  try {
    if (!actor || !item) return true;

    const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
    if (!intel) return true; // cache not ready → fail open

    const spellState = intel.spells?.[item.id];
    if (!spellState) return true; // spell not mapped

    // --- Determine availability by reagentKey first, then by upgrade name
    const key = spellState.reagentKey;
    const hasByKey = key && actor.items.some(i => i.getFlag(MODULE_ID, "reagentKey") === key);
    const hasByUpgrade = spellState.hasUpgrade && !!actor.items.get(spellState.upgrade?.itemId);

    if (hasByKey || hasByUpgrade) return true;

    console.warn(`[reagent-tracker] ${actor.name} lacks reagent for ${item.name}`);
    return false;
  } catch (err) {
    console.error("[reagent-tracker] hasReagentsSync error", err);
    return true;
  }
}


// =====================================================================================
//  PROMPT USE HIGHER VALUE — cache-aware version (GM + Player compatible)
// =====================================================================================
  async function promptUseHigherValue(actor, item, upgraded) {
    try {
      const speaker = ChatMessage.getSpeaker({ actor });
      const upgradeName = upgraded?.itemName ?? upgraded?.item?.name ?? "(unknown)";
      const valueGP = upgraded?.valueGP ?? "?";
      const baseCost = upgraded?.minCost ?? 0;

      const content = `
        <div class="reagent-tracker-prompt" style="padding:.5rem;">
          💎 <b>${actor.name}</b> has a more valuable reagent available for <b>${item.name}</b>:<br>
          <b>${upgradeName}</b> (${valueGP} gp) vs minimum ${baseCost} gp.<br><br>
          Use it to cast the spell?<br><br>
          <button class="rt-accept" style="background:#4a7350;color:white;padding:.25rem .75rem;border:none;border-radius:4px;margin-right:.5rem;">✅ Use</button>
          <button class="rt-decline" style="background:#a33;color:white;padding:.25rem .75rem;border:none;border-radius:4px;">❌ Decline</button>
        </div>`;

      // 🧩 Avoid duplicate prompts when Midi-QOL echoes chat message creation
      if (game.modules.get("midi-qol")?.active) {
        const stack = (new Error()).stack ?? "";
        if (/preCreateChatMessage/i.test(stack) && /midi-qol/i.test(stack)) {
          console.debug(`[${MODULE_ID}] Skipping prompt creation inside Midi-QOL preCreateChatMessage`);
          return null;
        }
      }

      // Wait a brief moment to let Midi initialize workflow chat
      await new Promise(r => setTimeout(r, 250));

      // --- Build chat prompt ---
      const chatData = {
        speaker,
        content,
        whisper: [],          // visible to all (GM + players)
        flags: { [MODULE_ID]: { isPrompt: true } }
      };

      console.log(`[${MODULE_ID}] promptUseHigherValue → awaiting response for ${actor.name} ${item.name}`);
      const chat = await ChatMessage.create(chatData, {});
      console.log(`[${MODULE_ID}] promptUseHigherValue message created id=${chat.id}`);

      // Wait for it to appear in DOM
      await new Promise(r => setTimeout(r, 300));
      const html = document.querySelector(`[data-message-id="${chat.id}"]`);
      console.log(`[${MODULE_ID}] promptUseHigherValue found html=${!!html}`);

      // --- Button handling ---
      if (html) {
        const acceptBtn = html.querySelector(".rt-accept");
        const declineBtn = html.querySelector(".rt-decline");

        const safeDelete = async () => {
          await new Promise(r => setTimeout(r, 200));
          try { await chat.delete(); } catch (err) { /* ignore */ }
        };

        if (acceptBtn) {
          acceptBtn.addEventListener("click", ev => {
            ev.preventDefault();
            console.log(`[${MODULE_ID}] ACCEPT clicked for ${chat.id}`);
            Hooks.callAll(`rtPrompt:${chat.id}`, { ok: true, upgraded });
            safeDelete();
          });
        }

        if (declineBtn) {
          declineBtn.addEventListener("click", ev => {
            ev.preventDefault();
            console.log(`[${MODULE_ID}] DECLINE clicked for ${chat.id}`);
            Hooks.callAll(`rtPrompt:${chat.id}`, { ok: false });
            safeDelete();
          });
        }
      }

      // --- Wait for result (one-time hook) ---
      return new Promise(resolve => {
        Hooks.once(`rtPrompt:${chat.id}`, result => resolve(result));
      });

    } catch (err) {
      console.error(`[${MODULE_ID}] promptUseHigherValue error`, err);
      return { ok: false };
    }
  }

  // --- Debounced notification helper (prevents double toasts) ---
  let _rtToastShown = false;
  function safeNotify(type, msg, timeout = 900) {
    if (_rtToastShown) return;
    _rtToastShown = true;
    ui.notifications[type](msg);
    setTimeout(() => { _rtToastShown = false; }, timeout);
  }

  // --- Asynchronous reagent enforcement using cached intel ---
  async function enforceReagents(wf) {
    try {
      const actor = wf?.actor;
      const item  = wf?.item;
      if (!actor || !item) return true;

      const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
      const spellState = intel?.spells?.[item.id];

      if (!spellState) {
        console.log(`[reagent-tracker] ${item.name} → no cached reagent data`);
        return true; // nothing to enforce
      }

      const { hasExact, hasUpgrade, missing, upgrade, reagentKey } = spellState;
      console.log(`[reagent-tracker] enforceReagents → ${actor.name} ${item.name} | exact=${hasExact}, upgrade=${hasUpgrade}`);

      // --- Reuse any prior prompt approval
      if (wf.rtApprovedUpgrade) {
        console.log(`[reagent-tracker] using previously approved upgrade: ${wf.rtApprovedUpgrade.itemName}`);
        return true;
      }

    // --- No exact reagent, but an upgrade is available → prompt
    if (!hasExact && hasUpgrade && upgrade) {
      if (wf.rtPromptOpen) {
        console.log(`[reagent-tracker] prompt already open — waiting`);
        return false;
      }

      wf.rtPromptOpen = true;
      const upgraded = {
        item: actor.items.get(upgrade.itemId),
        valueGP: upgrade.valueGP,
        reagentKey
      };

      const res = await promptUseHigherValue(actor, item, upgraded);
      wf.rtPromptOpen = false;

      if (res?.ok && res?.upgraded) {
        wf.rtApprovedUpgrade = res.upgraded;
        console.log(`[reagent-tracker] upgrade approved: ${res.upgraded.item?.name}`);
        return true;
      }

      console.warn(`[reagent-tracker] ${item.name} was not cast — user declined higher-value reagent.`);
      return false;
    }

    // --- No reagent at all → block
    if (missing) {
      console.warn(`[reagent-tracker] ${item.name} missing required reagents — spell blocked.`);
      return false;
    }

      return true;
    } catch (err) {
      console.error("[reagent-tracker] enforceReagents (cache) error", err);
      return true; // fail open on error
    }
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

// =====================================================================================
//  CONSUMPTION LOGIC — Unified handler for reagent usage after successful spell cast
// =====================================================================================
async function consumptionLogic(wf) {
  try {
    const actor = wf?.actor;
    const item  = wf?.item;
    if (!actor || !item) return true;

    const intel = reagentTracker.reagentIntel?.cache?.get(actor.id);
    if (!intel) return true;

    const spellEntry = intel.spells?.[item.id];
    if (!spellEntry) {
      console.log(`[reagent-tracker] ${item.name} → not reagent-linked or cache missing`);
      return true;
    }

    // Guard: if missing, nothing to consume
    if (spellEntry.missing || spellEntry.hasMissing) {
      console.log(`[reagent-tracker] ${actor.name} ${item.name} skipped consumption (missing reagent).`);
      return true;
    }

    // --- Decide which reagent to consume
    let reagentItem = null;
    let logLabel = "(unknown)";

    // 1. If the player approved an upgrade
    if (wf?.rtApprovedUpgrade && spellEntry.upgrade) {
      const upName = spellEntry.upgrade.itemName?.toLowerCase() ?? "";
      reagentItem =
        actor.items.get(spellEntry.upgrade.itemId) ||
        actor.items.find(i => i.name.toLowerCase() === upName);
      logLabel = spellEntry.upgrade.itemName ?? "(upgrade)";
      console.log(`[reagent-tracker] ${actor.name} ${item.name} consuming approved upgrade.`);
    }

    // 2. Otherwise, consume standard reagent by key first
    else if (spellEntry.hasExact && spellEntry.reagentKey) {
      reagentItem = actor.items.find(
        i => i.getFlag(MODULE_ID, "reagentKey") === spellEntry.reagentKey
      );
      logLabel = reagentItem?.name ?? spellEntry.reagentKey;
      console.log(`[reagent-tracker] ${actor.name} ${item.name} consuming standard reagent.`);
    }

    // 3. Otherwise, skip (e.g. upgrade exists but not approved)
    else if (spellEntry.hasUpgrade && !wf?.rtApprovedUpgrade) {
      console.log(`[reagent-tracker] ${actor.name} ${item.name} skipped consumption (upgrade available but not used).`);
      return true;
    }

    if (!reagentItem) {
      console.warn(`[reagent-tracker] ${actor.name} ${item.name} could not locate reagent item — skipping consumption.`);
      return true;
    }


    // Double-consume guard (workflow-scoped)
    const guardKey = `${actor.id}:${item.id}:${wf?.uuid || wf?.id}`;
    if (_castConsumeGuards.has(guardKey)) {
      console.log(`[reagent-tracker] duplicate consumption guard for ${item.name} — skipping.`);
      return true;
    }
    _castConsumeGuards.add(guardKey);

    // --- Perform consumption
    const qtyNeeded = spellEntry.quantity ?? 1;
    const res = await consumeReagentFromInventory(actor, reagentItem, qtyNeeded);

    console.log(
      `[reagent-tracker] CONSUME ${actor.name} ${item.name}: ${logLabel} → used ${res.consumed} (updates=${res.updates}, deleted=${res.deleted})`
    );

    // Refresh intel after inventory mutation
    setTimeout(() => {
      try {
        reagentTracker.reagentIntel.buildActorReagentState(actor);
        console.log(`[reagent-tracker] Auto-refreshed reagent intel for ${actor.name} after ${item.name}`);
      } catch (err) {
        console.warn(`[reagent-tracker] intel refresh failed after ${actor.name} cast ${item.name}`, err);
      }
    }, 400);

    // Clear any approved upgrade pointer to avoid bleed-over
    if (wf) wf.rtApprovedUpgrade = null;

    return true;
  } catch (err) {
    console.error("[reagent-tracker] consumptionLogic error", err);
    return true; // fail open
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

    // Resolve an Item5e to consume:
    // - If reagentOrItem is an Item, use it directly
    // - Else, try to find by reagentKey on the actor (first match)
    let itemDoc = null;

    // Case A: passed an Item directly
    if (reagentOrItem?.document || reagentOrItem?.type) {
      // Item-like object
      const id = reagentOrItem.id ?? null;
      itemDoc = id ? actor.items.get(id) : reagentOrItem;
    }

    // Case B: passed a cached reagent object (upgrade or base) with an itemId
    if (!itemDoc && reagentOrItem?.itemId) {
      itemDoc = actor.items.get(reagentOrItem.itemId);
    }

    // Case C: passed a reagent descriptor with a reagentKey flag
    if (!itemDoc && reagentOrItem?.reagentKey) {
      itemDoc = actor.items.find(i => i.getFlag(MODULE_ID, "reagentKey") === reagentOrItem.reagentKey);
    }

    if (!itemDoc) {
      console.warn("[reagent-tracker] consumeReagentFromInventory could not resolve inventory item to consume.");
      return { consumed: 0, updates: 0, deleted: 0 };
    }

    const name = itemDoc.name ?? (reagentOrItem.name || reagentOrItem.reagentNameCached || reagentOrItem.reagentKey || "(reagent)");
    const current = Number(itemDoc.system?.quantity ?? 0) || 0;
    if (current <= 0) {
      console.warn(`[reagent-tracker] ${name} has quantity 0 — nothing to consume.`);
      return { consumed: 0, updates: 0, deleted: 0 };
    }

    const take = Math.min(qty, current);
    const newQty = current - take;

    if (newQty > 0) {
      await actor.updateEmbeddedDocuments("Item", [{ _id: itemDoc.id, "system.quantity": newQty }]);
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

  // --- 2) dnd5e: block synchronously right at click ----------------------
  Hooks.on("dnd5e.preUseActivity", (activity, config, options) => {
    const item = activity?.item;
    const actor = item?.actor;
    if (!actor || !item) return true;

    // HARD SYNC GATE — no async/await here
    const ok = hasReagentsSync(actor, item);
    if (!ok) {
      console.warn(`[reagent-tracker] ${item.name} blocked by reagent check (preUseActivity sync)`);
      ui.notifications.warn(`${item.name} was not cast — you lack the required material components.`);

      // If a workflow is already attached, try to freeze it
      try {
        const wf = config?.workflow ?? item?.workflow ?? activity?.workflow;
        if (wf) {
          wf.aborted = true;
          wf.suspended = true;
          wf._aborted = true; // older code paths still peek at this
        }
      } catch (e) {
        console.warn("[reagent-tracker] could not mark workflow aborted/suspended", e);
      }

      // Optionally kick off the full async enforcement just for logging/UX
      // (don’t await)
      try { reagentTracker.enforceReagents(actor, item, config); } catch (_) {}

      return false; // ← IMPORTANT: cancel immediately
    }

    return true;
  });

  Hooks.on("midi-qol.preItemRollV2", async (wrapper) => {
    try {
      // 🧩 Unwrap if nested inside .workflow
      const wf = wrapper?.workflow ?? wrapper;
      const wfKeys = Object.keys(wf ?? {});
      console.log(`[reagent-tracker] midi-qol.preItemRollV2 triggered`, wf);
      console.log(`[reagent-tracker] workflow keys:`, wfKeys);

      const item = wf?.item;
      const actor = wf?.actor;
      const actName = wf?.activity?.name ?? "(no activity)";
      const itemName = item?.name ?? "(no item)";
      const actorName = actor?.name ?? "(no actor)";

      if (!item || !actor) {
        console.warn(`[reagent-tracker] preItemRollV2 fired with missing item/actor — activity=${actName}`);
        return true;
      }

      if (item?.type !== "spell") {
        console.log(`[reagent-tracker] preItemRollV2 skipping non-spell item: ${itemName}`);
        return true;
      }

      // 🟢 EARLY BYPASS — recast from higher reagent acceptance
      const recastFlag = await item.getFlag(MODULE_ID, "recastFromPrompt");
      if (recastFlag) {
        await item.unsetFlag(MODULE_ID, "recastFromPrompt");
        console.log(`[reagent-tracker] bypass: recastFromPrompt for ${itemName}`);
        return true; // ✅ allow cast to proceed unblocked
      }

      console.log(`[reagent-tracker] preItemRollV2 valid — ${actorName} casting ${itemName}`);

      // 🧮 Enforce reagent requirements
      const ok = await reagentTracker.enforceReagents(wf);  // pass workflow, not item/actor
      console.log(`[reagent-tracker] enforceReagents(${itemName}) returned:`, ok);

      if (ok) return true; // ✅ allow when reagents are satisfied

      // 🚫 Spell blocked due to missing reagents
      console.warn(`[reagent-tracker] ${itemName} blocked by reagent check (midi-qol.preItemRollV2)`);
      ui.notifications.warn(`${itemName} was not cast — you lack the required material components.`);

      // Suspend & prevent consumption
      wf.aborted = wf.suspended = wf._aborted = wf._suspended = true;
      wf.config = wf.config || {};
      wf.config.consumeSpellSlot = false;
      wf.config.consumeResource = false;
      wf.config.consumeUsage = false;

      console.log(`[reagent-tracker] workflow aborted/suspended for ${itemName}`);
      return false; // 🔴 stop the workflow
    } catch (err) {
      console.error("[reagent-tracker] Error in midi-qol.preItemRollV2", err);
      return true; // fail open
    }
  });

  // --- Consume reagent (upgrade or normal) after successful cast, then refresh intel -------------
  Hooks.on("midi-qol.postRollFinished", async (wf) => {
    try {
      await consumptionLogic(wf);
    } catch (err) {
      console.error("[reagent-tracker] postRollFinished error", err);
    } finally {
      _castConsumeGuards.clear();
      console.log(`[reagent-tracker] cleared consumption guards after workflow ${wf?.item?.name ?? wf?.id}`);
    }
  });



  console.log("[reagent-tracker] Just before _rtBackfill!");

  // ------------------------------------------------------------------------------------------------
  // 🔧 Ready-time reagent key finalization
  // ------------------------------------------------------------------------------------------------
  async function _rtBackfillReagentKeyFromCompSource(item) {
    try {
      if (!(item?.parent instanceof Actor)) return false;
      const src = item._stats?.compendiumSource ?? "";
      if (!src.startsWith("Compendium.world.reagents.Item.")) return false;

      const already = item.getFlag(MODULE_ID, "reagentKey");
      if (already) return true;

      const parts = src.split(".");
      const packId = `${parts[1]}.${parts[2]}`;
      const compId = parts[4];
      const pack = game.packs.get(packId);
      if (!pack) return false;
      const doc = await pack.getDocument(compId);
      if (!doc) return false;

      const reagentKey = doc.getFlag(MODULE_ID, "key");
      const reagentUUID = doc.uuid;
      if (!reagentKey) return false;

      await item.parent.updateEmbeddedDocuments("Item", [
        {
          _id: item.id,
          [`flags.${MODULE_ID}.reagentKey`]: reagentKey,
          [`flags.${MODULE_ID}.reagentUUID`]: reagentUUID
        }
      ]);
      console.log(`[${MODULE_ID}] linked '${item.name}' → key=${reagentKey}, uuid=${reagentUUID}`);
      return true;
    } catch (e) {
      console.warn(`[${MODULE_ID}] backfill reagent key failed`, e);
      return false;
    }
  }

  // ---- Hook: when a new embedded Item is created, defer and backfill the key
  Hooks.on("createItem", (item, _opts, _userId) => {
    if (!(item?.parent instanceof Actor)) return;
    setTimeout(() => _rtBackfillReagentKeyFromCompSource(item), 300);
  });

  // ---- One-time sweep on ready
  console.log("[reagent-tracker] ... starting ready-time backfill sweep");
  const actors = game.actors.contents ?? [];
  let fixedCount = 0;
  for (const actor of actors) {
    for (const item of actor.items.contents ?? []) {
      const src = item._stats?.compendiumSource ?? "";
      if (src.startsWith("Compendium.world.reagents.Item.")) {
        const ok = await _rtBackfillReagentKeyFromCompSource(item);
        if (ok) fixedCount++;
      }
    }
  }

  console.log(`[${MODULE_ID}] Ready-time reagent key backfill complete — ${fixedCount} item(s) linked.`);
});


/* -------------------------------------------------------------------------------------------------
 *  DATA ACCESS LAYERS
 * ------------------------------------------------------------------------------------------------- */

const SpellMapData = (globalThis.SpellMapData && typeof globalThis.SpellMapData.getMap === "function")
  ? globalThis.SpellMapData
  : {
      getMap: () => game.settings.get(MODULE_ID, "spellReagentMap") ?? [],

      // --- Enhanced setter: also emit update hook
      setMap: async (rows) => {
        const arr = Array.isArray(rows) ? rows : [];
        await game.settings.set(MODULE_ID, "spellReagentMap", arr);

        // 🔔 Notify all listeners (e.g. reagentIntel) that Spell Map has changed
        Hooks.callAll(`${MODULE_ID}.spellMapUpdated`, arr);

        console.log(`[${MODULE_ID}] Spell Map updated → ${arr.length} entries`);
        return arr;
      },

      packsToScan: () => {
        const raw = game.settings.get(MODULE_ID, "spellPacksToScan") ?? "";
        return String(raw).split(",").map(s => s.trim()).filter(Boolean);
      }
    };

function getConfiguredPacks() {
  const raw = game.settings.get(MODULE_ID, "compendiumPacks") ?? "";
  return String(raw).split(",").map(s => s.trim()).filter(Boolean);
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

    // --- Core controls ------------------------------------------------------

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

    if (this.isGM) {
      html.find("button.repair-compendium").on("click", async () => {
        const repaired = await reagentTracker.repairReagentCompendium();
        ui.notifications.info(`Repaired ${repaired} reagent(s) in world.reagents.`);
      });
    }

    // --- 🧩 NEW: Per-spell and select-all blocking toggles ------------------

    // Per-row checkbox toggle
    html.find("input[data-action='toggle-block']").on("change", async (ev) => {
      const idx = Number(ev.currentTarget.dataset.index);
      const rows = SpellMapData.getMap();
      if (!rows[idx]) return;
      rows[idx].blockIfMissing = ev.currentTarget.checked;
      await SpellMapData.setMap(rows);
    });

    // Top "select all" checkbox
    html.find("input[data-action='toggle-block-all']").on("change", async (ev) => {
      const checked = ev.currentTarget.checked;
      const rows = SpellMapData.getMap();
      for (const r of rows) r.blockIfMissing = checked;
      await SpellMapData.setMap(rows);
      // visually update all visible checkboxes
      html.find("input[data-action='toggle-block']").prop("checked", checked);
    });
  }

  // --- Filtering logic (unchanged) -----------------------------------------
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
 *  SPELL MAP BUILDER (v28 updated)
 *  - Uses _stats.compendiumSource (preferred stable ID)
 *  - Falls back to doc.uuid if missing (non-compendium spells)
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
          const costly = Number(mats.cost || 0) > 0;
          const consumed = !!mats.consumed;
          if (!(costly || consumed)) { skipped++; continue; }

          // --- Determine canonical spell identifier
          const spellUUID = doc._stats?.compendiumSource ?? doc.uuid;

          const entry = {
            spellUUID,
            spellNameCached: doc.name,
            spellPackCached: key,
            reagents: [],
            status: "unmapped",
            blockIfMissing: true,
            notes: "",
            lastChecked: new Date().toISOString()
          };

          if (!byUUID.has(spellUUID)) {
            byUUID.set(spellUUID, entry);
            added++;
          } else {
            const prev = byUUID.get(spellUUID);
            prev.spellNameCached = doc.name;
            prev.spellPackCached = key;
            prev.lastChecked = new Date().toISOString();
            byUUID.set(spellUUID, prev);
          }
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

  const merged = Array.from(byUUID.values());
  await SpellMapData.setMap(merged);

  // 🧭 GM whisper summary (non-spammy)
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `<div class="reagent-tracker-msg">
      🧭 <b>${MODULE_ID}</b>: Scanned ${scanned} spells; added <b>${added}</b>,
      skipped ${skipped}, errors ${errors}. Total entries: ${merged.length}.
    </div>`,
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id)
  });

  console.log(`[${MODULE_ID}] Spell Map builder complete — scanned=${scanned}, added=${added}, skipped=${skipped}, total=${merged.length}`);
  return { scanned, added, skipped, errors, total: merged.length };
}


// Expose for console / UI access
game.reagentTrackerRepair = repairReagentCompendium;

// ------------------------------------------------------------------------------------------------
// 🧭 Repair Compendium + Spell Map + Actor Items
// ------------------------------------------------------------------------------------------------
async function repairReagentCompendium() {
  const pack = game.packs.get("world.reagents");
  if (!pack) return ui.notifications.warn("Reagent pack not found (expected world.reagents)");

  const docs = await pack.getDocuments();
  let fixedComp = 0, fixedMap = 0, fixedActors = 0;

  // --- STEP 1: Ensure every reagent in the compendium has a key ---
  for (const doc of docs) {
    let existing = doc.getFlag("reagent-tracker", "key");
    const expected = doc.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_");
    if (!existing || existing !== expected) {
      await doc.setFlag("reagent-tracker", "key", expected);
      console.log(`[${MODULE_ID}] Compendium fixed: ${doc.name} → key=${expected}`);
      fixedComp++;
      existing = expected;
    }
  }

  // Build quick lookup of canonical keys by reagent name
  const canonical = new Map();
  for (const d of docs) {
    canonical.set(d.name.toLowerCase(), d.getFlag("reagent-tracker", "key"));
  }

  // --- STEP 2: Repair spell-map reagent keys ---
  const map = game.settings.get(MODULE_ID, "spellReagentMap") ?? [];
  for (const row of map) {
    if (!row.reagents?.length) continue;
    for (const g of row.reagents) {
      const nameKey = (g.reagentNameCached ?? "").toLowerCase();
      const correctKey = canonical.get(nameKey);
      if (correctKey && g.reagentKey !== correctKey) {
        console.log(`[${MODULE_ID}] Spell map fixed: ${row.spellNameCached} reagentKey ${g.reagentKey} → ${correctKey}`);
        g.reagentKey = correctKey;
        fixedMap++;
      }
    }
  }

  // ✅ Use SpellMapData.setMap() instead of direct settings.set()
  await SpellMapData.setMap(map);

  // --- STEP 3: Repair actor-owned reagent items ---
  for (const actor of game.actors.contents ?? []) {
    for (const it of actor.items.contents ?? []) {
      const src = it._stats?.compendiumSource;
      if (!src?.startsWith("Compendium.world.reagents.Item.")) continue;
      const nameKey = it.name.toLowerCase();
      const correctKey = canonical.get(nameKey);
      const currentKey = it.getFlag(MODULE_ID, "reagentKey");
      if (correctKey && currentKey !== correctKey) {
        await it.setFlag(MODULE_ID, "reagentKey", correctKey);
        console.log(`[${MODULE_ID}] Actor fixed: ${actor.name} item ${it.name} → key=${correctKey}`);
        fixedActors++;
      }
    }
  }

  ui.notifications.info(
    `Repaired ${fixedComp} compendium key(s), ${fixedMap} spell-map entry(ies), and ${fixedActors} actor item(s).`
  );
  return { fixedComp, fixedMap, fixedActors };
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
