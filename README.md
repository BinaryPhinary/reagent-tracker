
---

## 🧭 Getting Started
1. **Install and enable** the module in your world.
2. Go to **Game Settings** and then **Configure Settings**.  Find the reagent-tracker module in the list
3. Select **Reagent Tracker** and then select **Build Compendium**.  This will build the Reagent Compendium for your world
4. Go to **Compendiums** on the right hand menu and then type in the search bar "rea".  This should bring up the **Reagent Compendium**
5. Open it and validate it is populated with reagents
6. Next go back to the **Reagent Tracker** Menu in **Game Settings** and click **Build Spell Map**.  There should be a notice about how
many spells were added to the Spell Map
7. Next click **Open Spell Map**.  Here you can click on the Edit icon on the right and for each spell to assign a reagent to it.  The **Consumed on Cast**
checkbox allows the GM to control which spells consume an attached reagent or not.  If its not checked - the reagent is required but only 1 and it will
not be consumed on cast.  After changing the spells you would like to add reagents to - click **Save**
8. On the **Game Settings** **Reagent Tracker** page - ensure that **Auto-consume reagents on cast** is checked.  This will ensure that reagents will
be consumed on a cast, and enforcement will take place if they are not present.  If you wish to disable this workflow for all spells simply uncheck
this box, and all spells will no longer require a reagent
9. If you are having a difficulty with a particlar spell that is not consuming reagents or requiring reagents although you have assigned it in the SpellMap, delete the spell from the actor and drag the spell from dnd5e.spells and ensure the spell names align between the SpellMap and the actors spell list.
While the script does not match on name - but UUID - making sure that at least the names match is a good starting place to make sure the spell identified in the SpellMap is configured to require a specific kind of reagent.
10.  Open the **Reagents** Compendium and drag reagents to actors that require them.  You can increase the quantity inside of the inventory and 
the script and cache will recognize the change and align with the increase in quantity in the inventory
11. Upgrade workflows do work.  DnD5e rules stipulate that a more expensive reagent can be used for a spell if available.  The script will keep track of whether upgrades are available on an actor and will offer them if the spell is case but the base reagent is not available.  This should appear as a chat prompt.  If the actor wishes to use the more expensive reagent - they can click 'Use' and it will be consumed and the spell cast.  If they click 'Decline' no spell slots will be consumed and no spell will be cast

Happy Reagent-ing
---

## 🧰 GM Utilities
- **Repair Reagent Compendium/Repair Data Sources:** Fix broken reagent references (`Settings → Repair Reagent Compendium`).
- **Rebuild Cache:** Re-index all actors with reagent-linked spells.
- **Auto-Consume Toggle:** Disable reagent blocking globally if desired.

---

## 🧪 Development Notes
- Works with D&D5e system v5.1.1.9 and Foundry V13+.
- No external dependencies (fully self-contained).
- Designed for compatibility with **Midi-QOL** and other casting automation modules.

---

## 💎 Credits & License
Created by **BinaryPhinary**  
MIT License  
[GitHub Repository](https://github.com/BinaryPhinary/reagent-tracker)

---

## 🧭 Troubleshooting
If a spell doesn’t show up or consumes incorrectly:
- Ensure it’s mapped correctly in **Spell Map Manager**.
- Check the reagent’s “Consumed on Cast” box.
- Rebuild caches via **Settings → Reagent Tracker → Reapir Data Sources**.