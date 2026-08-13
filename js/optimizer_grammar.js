/**
 * Tokenizer + parser for the Optimizer tab's two small grammars: the objective formula (a rational
 * expression over crafted-item stat totals) and the constraint list (a comma-separated list of
 * weighted-sum comparisons, with `both(...)`/`allReq` aggregate sugar). Ported from
 * wynnmacro's `FormulaParser`/`FormulaNode`/`FormulaEvaluator` (objective grammar) and
 * `CraftOptimizerRunner.parseConstraint`/`parseTerms` + `ConstraintTokenizer` (constraint grammar).
 * See docs/design/craft-optimizer-js-port.md §2.
 */

// ---- valid-identifier table -------------------------------------------------------------------

/** Requirement stat names, same order used by `allReq`'s expansion below. */
const REQ_STATS = ["strReq", "dexReq", "intReq", "defReq", "agiReq"];

/** Stats that bypass effectiveness scaling entirely - can only appear as a lone constraint term. */
const EFF_EXEMPT_STATS = ["durability", "duration", "charges"];

/**
 * Builds the set of valid stat identifiers from the currently-loaded `ingMap` (populated by
 * load_ing.js) - mirrors ConstraintTokenizer.statNameExpectedAt's role of knowing which identifiers
 * are legal, but computed live from data instead of a hardcoded list, per design row
 * "wb:js/optimizer_grammar.js — valid-identifier table".
 */
function knownStatNames() {
    const s = new Set();
    for (const ing of ingMap.values()) {
        if (ing.ids) {
            for (const k of Object.keys(ing.ids)) s.add(k);
        }
    }
    for (const req of REQ_STATS) s.add(req);
    s.add("durability");
    s.add("duration");
    s.add("charges");
    return s;
}

// ---- objective formula grammar -----------------------------------------------------------------
//
// expr    := term (('+' | '-') term)*
// term    := unary (('*' | '/') unary)*
// unary   := '-' unary | power
// power   := atom ('^' unary)?
// atom    := NUMBER | IDENT | '(' expr ')'
//
// AST node shape: plain tagged objects, e.g. {kind:'const', value}, {kind:'statRef', name},
// {kind:'add', left, right}, ... - the JS analog of FormulaNode's sealed interface + records.

class FormulaParseError extends Error {}

function tokenizeFormula(source) {
    const tokens = [];
    let i = 0;
    const n = source.length;
    while (i < n) {
        const c = source[i];
        if (/\s/.test(c)) { i++; continue; }
        const start = i;
        if (c === '+') { tokens.push({ type: 'PLUS', text: '+', pos: start }); i++; }
        else if (c === '-') { tokens.push({ type: 'MINUS', text: '-', pos: start }); i++; }
        else if (c === '*') { tokens.push({ type: 'STAR', text: '*', pos: start }); i++; }
        else if (c === '/') { tokens.push({ type: 'SLASH', text: '/', pos: start }); i++; }
        else if (c === '^') { tokens.push({ type: 'CARET', text: '^', pos: start }); i++; }
        else if (c === '(') { tokens.push({ type: 'LPAREN', text: '(', pos: start }); i++; }
        else if (c === ')') { tokens.push({ type: 'RPAREN', text: ')', pos: start }); i++; }
        else if (/[0-9.]/.test(c)) {
            while (i < n && /[0-9.]/.test(source[i])) i++;
            tokens.push({ type: 'NUMBER', text: source.substring(start, i), pos: start });
        } else if (/[A-Za-z_]/.test(c)) {
            while (i < n && isIdentChar(source[i])) i++;
            tokens.push({ type: 'IDENT', text: source.substring(start, i), pos: start });
        } else {
            throw new FormulaParseError(`Unexpected character '${c}' at position ${start}`);
        }
    }
    tokens.push({ type: 'EOF', text: '', pos: n });
    return tokens;
}

function isIdentChar(c) {
    return /[A-Za-z0-9_%]/.test(c);
}

class FormulaParserState {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }
    peek() { return this.tokens[this.pos]; }
    advance() { return this.tokens[this.pos++]; }
    check(type) { return this.peek().type === type; }
    expect(type) {
        if (!this.check(type)) {
            const t = this.peek();
            throw new FormulaParseError(`Expected ${type} but got ${t.type} ("${t.text}") at position ${t.pos}`);
        }
        return this.advance();
    }

    parseExpr() {
        let left = this.parseTerm();
        while (this.check('PLUS') || this.check('MINUS')) {
            const op = this.advance();
            const right = this.parseTerm();
            left = op.type === 'PLUS' ? { kind: 'add', left, right } : { kind: 'sub', left, right };
        }
        return left;
    }

    parseTerm() {
        let left = this.parseUnary();
        while (this.check('STAR') || this.check('SLASH')) {
            const op = this.advance();
            const right = this.parseUnary();
            left = op.type === 'STAR' ? { kind: 'mul', left, right } : { kind: 'div', left, right };
        }
        return left;
    }

    parseUnary() {
        if (this.check('MINUS')) {
            this.advance();
            return { kind: 'neg', operand: this.parseUnary() };
        }
        return this.parsePower();
    }

    parsePower() {
        const base = this.parseAtom();
        if (this.check('CARET')) {
            this.advance();
            const exponent = this.parseUnary(); // right-associative, allows "2^-1"
            return { kind: 'pow', base, exponent };
        }
        return base;
    }

    parseAtom() {
        const tok = this.peek();
        switch (tok.type) {
            case 'NUMBER':
                this.advance();
                return { kind: 'const', value: parseFloat(tok.text) };
            case 'IDENT':
                this.advance();
                return { kind: 'statRef', name: tok.text };
            case 'LPAREN': {
                this.advance();
                const inner = this.parseExpr();
                this.expect('RPAREN');
                return inner;
            }
            default:
                throw new FormulaParseError(`Unexpected token ${tok.type} ("${tok.text}") at position ${tok.pos}`);
        }
    }
}

/** Parses an objective formula string into an AST (see the node-shape comment above). */
function parseFormula(source) {
    const tokens = tokenizeFormula(source);
    const state = new FormulaParserState(tokens);
    const result = state.parseExpr();
    state.expect('EOF');
    return result;
}

/**
 * Evaluates a formula AST against a Map of stat totals - same evaluation-against-pre-summed-totals
 * contract as FormulaEvaluator.evaluate.
 */
function evaluateFormula(node, statTotals) {
    switch (node.kind) {
        case 'const': return node.value;
        case 'statRef': return statTotals.has(node.name) ? statTotals.get(node.name) : 0;
        case 'add': return evaluateFormula(node.left, statTotals) + evaluateFormula(node.right, statTotals);
        case 'sub': return evaluateFormula(node.left, statTotals) - evaluateFormula(node.right, statTotals);
        case 'mul': return evaluateFormula(node.left, statTotals) * evaluateFormula(node.right, statTotals);
        case 'div': return evaluateFormula(node.left, statTotals) / evaluateFormula(node.right, statTotals);
        case 'pow': return Math.pow(evaluateFormula(node.base, statTotals), evaluateFormula(node.exponent, statTotals));
        case 'neg': return -evaluateFormula(node.operand, statTotals);
        default: throw new Error(`Unhandled formula node kind: ${node.kind}`);
    }
}

// ---- coupling analysis / linear coefficient extraction (needed to fold the formula into a DP
// objective, same split CraftOptimizerRunner.run performs before searching) --------------------

/**
 * Walks a formula AST to find which stats are coupled (multiplied/divided against another
 * stat-dependent subexpression) versus linear (safe to fold into one running coefficient) - port of
 * CouplingAnalysis.analyze.
 */
function analyzeCoupling(root) {
    const coupled = new Set();
    markCoupling(root, coupled);
    const all = new Set();
    collectStats(root, all);
    const linear = new Set(all);
    for (const c of coupled) linear.delete(c);
    return { coupledStats: coupled, linearStats: linear };
}

function collectStats(node, out) {
    switch (node.kind) {
        case 'const': return;
        case 'statRef': out.add(node.name); return;
        case 'add': case 'sub': case 'mul': case 'div':
            collectStats(node.left, out); collectStats(node.right, out); return;
        case 'pow': collectStats(node.base, out); collectStats(node.exponent, out); return;
        case 'neg': collectStats(node.operand, out); return;
        default: throw new Error(`Unhandled formula node kind: ${node.kind}`);
    }
}

function markCoupling(node, coupled) {
    switch (node.kind) {
        case 'const': return new Set();
        case 'statRef': return new Set([node.name]);
        case 'add': case 'sub':
            return unionSets(markCoupling(node.left, coupled), markCoupling(node.right, coupled));
        case 'neg': return markCoupling(node.operand, coupled);
        case 'mul': case 'div':
            return coupleIfBothDependent(markCoupling(node.left, coupled), markCoupling(node.right, coupled), coupled);
        case 'pow': {
            const baseStats = markCoupling(node.base, coupled);
            const expStats = markCoupling(node.exponent, coupled);
            if (baseStats.size > 0 && !isConstOne(node.exponent)) {
                for (const s of baseStats) coupled.add(s);
            }
            if (expStats.size > 0) {
                for (const s of baseStats) coupled.add(s);
                for (const s of expStats) coupled.add(s);
            }
            return unionSets(baseStats, expStats);
        }
        default: throw new Error(`Unhandled formula node kind: ${node.kind}`);
    }
}

function isConstOne(node) {
    return node.kind === 'const' && node.value === 1.0;
}

function coupleIfBothDependent(left, right, coupled) {
    if (left.size > 0 && right.size > 0) {
        for (const s of left) coupled.add(s);
        for (const s of right) coupled.add(s);
    }
    return unionSets(left, right);
}

function unionSets(a, b) {
    if (a.size === 0) return b;
    if (b.size === 0) return a;
    const out = new Set(a);
    for (const x of b) out.add(x);
    return out;
}

/**
 * Extracts each linear stat's constant coefficient plus the formula's constant term - port of
 * LinearCoefficients.extract. `linearStats` must not contain any coupled stat.
 */
function extractLinearCoefficients(node, linearStats) {
    const coeffs = new Map();
    const constantTerm = walkLinear(node, linearStats, 1.0, coeffs);
    return { coefficients: coeffs, constantTerm };
}

function walkLinear(node, linearStats, factor, coeffs) {
    switch (node.kind) {
        case 'const': return factor * node.value;
        case 'statRef':
            if (linearStats.has(node.name)) {
                coeffs.set(node.name, (coeffs.get(node.name) || 0) + factor);
            }
            return 0.0;
        case 'add': return walkLinear(node.left, linearStats, factor, coeffs) + walkLinear(node.right, linearStats, factor, coeffs);
        case 'sub': return walkLinear(node.left, linearStats, factor, coeffs) - walkLinear(node.right, linearStats, factor, coeffs);
        case 'neg': return -walkLinear(node.operand, linearStats, factor, coeffs);
        default: break;
    }

    if (!referencesAny(node, linearStats)) return 0.0;

    if (node.kind === 'mul') {
        const leftConst = tryConstEval(node.left);
        const rightConst = tryConstEval(node.right);
        if (leftConst !== null) {
            return walkLinear(node.right, linearStats, factor * leftConst, coeffs);
        } else if (rightConst !== null) {
            return walkLinear(node.left, linearStats, factor * rightConst, coeffs);
        }
        throw new Error("Mul node references a linear stat on a non-constant side - analyzeCoupling should have marked it coupled");
    }
    if (node.kind === 'div') {
        const rightConst = tryConstEval(node.right);
        if (rightConst === null) {
            throw new Error("Div node's denominator is stat-dependent but outside coupled stats - analyzeCoupling should have marked it coupled");
        }
        return walkLinear(node.left, linearStats, factor / rightConst, coeffs);
    }
    if (node.kind === 'pow') {
        const baseConst = tryConstEval(node.base);
        const expConst = tryConstEval(node.exponent);
        if (baseConst === null || expConst === null) {
            throw new Error("Pow node involves a linear stat but isn't a pure constant - analyzeCoupling should have marked it coupled");
        }
        return factor * Math.pow(baseConst, expConst);
    }
    throw new Error(`Unhandled formula node kind: ${node.kind}`);
}

function referencesAny(node, statNames) {
    switch (node.kind) {
        case 'const': return false;
        case 'statRef': return statNames.has(node.name);
        case 'add': case 'sub': case 'mul': case 'div':
            return referencesAny(node.left, statNames) || referencesAny(node.right, statNames);
        case 'pow': return referencesAny(node.base, statNames) || referencesAny(node.exponent, statNames);
        case 'neg': return referencesAny(node.operand, statNames);
        default: throw new Error(`Unhandled formula node kind: ${node.kind}`);
    }
}

/** Evaluates `node` if it contains no stat references at all; null otherwise. */
function tryConstEval(node) {
    switch (node.kind) {
        case 'const': return node.value;
        case 'statRef': return null;
        case 'add': { const a = tryConstEval(node.left), b = tryConstEval(node.right); return (a === null || b === null) ? null : a + b; }
        case 'sub': { const a = tryConstEval(node.left), b = tryConstEval(node.right); return (a === null || b === null) ? null : a - b; }
        case 'mul': { const a = tryConstEval(node.left), b = tryConstEval(node.right); return (a === null || b === null) ? null : a * b; }
        case 'div': { const a = tryConstEval(node.left), b = tryConstEval(node.right); return (a === null || b === null) ? null : a / b; }
        case 'pow': { const a = tryConstEval(node.base), b = tryConstEval(node.exponent); return (a === null || b === null) ? null : Math.pow(a, b); }
        case 'neg': { const v = tryConstEval(node.operand); return v === null ? null : -v; }
        default: throw new Error(`Unhandled formula node kind: ${node.kind}`);
    }
}

// ---- constraint grammar -------------------------------------------------------------------------
//
// Parses "<lhs> OP bound" for OP in >=, <=, >, <, where <lhs> is a weighted sum of stats
// (weight trails what it scales, e.g. hpr*3, hpr*3 + mr) and may contain both(...)/allReq
// aggregate terms, which expand at parse time into a cartesian product of separate constraints.
// Port of CraftOptimizerRunner.parseConstraint/parseTerms.

/** `allReq` in a term position is sugar for both(...) over these, same order as REQ_STATS. */
const ALL_REQ_ORDER = REQ_STATS;

/**
 * Parses one constraint string into a list of `{terms, strict, isMin, bound}` constraints (more than
 * one only when the string contains a `both(...)`/`allReq` aggregate that expands into a cartesian
 * product of branches).
 */
function parseConstraint(s) {
    for (const op of ['>=', '<=', '>', '<']) {
        const idx = s.indexOf(op);
        if (idx < 0) continue;
        const branches = parseTerms(s.substring(0, idx), s);
        const boundText = s.substring(idx + op.length).trim();
        // parseInt is lenient (e.g. "5abc" -> 5); require the whole trimmed text to be an integer,
        // matching Java's Long.parseLong strictness.
        if (!/^[+-]?\d+$/.test(boundText)) {
            throw new FormulaParseError(`Unparseable constraint bound in "${s}"`);
        }
        const bound = parseInt(boundText, 10);
        const isMin = op.startsWith('>');
        const strict = op === '>' || op === '<';
        return branches.map(terms => ({ terms, strict, isMin, bound }));
    }
    throw new FormulaParseError(`Unparseable constraint (expected e.g. "durability>99"): ${s}`);
}

/**
 * Splits a constraint's left-hand side into weighted terms on top-level +/- (a +/- nested inside a
 * both(...) argument does not split the outer sum). Returns a list of branches (each a list of
 * {statName, weight} terms) - one branch per both(...) cartesian-product combination, a single-
 * element list when the lhs contains no both(...)/allReq.
 */
function parseTerms(lhs, whole) {
    let branches = [[]];

    let depth = 0, pieceStart = 0;
    const pieces = [];
    for (let i = 0; i < lhs.length; i++) {
        const c = lhs[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (depth === 0 && (c === '+' || c === '-') && i > pieceStart) {
            pieces.push(lhs.substring(pieceStart, i));
            pieceStart = i;
        }
    }
    pieces.push(lhs.substring(pieceStart));

    for (const piece of pieces) {
        let term = piece.trim();
        if (term === '') continue;
        let sign = 1.0;
        if (term.startsWith('+') || term.startsWith('-')) {
            if (term.startsWith('-')) sign = -1.0;
            term = term.substring(1).trim();
        }
        let weight = 1.0;
        const star = lastTopLevelStar(term);
        if (star >= 0) {
            const weightText = term.substring(star + 1).trim();
            weight = parseFloat(weightText);
            if (!Number.isFinite(weight) || weightText === '') {
                throw new FormulaParseError(`Unparseable term weight in "${whole}"`);
            }
            term = term.substring(0, star).trim();
        }
        if (term === '') throw new FormulaParseError(`Missing stat name in "${whole}"`);

        const signedWeight = sign * weight;
        let termBranches;
        if (term === 'allReq') {
            const argBranches = ALL_REQ_ORDER.map(stat => [[{ statName: stat, weight: 1.0 }]]);
            termBranches = expandBoth(argBranches, signedWeight, whole);
        } else if (term.startsWith('both(') && term.endsWith(')')) {
            const args = splitTopLevelCommas(term.substring(5, term.length - 1), whole);
            if (args.length === 0) throw new FormulaParseError(`Empty both(...) in "${whole}"`);
            const argBranches = args.map(arg => parseTerms(arg, whole));
            termBranches = expandBoth(argBranches, signedWeight, whole);
        } else {
            termBranches = [[{ statName: term, weight: signedWeight }]];
        }

        const combined = [];
        for (const prior of branches) {
            for (const thisTerm of termBranches) {
                combined.push(prior.concat(thisTerm));
            }
        }
        branches = combined;
    }

    if (branches.length === 1 && branches[0].length === 0) {
        throw new FormulaParseError(`Missing stat name in "${whole}"`);
    }
    for (const terms of branches) {
        if (terms.length > 1) {
            for (const t of terms) {
                if (EFF_EXEMPT_STATS.includes(t.statName)) {
                    throw new FormulaParseError(`Constraint "${whole}": ${t.statName} cannot appear in a `
                        + `multi-term constraint - it is not scaled by effectiveness. Use it as its own constraint instead.`);
                }
            }
        }
    }
    return branches;
}

/**
 * Combines a both(...)'s (or allReq's) per-argument branch lists into the aggregate term's own
 * branch list: one branch per argument, each scaled by outerWeight.
 */
function expandBoth(argBranches, outerWeight, whole) {
    const out = [];
    for (const arg of argBranches) {
        for (const branch of arg) {
            out.push(branch.map(t => ({ statName: t.statName, weight: t.weight * outerWeight })));
        }
    }
    return out;
}

/** Index of the LAST top-level '*' in `term` (not inside a nested both(...)), or -1. */
function lastTopLevelStar(term) {
    let depth = 0, last = -1;
    for (let i = 0; i < term.length; i++) {
        const c = term[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '*' && depth === 0) last = i;
    }
    return last;
}

/** Splits both(...)'s argument list on top-level commas (not inside a nested both(...)). */
function splitTopLevelCommas(args, whole) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < args.length; i++) {
        const c = args[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            out.push(args.substring(start, i));
            start = i + 1;
        }
    }
    out.push(args.substring(start));
    if (depth !== 0) throw new FormulaParseError(`Unbalanced parentheses in "${whole}"`);
    return out;
}

/** Parses a comma-separated list of constraint strings into a flat list of constraints. */
function parseConstraints(text) {
    const out = [];
    const trimmed = text.trim();
    if (trimmed === '') return out;
    for (const piece of splitConstraintList(trimmed)) {
        const c = piece.trim();
        if (c === '') continue;
        out.push(...parseConstraint(c));
    }
    return out;
}

/** Splits the constraint textarea's comma-separated list on top-level commas (not inside both(...)). */
function splitConstraintList(text) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            out.push(text.substring(start, i));
            start = i + 1;
        }
    }
    out.push(text.substring(start));
    return out;
}
