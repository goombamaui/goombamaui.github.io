/**
 * Free-slot DP core, ported from wynnmacro's CraftOptimizerRunner (bestFillForProfile, Frontier,
 * dominance pruning, remaining-slack widening, safe bitset, constraint step functions,
 * FRONTIER_SIZE_BOUND, the two-step sweep). See docs/craft-optimizer-dp.md for the algorithm's own
 * doc and docs/design/craft-optimizer-js-port.md §1 for the port's design table.
 *
 * Single-threaded: the outer unit-enumeration loop yields periodically via
 * `await new Promise(r => setTimeout(r, 0))` instead of using Web Workers (see design row on the
 * outer unit enumeration loop) so the page stays responsive without duplicating the data-loading
 * chain into a worker context.
 */

// ---- constants, ported 1:1 from CraftOptimizerRunner ------------------------------------------

const FRONTIER_SIZE_BOUND = 200_000;
const DOMINANCE_MIN_FRONTIER = 64;
const DOMINANCE_SURVIVOR_SCAN_CAP = 2000;
const DOMINANCE_LARGE_FRONTIER = 50_000;

// ---- Frontier -----------------------------------------------------------------------------------

/**
 * DP frontier: the set of distinct reachable (constraint-totals-vector, score) states after
 * processing some prefix of free slots. Ported from CraftOptimizerRunner's primitive-array Frontier,
 * but keyed by a `totals.join(',')` string in a native Map rather than a hand-rolled open-addressed
 * table with a MurmurHash-style finalizer - JS has no unsigned-64-bit arithmetic to port that hash
 * to, and Map's own string hashing is the idiomatic equivalent (see design row on this).
 */
class Frontier {
    constructor(numConstraints) {
        this.numConstraints = numConstraints;
        this.keys = []; // one totals array (length numConstraints) per state
        this.scores = [];
        this.candidateIdx = []; // statPool index chosen to reach this state, -1 for "<empty>"
        this.parentRef = []; // index into the previous slot's Frontier
        this.byKey = new Map(); // totals.join(',') -> state index
        this.size = 0;
    }

    /**
     * Inserts a new state if `totals` isn't present yet, or - if it is - overwrites the existing
     * state's score/candidateIndex/parentRef when `score` beats the existing one. Same "keep the
     * higher-scoring entry per distinct totals vector" semantics as Frontier.upsertMax.
     */
    upsertMax(totals, score, candidateIndex, parentIdx) {
        const k = totals.join(',');
        const existing = this.byKey.get(k);
        if (existing === undefined) {
            const idx = this.size++;
            this.keys.push(totals);
            this.scores.push(score);
            this.candidateIdx.push(candidateIndex);
            this.parentRef.push(parentIdx);
            this.byKey.set(k, idx);
        } else if (score > this.scores[existing]) {
            this.scores[existing] = score;
            this.candidateIdx[existing] = candidateIndex;
            this.parentRef[existing] = parentIdx;
        }
    }

    /** Rebuilds a Frontier containing only the given subset of this Frontier's states, in order. */
    keepOnly(survivingIndices) {
        const out = new Frontier(this.numConstraints);
        for (const si of survivingIndices) {
            out.upsertMax(this.keys[si], this.scores[si], this.candidateIdx[si], this.parentRef[si]);
        }
        return out;
    }
}

// ---- Bitset32 -------------------------------------------------------------------------------------

/**
 * Bitset over fixed statPool indices, Uint32Array-backed (32-bit words) since JS bitwise operators
 * only give 32 safe bits, unlike Java's 64-bit `long[]` words - direct structural equivalent of
 * CraftOptimizerRunner's hand-rolled long[] bitset, just double the word count for the same pool
 * size (see design row on this).
 */
class Bitset32 {
    constructor(n) {
        this.words = new Uint32Array(Math.ceil(n / 32) || 1);
    }
    setBit(i) {
        this.words[i >>> 5] |= (1 << (i & 31));
    }
    isSet(i) {
        return (this.words[i >>> 5] & (1 << (i & 31))) !== 0;
    }
    clear() {
        this.words.fill(0);
    }
    fillAllOnes() {
        this.words.fill(0xFFFFFFFF);
    }
    andWith(other) {
        for (let w = 0; w < this.words.length; w++) this.words[w] &= other.words[w];
    }
    /** Next set bit at index >= from, or -1 if none. */
    nextSetBit(from, poolSize) {
        for (let i = from; i < poolSize; i++) {
            if (this.isSet(i)) return i;
        }
        return -1;
    }
}

// ---- rounding helpers, deferring to craft.js's own floor/round behavior -----------------------

/**
 * One (minRoll, maxRoll) pair scaled by effectivenessPercent, matching craft.js:487's
 * `rolls.map(x => Math.floor(x * eff_mult))` exactly - both bounds independently floored after
 * scaling, then re-sorted ascending. Matches the asymmetric trigger: if maxRoll == 0, the stat is
 * skipped entirely (returns [0, 0]) even if minRoll != 0.
 */
function scaleIdsStat(minRoll, maxRoll, effectivenessPercent) {
    if (maxRoll === 0) return [0, 0];
    const effMult = effectivenessPercent / 100.0;
    const scaledMin = Math.floor(minRoll * effMult);
    const scaledMax = Math.floor(maxRoll * effMult);
    return scaledMin <= scaledMax ? [scaledMin, scaledMax] : [scaledMax, scaledMin];
}

// ---- fast per-slot-per-candidate delta path (objectiveDeltaAt / applyConstraint) ----------------

const OBJ_SPECIAL_STATS = new Set(["durability", "duration", "charges"]);

/**
 * Single ingredient's objective contribution at one slot effectiveness - port of
 * CraftOptimizerRunner.objectiveDeltaAt.
 */
function objectiveDeltaAt(r, eff, objectiveWeights) {
    let objDelta = (objectiveWeights.get("durability") || 0) * r.duraDelta
        + (objectiveWeights.get("duration") || 0) * r.durationDelta
        + (objectiveWeights.get("charges") || 0) * r.chargesDelta;
    for (const [stat, weight] of objectiveWeights) {
        if (OBJ_SPECIAL_STATS.has(stat)) continue;
        const scaled = scaleIdsStat(r.minRollFor(stat), r.maxRollFor(stat), eff);
        objDelta += weight * ((scaled[0] + scaled[1]) / 2.0);
    }
    return objDelta;
}

/**
 * Single ingredient's contribution to one constraint at one slot effectiveness - port of
 * CraftOptimizerRunner.applyConstraint. Uses Math.trunc (not Math.floor) to match Java's
 * `(long) total` truncate-toward-zero semantics.
 */
function applyConstraint(r, constraint, eff) {
    const terms = constraint.terms;
    if (terms.length === 1) {
        const statName = terms[0].statName;
        if (statName === "durability") return r.duraDelta;
        if (statName === "duration") return r.durationDelta;
        if (statName === "charges") return r.chargesDelta;
    }
    let total = 0.0;
    for (const t of terms) {
        const scaled = scaleIdsStat(r.minRollFor(t.statName), r.maxRollFor(t.statName), eff);
        total += t.weight * ((scaled[0] + scaled[1]) / 2);
    }
    return Math.trunc(total);
}

function satisfiedBy(constraint, total) {
    return constraint.isMin
        ? (constraint.strict ? total > constraint.bound : total >= constraint.bound)
        : (constraint.strict ? total < constraint.bound : total <= constraint.bound);
}

// ---- constraint step functions / safe bitset / remaining-slack widening ------------------------

/**
 * Every statPool ingredient's exact contribution to one constraint at one real queried eff, sorted
 * ascending alongside the originating statPool index - port of buildStepFunctionAtEff.
 */
function buildStepFunctionAtEff(constraintIndex, c, statPool, eff) {
    const n = statPool.length;
    const tips = new Array(n);
    const idx = new Array(n);
    for (let i = 0; i < n; i++) {
        tips[i] = applyConstraint(statPool[i], c, eff);
        idx[i] = i;
    }
    const order = idx.slice().sort((a, b) => tips[a] - tips[b]);
    const sortedTips = new Array(n);
    const sortedIdx = new Array(n);
    for (let i = 0; i < n; i++) {
        sortedTips[i] = tips[order[i]];
        sortedIdx[i] = idx[order[i]];
    }
    return { constraintIndex, tippingValuesSorted: sortedTips, statPoolIndexAtEachTippingEntry: sortedIdx };
}

/** First index in sortedArray whose value is >= target (standard lower bound). */
function lowerBoundIndex(sortedArray, target) {
    let lo = 0, hi = sortedArray.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedArray[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/**
 * Writes into caller-supplied `bits` (cleared first) the set of statPool indices still feasible for
 * one constraint given `remaining` slack, at the eff `fn` was built for - port of safeBitset.
 */
function safeBitset(bits, fn, c, remaining, poolSize) {
    bits.clear();
    if (!c.isMin) {
        // <=-sense: prefix of the ascending array (smallest values first)
        const effectiveRemaining = c.strict ? remaining - 1 : remaining;
        const count = lowerBoundIndex(fn.tippingValuesSorted, effectiveRemaining + 1);
        for (let i = 0; i < count; i++) bits.setBit(fn.statPoolIndexAtEachTippingEntry[i]);
    } else {
        // >=-sense: suffix of the ascending array (largest values first)
        const effectiveRemaining = c.strict ? remaining + 1 : remaining;
        const startIdx = lowerBoundIndex(fn.tippingValuesSorted, effectiveRemaining);
        for (let i = startIdx; i < fn.tippingValuesSorted.length; i++) bits.setBit(fn.statPoolIndexAtEachTippingEntry[i]);
    }
}

// ---- upper-bound / extrema helpers, ported from CraftOptimizerRunner ---------------------------

/** Best single-slot objective delta reachable at this eff across all of statPool. */
function maxObjectiveDeltaAt(eff, statPool, objectiveWeights) {
    let max = 0.0; // the synthetic "<empty>" pick always contributes 0
    for (const r of statPool) {
        const d = objectiveDeltaAt(r, eff, objectiveWeights);
        if (d > max) max = d;
    }
    return max;
}

/** Per-constraint extrema of a single candidate's contribution at this eff, across all of statPool. */
function constraintDeltaExtremaAt(eff, statPool, constraints) {
    const min = new Array(constraints.length).fill(0);
    const max = new Array(constraints.length).fill(0);
    for (const r of statPool) {
        for (let ci = 0; ci < constraints.length; ci++) {
            const delta = applyConstraint(r, constraints[ci], eff);
            if (delta < min[ci]) min[ci] = delta;
            if (delta > max[ci]) max[ci] = delta;
        }
    }
    return { min, max };
}

/** Objective and per-constraint totals already locked in by the occupied (posMod) slots. */
function fixedPartsFor(profile, objectiveWeights, constraints, baseDurabilityScaled, baseDurationScaled, baseCharges) {
    const numConstraints = constraints.length;
    const k = profile.occupiedSlots.length;

    const fixedConstraintTotals = new Array(numConstraints).fill(0);
    let fixedObjective = (objectiveWeights.get("durability") || 0) * baseDurabilityScaled
        + (objectiveWeights.get("duration") || 0) * baseDurationScaled
        + (objectiveWeights.get("charges") || 0) * baseCharges;
    for (let i = 0; i < k; i++) {
        const ing = profile.occupants[i];
        const slotEff = profile.effPerSlot[profile.occupiedSlots[i]];
        fixedObjective += (objectiveWeights.get("durability") || 0) * ing.duraDelta;
        fixedObjective += (objectiveWeights.get("duration") || 0) * ing.durationDelta;
        fixedObjective += (objectiveWeights.get("charges") || 0) * ing.chargesDelta;
        for (const [stat, weight] of objectiveWeights) {
            if (OBJ_SPECIAL_STATS.has(stat)) continue;
            const scaled = scaleIdsStat(ing.minRollFor(stat), ing.maxRollFor(stat), slotEff);
            fixedObjective += weight * ((scaled[0] + scaled[1]) / 2.0);
        }
    }
    for (let c = 0; c < numConstraints; c++) {
        const constraint = constraints[c];
        const loneStat = constraint.terms.length === 1 ? constraint.terms[0].statName : null;
        let total = loneStat === "durability" ? baseDurabilityScaled
            : loneStat === "duration" ? baseDurationScaled
            : loneStat === "charges" ? baseCharges
            : 0;
        for (let i = 0; i < k; i++) {
            const ing = profile.occupants[i];
            const slotEff = profile.effPerSlot[profile.occupiedSlots[i]];
            total += applyConstraint(ing, constraint, slotEff);
        }
        fixedConstraintTotals[c] = total;
    }

    const occupied = new Array(6).fill(false);
    for (const s of profile.occupiedSlots) occupied[s] = true;
    const freeSlots = [];
    for (let s = 0; s < 6; s++) if (!occupied[s]) freeSlots.push(s);

    return { fixedObjective, fixedConstraintTotals, freeSlots };
}

/**
 * Upper bound on a unit's best-possible score, ignoring constraints - port of
 * fixedObjectiveUpperBoundEstimate.
 */
function fixedObjectiveUpperBoundEstimate(profile, objectiveWeights, baseDurabilityScaled, baseDurationScaled, baseCharges, maxObjectiveDeltaCache) {
    const k = profile.occupiedSlots.length;
    let fixedObjective = (objectiveWeights.get("durability") || 0) * baseDurabilityScaled
        + (objectiveWeights.get("duration") || 0) * baseDurationScaled
        + (objectiveWeights.get("charges") || 0) * baseCharges;
    for (let i = 0; i < k; i++) {
        const ing = profile.occupants[i];
        const slotEff = profile.effPerSlot[profile.occupiedSlots[i]];
        fixedObjective += (objectiveWeights.get("durability") || 0) * ing.duraDelta;
        fixedObjective += (objectiveWeights.get("duration") || 0) * ing.durationDelta;
        fixedObjective += (objectiveWeights.get("charges") || 0) * ing.chargesDelta;
        for (const [stat, weight] of objectiveWeights) {
            if (OBJ_SPECIAL_STATS.has(stat)) continue;
            const scaled = scaleIdsStat(ing.minRollFor(stat), ing.maxRollFor(stat), slotEff);
            fixedObjective += weight * ((scaled[0] + scaled[1]) / 2.0);
        }
    }

    const occupied = new Array(6).fill(false);
    for (const s of profile.occupiedSlots) occupied[s] = true;
    let freeSlotBound = 0.0;
    for (let s = 0; s < 6; s++) {
        if (occupied[s]) continue;
        const eff = profile.effPerSlot[s];
        freeSlotBound += maxObjectiveDeltaCache.has(eff) ? maxObjectiveDeltaCache.get(eff) : Infinity;
    }
    return fixedObjective + freeSlotBound;
}

// ---- bestFillForProfile --------------------------------------------------------------------------

/**
 * Fills the free slots of one profile (a fixed assignment of posMod ingredients to some occupied
 * slots) with the best remaining ingredients from statPool, subject to the constraint list. Port of
 * CraftOptimizerRunner.bestFillForProfile. Returns {score, ingredientNames} or
 * {score: -Infinity, ingredientNames: null} if infeasible or abandoned.
 */
function bestFillForProfile(
    profile, statPool, objectiveWeights, constraints,
    baseDurabilityScaled, baseDurationScaled, baseCharges,
    maxObjectiveDeltaCache, minConstraintDeltaCache, maxConstraintDeltaCache,
    scoreThreshold, stepFunctionsByEff
) {
    const numConstraints = constraints.length;
    const k = profile.occupiedSlots.length;

    const fixedParts = fixedPartsFor(profile, objectiveWeights, constraints, baseDurabilityScaled, baseDurationScaled, baseCharges);
    const fixedObjective = fixedParts.fixedObjective;
    const fixedConstraintTotals = fixedParts.fixedConstraintTotals;
    const freeSlots = fixedParts.freeSlots;

    const frontiersBySlot = [];
    let frontier = new Frontier(numConstraints);
    frontier.upsertMax(new Array(numConstraints).fill(0), fixedObjective, -1, -1);
    frontiersBySlot.push(frontier);

    // suffixMaxFromSlot[i] = best possible additional objective contribution from freeSlots[i..end]
    const suffixMaxFromSlot = new Array(freeSlots.length + 1).fill(0);
    for (let i = freeSlots.length - 1; i >= 0; i--) {
        const eff = profile.effPerSlot[freeSlots[i]];
        if (!maxObjectiveDeltaCache.has(eff)) {
            maxObjectiveDeltaCache.set(eff, maxObjectiveDeltaAt(eff, statPool, objectiveWeights));
        }
        const maxDelta = maxObjectiveDeltaCache.get(eff);
        suffixMaxFromSlot[i] = suffixMaxFromSlot[i + 1] + maxDelta;
    }

    // suffixBestHelpFromSlot[ci][i] = best possible constraint-ci-helping contribution reachable
    // from freeSlots[i..end] - remaining-slack widening's input.
    const suffixBestHelpFromSlot = [];
    for (let ci = 0; ci < numConstraints; ci++) suffixBestHelpFromSlot.push(new Array(freeSlots.length + 1).fill(0));
    for (let i = freeSlots.length - 1; i >= 0; i--) {
        const eff = profile.effPerSlot[freeSlots[i]];
        if (!minConstraintDeltaCache.has(eff)) {
            const extrema = constraintDeltaExtremaAt(eff, statPool, constraints);
            minConstraintDeltaCache.set(eff, extrema.min);
            maxConstraintDeltaCache.set(eff, extrema.max);
        }
        const min = minConstraintDeltaCache.get(eff);
        const max = maxConstraintDeltaCache.get(eff);
        for (let ci = 0; ci < numConstraints; ci++) {
            const bestHelp = constraints[ci].isMin ? max[ci] : -min[ci];
            suffixBestHelpFromSlot[ci][i] = suffixBestHelpFromSlot[ci][i + 1] + bestHelp;
        }
    }

    let slotPos = 0;
    const poolSize = statPool.length;
    const safe = new Bitset32(poolSize);
    const constraintSafeScratch = new Bitset32(poolSize);

    for (const slot of freeSlots) {
        const eff = profile.effPerSlot[slot];
        if (!stepFunctionsByEff.has(eff)) {
            const built = [];
            for (let cj = 0; cj < constraints.length; cj++) {
                built.push(buildStepFunctionAtEff(cj, constraints[cj], statPool, eff));
            }
            stepFunctionsByEff.set(eff, built);
        }
        const stepFunctions = stepFunctionsByEff.get(eff);

        const next = new Frontier(numConstraints);
        for (let prevIdx = 0; prevIdx < frontier.size; prevIdx++) {
            const prevTotals = frontier.keys[prevIdx];
            const prevScore = frontier.scores[prevIdx];

            safe.fillAllOnes();
            for (let ci = 0; ci < numConstraints; ci++) {
                const constraint = constraints[ci];
                const remaining = constraint.bound - (fixedConstraintTotals[ci] + prevTotals[ci]);
                const widenedRemaining = remaining + suffixBestHelpFromSlot[ci][slotPos + 1];
                safeBitset(constraintSafeScratch, stepFunctions[ci], constraint, widenedRemaining, poolSize);
                safe.andWith(constraintSafeScratch);
            }

            // The synthetic "<empty>" pick is always safe.
            const emptyScore = prevScore;
            if (emptyScore + suffixMaxFromSlot[slotPos + 1] > scoreThreshold) {
                next.upsertMax(prevTotals.slice(), emptyScore, -1, prevIdx);
            }

            for (let idx = safe.nextSetBit(0, poolSize); idx >= 0; idx = safe.nextSetBit(idx + 1, poolSize)) {
                const r = statPool[idx];
                const newScore = prevScore + objectiveDeltaAt(r, eff, objectiveWeights);
                if (newScore + suffixMaxFromSlot[slotPos + 1] <= scoreThreshold) continue;
                const newTotals = new Array(numConstraints);
                for (let ci = 0; ci < numConstraints; ci++) {
                    newTotals[ci] = prevTotals[ci] + applyConstraint(r, constraints[ci], eff);
                }
                next.upsertMax(newTotals, newScore, idx, prevIdx);
            }
        }

        // Dominance pruning.
        let pruned = next;
        if (next.size >= DOMINANCE_MIN_FRONTIER) {
            const n = next.size;
            const nextScores = next.scores;
            const order = [];
            for (let i = 0; i < n; i++) order.push(i);
            order.sort((a, b) => nextScores[b] - nextScores[a]);

            const capScan = n > DOMINANCE_LARGE_FRONTIER;
            const survivors = [];
            for (const oi of order) {
                const totals = next.keys[oi];
                let dominated = false;
                const scanLimit = capScan ? Math.min(survivors.length, DOMINANCE_SURVIVOR_SCAN_CAP) : survivors.length;
                for (let si = 0; si < scanLimit; si++) {
                    const survTotals = next.keys[survivors[si]];
                    let survDominates = true;
                    for (let ci = 0; ci < numConstraints; ci++) {
                        const ok = constraints[ci].isMin
                            ? survTotals[ci] >= totals[ci]
                            : survTotals[ci] <= totals[ci];
                        if (!ok) { survDominates = false; break; }
                    }
                    if (survDominates) { dominated = true; break; }
                }
                if (!dominated) survivors.push(oi);
            }

            if (survivors.length < n) {
                pruned = next.keepOnly(survivors);
            }
        }

        frontier = pruned;
        frontiersBySlot.push(frontier);
        slotPos++;
    }

    if (frontier.size > FRONTIER_SIZE_BOUND) {
        return { score: -Infinity, ingredientNames: null };
    }

    let localBest = -Infinity;
    let localBestIdx = -1;
    for (let i = 0; i < frontier.size; i++) {
        let feasible = true;
        for (let c = 0; c < numConstraints; c++) {
            const finalTotal = fixedConstraintTotals[c] + frontier.keys[i][c];
            if (!satisfiedBy(constraints[c], finalTotal)) { feasible = false; break; }
        }
        if (feasible && frontier.scores[i] > localBest) {
            localBest = frontier.scores[i];
            localBestIdx = i;
        }
    }

    if (localBestIdx < 0) return { score: -Infinity, ingredientNames: null };

    const full = new Array(6).fill(null);
    for (let i = 0; i < k; i++) full[profile.occupiedSlots[i]] = profile.occupants[i].name;

    let fi = freeSlots.length - 1;
    let curFrontierPos = frontiersBySlot.length - 1;
    let curIdx = localBestIdx;
    while (curFrontierPos > 0) {
        const curFrontier = frontiersBySlot[curFrontierPos];
        const slot = freeSlots[fi];
        const candidateIndex = curFrontier.candidateIdx[curIdx];
        full[slot] = candidateIndex < 0 ? "<empty>" : statPool[candidateIndex].name;
        curIdx = curFrontier.parentRef[curIdx];
        curFrontierPos--;
        fi--;
    }
    return { score: localBest, ingredientNames: full };
}

// ---- posMod effectiveness matrix + combinatorics helpers, needed by the outer unit loop --------

/**
 * @param occupiedSlots slot indices (0-5) that hold a posMod-nonzero ingredient.
 * @param posModsPerSlot parallel to occupiedSlots: each occupied slot's posMods Map.
 * @return the 6-slot effectiveness array (flat, slot n -> effectiveness percentage).
 */
function computeEffectivenessMatrix(occupiedSlots, posModsPerSlot) {
    const eff = [[100, 100], [100, 100], [100, 100]];
    for (let idx = 0; idx < occupiedSlots.length; idx++) {
        const n = occupiedSlots[idx];
        const i = Math.floor(n / 2), j = n % 2;
        for (const [key, value] of posModsPerSlot[idx]) {
            if (value === 0) continue;
            if (key === "above") { for (let k = i - 1; k >= 0; k--) eff[k][j] += value; }
            else if (key === "under") { for (let k = i + 1; k <= 2; k++) eff[k][j] += value; }
            else if (key === "left") { if (j === 1) eff[i][0] += value; }
            else if (key === "right") { if (j === 0) eff[i][1] += value; }
            else if (key === "touching") {
                for (let k = 0; k < 3; k++) for (let l = 0; l < 2; l++) {
                    if (Math.abs(k - i) + Math.abs(l - j) === 1) eff[k][l] += value;
                }
            } else if (key === "notTouching") {
                for (let k = 0; k < 3; k++) for (let l = 0; l < 2; l++) {
                    const far = Math.abs(k - i) > 1;
                    const diag = Math.abs(k - i) === 1 && Math.abs(l - j) === 1;
                    if (far || diag) eff[k][l] += value;
                }
            } else {
                throw new Error(`Unknown posMods key: ${key}`);
            }
        }
    }
    const flat = new Array(6);
    for (let n = 0; n < 6; n++) flat[n] = eff[Math.floor(n / 2)][n % 2];
    return flat;
}

/** Armor/accessory base durability at a given material tier combination. */
function scaleDurability(baseDurability, matTiers, materialAmounts) {
    const tierToMult = [0, 1, 1.25, 1.4];
    const matmult = (tierToMult[matTiers[0]] * materialAmounts[0] + tierToMult[matTiers[1]] * materialAmounts[1])
        / (materialAmounts[0] + materialAmounts[1]);
    return Math.round(baseDurability * matmult);
}

/** All 6-bit masks with exactly k bits set. */
function choose6(k) {
    const masks = [];
    for (let mask = 0; mask < 64; mask++) {
        if (popcount(mask) === k) masks.push(mask);
    }
    return masks;
}

function popcount(mask) {
    let c = 0;
    while (mask) { c += mask & 1; mask >>>= 1; }
    return c;
}

function maskToSlots(mask, k) {
    const slots = new Array(k);
    let idx = 0;
    for (let s = 0; s < 6; s++) if ((mask & (1 << s)) !== 0) slots[idx++] = s;
    return slots;
}
