/**
 * Top-level search orchestrator, ported from CraftOptimizerRunner.run's two-step sweep: outer
 * enumeration of posMod-ingredient-profiles (occupied slots x posMod pool combos), calling into
 * optimizer_dp.js's per-profile DP solve for each, tracking the top-3 distinct results. This is the
 * function the GUI calls. See docs/design/craft-optimizer-js-port.md §1.
 */

const CONSUMABLE_TYPES = new Set(["POTION", "SCROLL", "FOOD"]);
const REQ_STATS_OPT = ["strReq", "dexReq", "intReq", "defReq", "agiReq"];
const TOP_N = 3;

/** One profession-pool ingredient's flattened stat data - port of CraftOptimizerRunner.RawIngredient. */
class RawIngredientJs {
    constructor(name, maxRoll, minRoll, duraDelta, durationDelta, chargesDelta, posMods) {
        this.name = name;
        this.maxRoll = maxRoll; // Map<stat, number>
        this.minRoll = minRoll; // Map<stat, number>
        this.duraDelta = duraDelta;
        this.durationDelta = durationDelta;
        this.chargesDelta = chargesDelta;
        this.posMods = posMods; // Map<key, number>, only nonzero entries
    }
    maxRollFor(stat) { return this.maxRoll.has(stat) ? this.maxRoll.get(stat) : 0; }
    minRollFor(stat) { return this.minRoll.has(stat) ? this.minRoll.get(stat) : 0; }
}

/** Running top-N (by score) distinct-ingredient-multiset results, kept sorted-desc on offer. */
class TopResultsJs {
    constructor() {
        this.entries = []; // {score, assignment, effPerSlot, dedupeKey}
    }

    offer(score, assignment, effPerSlot) {
        const dedupeKey = assignment.slice().sort().join('|');
        for (let i = 0; i < this.entries.length; i++) {
            if (this.entries[i].dedupeKey === dedupeKey) {
                if (score > this.entries[i].score) {
                    this.entries[i] = { score, assignment, effPerSlot: effPerSlot.slice(), dedupeKey };
                    this.entries.sort((a, b) => b.score - a.score);
                }
                return;
            }
        }
        if (this.entries.length < TOP_N) {
            this.entries.push({ score, assignment, effPerSlot: effPerSlot.slice(), dedupeKey });
            this.entries.sort((a, b) => b.score - a.score);
        } else if (score > this.entries[this.entries.length - 1].score) {
            this.entries[this.entries.length - 1] = { score, assignment, effPerSlot: effPerSlot.slice(), dedupeKey };
            this.entries.sort((a, b) => b.score - a.score);
        }
    }

    currentThreshold() {
        return this.entries.length >= TOP_N ? this.entries[TOP_N - 1].score : -Infinity;
    }

    toSortedList() { return this.entries; }
}

/**
 * Rebuilds a full stat -> [totalMin, totalMax] breakdown from a winning 6-slot assignment - port of
 * CraftOptimizerRunner.buildStatRanges.
 */
function buildStatRanges(assignment, effPerSlot, byName, baseDurabilityScaled, baseDurationScaled, baseCharges, isConsumable) {
    const ranges = new Map();
    if (isConsumable) {
        ranges.set("duration", [baseDurationScaled, baseDurationScaled]);
        ranges.set("charges", [baseCharges, baseCharges]);
    } else {
        ranges.set("durability", [baseDurabilityScaled, baseDurabilityScaled]);
    }
    for (let slot = 0; slot < assignment.length; slot++) {
        const name = assignment[slot];
        if (name === null || name === "<empty>") continue;
        const ing = byName.get(name);
        if (!ing) continue;

        if (isConsumable) {
            const durationRange = ranges.get("duration");
            durationRange[0] += ing.durationDelta;
            durationRange[1] += ing.durationDelta;
            const chargesRange = ranges.get("charges");
            chargesRange[0] += ing.chargesDelta;
            chargesRange[1] += ing.chargesDelta;
        } else {
            const duraRange = ranges.get("durability");
            duraRange[0] += ing.duraDelta;
            duraRange[1] += ing.duraDelta;
        }

        const eff = effPerSlot[slot];
        const stats = new Set([...ing.minRoll.keys(), ...ing.maxRoll.keys()]);
        for (const stat of stats) {
            const scaled = scaleIdsStat(ing.minRollFor(stat), ing.maxRollFor(stat), eff);
            if (scaled[0] === 0 && scaled[1] === 0) continue;
            if (!ranges.has(stat)) ranges.set(stat, [0, 0]);
            const total = ranges.get(stat);
            total[0] += scaled[0];
            total[1] += scaled[1];
        }
    }
    return ranges;
}

/**
 * Runs the optimizer search for one profession/level-range/material-tier/constraint/formula
 * combination. Port of CraftOptimizerRunner.run's two-step sweep.
 *
 * @param profession WynnBuilder skill name, e.g. "ARMOURING".
 * @param levelMin minimum crafting level.
 * @param levelMax maximum crafting level (the recipe band is matched against this, matching Java's `level = levelMax`).
 * @param matTiers [tierA, tierB], each 1-3.
 * @param formulaText objective formula string.
 * @param constraintStrings array of constraint strings (already split on top-level commas by the caller).
 * @param onProgress (message: string) => void, called with human-readable progress text.
 * @param onProgressCounts (unitIdx: number, totalUnits: number) => void, called for the progress bar.
 * @returns Promise<Array<CraftResult>>, top-3 distinct results, best first.
 */
async function runOptimizer(profession, levelMin, levelMax, matTiers, formulaText, constraintStrings, onProgress, onProgressCounts) {
    const progress = onProgress || (() => {});
    const counts = onProgressCounts || (() => {});

    const skill = profession.toUpperCase();
    const level = levelMax;

    const formula = parseFormula(formulaText);
    const coupling = analyzeCoupling(formula);
    if (coupling.coupledStats.size > 0) {
        throw new Error(`Formula "${formulaText}" is not purely linear - stats `
            + `${[...coupling.coupledStats].join(', ')} are multiplied/divided against other stat-dependent terms. `
            + `This optimizer only supports linear objectives (aI + bJ + ...).`);
    }
    const linear = extractLinearCoefficients(formula, coupling.linearStats);
    const objectiveWeights = linear.coefficients;

    const constraints = [];
    for (const c of constraintStrings) constraints.push(...parseConstraint(c));

    if (!recipeList || recipeList.length === 0) {
        throw new Error("Recipe/ingredient data not loaded yet - cannot run optimizer");
    }

    let recipe = null;
    for (const name of recipeList) {
        const r = recipeMap.get(name);
        if (skill !== r.skill) continue;
        const recipeMin = r.lvl.minimum;
        const recipeMax = r.lvl.maximum;
        if (levelMin < recipeMin || level > recipeMax) continue;
        recipe = r;
        break;
    }
    if (recipe === null) {
        throw new Error(`No single recipe band covers level range ${levelMin}-${level} `
            + `for profession=${skill} (crafting level bands don't align with your range)`);
    }
    progress(`Matched recipe ${recipe.name} (type=${recipe.type}) lvl=${recipe.lvl.minimum}-${recipe.lvl.maximum}`);
    const isConsumable = CONSUMABLE_TYPES.has(recipe.type);

    const materials = recipe.materials;
    const matAmounts = [materials[0].amount, materials[1].amount];

    const baseDurabilityScaled = isConsumable ? 0 : scaleDurability(recipe.durability.minimum, matTiers, matAmounts);
    const baseDurationScaled = !isConsumable ? 0 : scaleDurability(recipe.duration.minimum, matTiers, matAmounts);
    let baseCharges;
    if (isConsumable) {
        const recipeMinLvl = recipe.lvl.minimum;
        baseCharges = recipeMinLvl < 30 ? 1 : (recipeMinLvl < 70 ? 2 : 3);
    } else {
        baseCharges = 0;
    }

    const pool = [];
    for (const name of ingList) {
        const ing = ingMap.get(name);
        if (!ing.skills) continue;
        if (!ing.skills.includes(skill)) continue;
        if (ing.lvl > level) continue;
        pool.push(ing);
    }

    const raw = [];
    for (const ing of pool) {
        const maxRoll = new Map();
        const minRoll = new Map();
        const ids = ing.ids || {};
        for (const stat of Object.keys(ids)) {
            const r = ids[stat];
            maxRoll.set(stat, r.maximum);
            minRoll.set(stat, r.minimum);
        }
        const itemIDs = ing.itemIDs || {};
        const dura = itemIDs.dura || 0;
        if (!isConsumable) {
            for (const reqStat of REQ_STATS_OPT) {
                const v = itemIDs[reqStat] || 0;
                if (v !== 0) {
                    maxRoll.set(reqStat, (maxRoll.get(reqStat) || 0) + v);
                    minRoll.set(reqStat, (minRoll.get(reqStat) || 0) + v);
                }
            }
        }
        const consumableIDs = ing.consumableIDs || {};
        const durationDelta = consumableIDs.dura || 0;
        const chargesDelta = consumableIDs.charges || 0;
        const posMods = new Map();
        const pm = ing.posMods || {};
        for (const k of Object.keys(pm)) {
            const v = pm[k];
            if (v !== 0) posMods.set(k, v);
        }
        raw.push(new RawIngredientJs(ing.name, maxRoll, minRoll, dura, durationDelta, chargesDelta, posMods));
    }

    const byName = new Map();
    for (const r of raw) byName.set(r.name, r);

    const posModPool = raw.filter(r => r.posMods.size > 0);
    const statPool = raw.filter(r => r.posMods.size === 0);
    progress(`Candidate pool: posMod=${posModPool.length} statOnly=${statPool.length} `
        + `(from ${raw.length} total ${skill} lvl<=${level} ingredients)`);

    const knownStats = knownStatNames();
    const referencedStats = new Set(objectiveWeights.keys());
    for (const c of constraints) for (const t of c.terms) referencedStats.add(t.statName);
    const unknownStats = [];
    for (const stat of referencedStats) {
        if (stat === "durability" || stat === "duration" || stat === "charges") continue;
        if (!knownStats.has(stat)) unknownStats.push(stat);
    }
    if (unknownStats.length > 0) {
        throw new Error(`Unknown stat name(s) ${JSON.stringify(unknownStats)} referenced in formula/constraints - `
            + `these never appear on any ingredient in the ${skill} lvl<=${level} pool.`);
    }

    const maxObjectiveDeltaCache = new Map();
    const minConstraintDeltaCache = new Map();
    const maxConstraintDeltaCache = new Map();
    const stepFunctionsByEff = new Map();

    const poolSize = posModPool.length;
    const slotChoicesPerK = [];
    const combosPerK = [];
    const unitsBeforeK = new Array(8).fill(0);
    for (let k = 0; k <= 6; k++) {
        slotChoicesPerK[k] = choose6(k);
        combosPerK[k] = Math.pow(poolSize, k);
        const unitsAtK = slotChoicesPerK[k].length * combosPerK[k];
        unitsBeforeK[k + 1] = unitsBeforeK[k] + unitsAtK;
    }
    const totalUnits = unitsBeforeK[7];
    progress(`Enumerating ${totalUnits} effectiveness profiles`);
    progress("Searching profiles...");
    counts(0, totalUnits);

    const top = new TopResultsJs();

    const YIELD_EVERY = 200;
    for (let unitIdx = 0; unitIdx < totalUnits; unitIdx++) {
        let k = 0;
        while (unitIdx >= unitsBeforeK[k + 1]) k++;
        const withinK = unitIdx - unitsBeforeK[k];
        const slotChoices = slotChoicesPerK[k];
        const totalCombos = combosPerK[k];
        const subsetIdx = Math.floor(withinK / totalCombos);
        const combo = withinK % totalCombos;

        const slotMask = slotChoices[subsetIdx];
        const occupiedSlots = maskToSlots(slotMask, k);

        const assignment = new Array(k);
        let rem = combo;
        for (let i = 0; i < k; i++) { assignment[i] = rem % poolSize; rem = Math.floor(rem / poolSize); }

        const posModsPerSlot = new Array(k);
        const occupants = new Array(k);
        for (let i = 0; i < k; i++) {
            occupants[i] = posModPool[assignment[i]];
            posModsPerSlot[i] = occupants[i].posMods;
        }
        const effPerSlot = computeEffectivenessMatrix(occupiedSlots, posModsPerSlot);
        const profile = { effPerSlot, occupiedSlots, occupants };

        const currentThreshold = top.currentThreshold();
        const upperBound = fixedObjectiveUpperBoundEstimate(profile, objectiveWeights,
            baseDurabilityScaled, baseDurationScaled, baseCharges, maxObjectiveDeltaCache);
        const prunedByUpperBound = upperBound <= currentThreshold;

        if (!prunedByUpperBound) {
            const result = bestFillForProfile(profile, statPool, objectiveWeights, constraints,
                baseDurabilityScaled, baseDurationScaled, baseCharges, maxObjectiveDeltaCache,
                minConstraintDeltaCache, maxConstraintDeltaCache, currentThreshold, stepFunctionsByEff);
            if (result.score !== -Infinity) {
                top.offer(result.score, result.ingredientNames, effPerSlot);
            }
        }

        if (unitIdx % YIELD_EVERY === 0) {
            counts(unitIdx, totalUnits);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    counts(totalUnits, totalUnits);

    const sortedTop = top.toSortedList();
    if (sortedTop.length === 0) {
        progress("Done - no feasible assignment found");
        return [];
    }

    const results = [];
    for (const sa of sortedTop) {
        const statRanges = buildStatRanges(sa.assignment, sa.effPerSlot, byName,
            baseDurabilityScaled, baseDurationScaled, baseCharges, isConsumable);
        results.push({
            score: sa.score + linear.constantTerm,
            ingredientNames: sa.assignment,
            recipe,
            baseDurability: baseDurabilityScaled,
            effectivenessPerSlot: sa.effPerSlot,
            statRanges,
            materialTiers: matTiers.slice(),
        });
    }
    progress(`Done - found ${results.length} distinct result(s), best score=${results[0].score}`);
    return results;
}
