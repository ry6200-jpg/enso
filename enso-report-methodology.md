# Enso Report - Methodology

**Status:** proposed method, not a build spec. Written to be argued with before any EN numbers are assigned.

**Purpose:** determine whether an accumulated Enso corpus contains observations about the user that the user could not readily have produced themselves - and to make that determination *checkable* rather than merely persuasive.

---

## 0. Design commitments

These are constraints the method accepts before anything is measured. They come from the existing architecture and from the methodological literature, and they are what separate this from a fluent write-up.

1. **Idiographic only.** Every quantity is compared against the user's own history. No population norms, no percentile against other testers. Molenaar's ergodicity argument is the reason: relationships that hold across a population routinely fail to hold within any individual, so a between-person benchmark would be a category error on an n-of-1 corpus.
2. **Provenance or it doesn't ship.** Every displayed line carries dates and, where it is a judgement rather than a count, the verbatim span it was derived from. This is the same discipline the memory layer already runs on and it is load-bearing here for the same reason: an observation the user cannot audit is an observation the user cannot disagree with.
3. **Counts before prose.** Layers 1 and 2 are deterministic and cost nothing. They ship first and stand alone. LLM scoring (Layer 3) is added only after the deterministic layer has been read, so that its contribution can be judged separately rather than blended in.
4. **Observation, not characterization.** "You mentioned X in seven conversations since April, always alongside Y" is a finding. "You have difficulty with X" is a verdict. The page produces the first kind. This is not a stylistic preference - the first is falsifiable against the event log and the second is not.
5. **Negative results are results.** Where a marker shows no reliable change, the page says so. A report that only ever finds things is a report that cannot fail.

---

## 1. Corpus construction

**Unit of analysis.** The user's own `message_sent` events only. Enso's replies are excluded from all marker computation - they are model output and would contaminate every linguistic measure with the persona's own register.

**Time binning.** Markers are computed per window, not per message. Default window: 7 days, sliding. Rationale: single messages are too short for stable rate estimates (function-word rates are unstable below roughly 100-200 words), and per-session bins are unevenly sized.

**Minimum data thresholds.** Nothing is displayed from a window below the word-count floor, and no trend is displayed with fewer than the minimum number of windows (see Section 2.3). Below threshold the page says the corpus isn't deep enough yet - it does not silently degrade to weaker evidence.

**Event-time vs record-time.** Currently unbuilt. All binning is by record time (when the user said it), which is correct for linguistic markers but wrong for anything about *when the described events happened*. Any finding that depends on event time is out of scope until EN-037 lands.

**Corpus segmentation.** Windows are tagged by subject mix - how much of the material is about the Enso project versus everything else. This is reported as a dimension of the result, not used to filter the corpus. If markers differ sharply between segments, that itself is the finding.

---

## 2. Layer 1 - Deterministic markers

No API calls. All computed from the event log and projections.

### 2.1 Psycholinguistic markers

Grounded in the Pennebaker line of work on expressive writing and function-word analysis. The robust findings there are about *closed-class* words - pronouns, negations, causal and insight terms - not topic vocabulary. Two results are worth building toward:

- **First-person singular rate** covaries with self-focused attention and distress. Within-person shifts are the interpretable signal, not the absolute level.
- **Change in causal and insight word rates across a writing period** predicts benefit from expressive writing better than emotional tone does. The construct is movement toward a more organized account, not positivity.

**Implementation note on dictionaries.** LIWC itself is licensed and should not be assumed available. The classes above are small and closed, and can be enumerated directly in the repo as an explicit, version-controlled word list - which is preferable anyway, since a hand-checked list is auditable and a black-box dictionary is not. Classes to enumerate: first-person singular, first-person plural, second person, third person, negation, causal, insight, tentative, certainty, and (with lower confidence) valenced affect terms.

**Caveat to carry into the UI:** effect sizes in this literature are small at population level. On a single corpus these markers are a *direction to look*, not a conclusion.

### 2.2 Social network markers

This is the part of the report no journaling app can compute, because it requires the entity graph Enso already maintains.

From `entities` and `social_bonds`:

- Active tie count per window; new-entity rate; entity turnover
- Mention concentration across entities (a Gini or HHI over the mention distribution) - whether attention is spread or centred on a few people
- **Dormancy intervals** - the existing two-class model already distinguishes open-inferred from close-stated with asymmetric intervals, and "dormant not dead" is already a first-class concept. Dormancy onset is directly computable and is one of the strongest candidates for a genuinely unnoticed observation.
- Tie composition by relationship class
- Structural properties where the graph supports them: density among the user's alters, and bridging positions (Burt's structural-holes framing) where one person is the user's only link to a cluster

The convoy model's concentric circles (innermost / middle / outer support layers) is a reasonable presentation frame for these numbers - but it should be a layout, never a label shown to the user.

### 2.3 Temporal and behavioural markers

- Session cadence, inter-session gaps, burstiness
- Time-of-day distribution
- Message length distribution and its variance
- Lexical diversity per window

### 2.4 Within-person change detection

Every marker gets a personal baseline built from the user's own prior windows. Deviation is expressed against that baseline, with an explicit uncertainty interval - not as a bare number.

**Lagged structure** is the genuinely idiographic move: cross-correlation between markers at lags of one and two windows, within this person only. Example hypothesis the data could speak to - whether a tie going dormant precedes, follows, or is unrelated to a shift in self-focus markers.

**Honesty constraint:** this analysis is badly underpowered early. Dynamic within-person modelling wants tens of observations per series. The page must gate lag findings behind a minimum window count and state the count when it displays one. Displaying a lag correlation from six windows would be the single easiest way to make this whole exercise produce confident nonsense.

---

## 3. Layer 2 - Rubric-scored dimensions

One structured LLM call per scored unit. Added only after Layer 1 has been read on its own.

**What the model does:** applies a defined rubric with anchored levels to a specific retrieved span, and returns a rating plus the verbatim span it scored. **What the model never does:** free-form assessment of the person.

Dimensions, from the narrative identity coding literature (McAdams):

- **Agency** - the degree to which the narrator is depicted as affecting their own outcomes
- **Communion** - connection, care, belonging as a driver in the account
- **Redemption sequence** - bad state resolving to good
- **Contamination sequence** - good state spoiled by bad
- **Coherence** - temporal and causal organisation of the account

These are established coded dimensions with published scoring schemes and trained-rater reliability, which is exactly why they suit an LLM: the task is rubric application, not judgement formation.

**Reliability control.** Each scored unit is rated twice - ideally once per provider, since both are already wired with fallback. Disagreement beyond one rubric level means the item is not displayed. Agreement rate across the scored set is itself reported on the page. This is inter-rater reliability, done cheaply, and it converts "the model said so" into a number with a known error rate.

**Dependency.** Meaningful narrative scoring wants episode boundaries and an emotion track. Both are EN-037 / EN-038, built at Phase 8.5. Until then this layer runs on retrieved spans and should be labelled provisional.

---

## 4. Layer 3 - Validity controls

The controls are the experiment. Without them the page will produce something that reads as insightful whether or not it is, because well-written observations about a person reliably feel accurate - the Barnum/Forer effect is the specific hazard, and this genre is where it lives.

### 4.1 Prediction capture

Before the report is generated, the user records what they expect it to show - who is central, what recurs, what is absent. Stored, timestamped, shown side by side with the result afterward. **The delta is the finding.** Without a prediction written first, hindsight makes everything look like something you already knew.

### 4.2 Discrimination check

The report includes a small number of decoy observations: statements constructed to be true of almost anyone, formatted identically to the real ones. The user rates each item as *this is specifically me* or *this could be anyone*. If real and decoy items are rated the same, the page is producing recognition rather than information, and that is a clean negative result.

### 4.3 Falsifiability spot-check

Any count the page displays can be traced to the events behind it. One-tap drill-down from a line to the messages it was computed from. This is a scientific control, not a UI nicety - it is what makes a wrong finding discoverable instead of merely unconvincing.

### 4.4 Reactivity acknowledgement

The corpus was produced by someone who knew they were testing a system, in a period when much of the conversation was about the system itself. That is a real confound on the current data and should be stated on the page rather than reasoned around. It weakens as ordinary use accumulates.

### 4.5 Multiplicity

Computing many markers over many windows will produce apparent effects by chance alone. The page displays a fixed, pre-registered set of markers rather than surfacing whichever ones happened to move - otherwise it is selecting on noise every time it runs.

---

## 5. What ships in what order

| Stage | Contents | Cost | Blocked on |
|---|---|---|---|
| A | Layer 1 markers, personal baselines, drill-down, prediction capture | 0 / $0 - no API | nothing |
| B | Discrimination check, negative-result reporting, corpus segmentation display | $0 | A |
| C | Lag structure | $0 | enough windows to be legitimate |
| D | Rubric scoring + dual-rater reliability | per-unit LLM cost | EN-037 / EN-038 for full value |

Stage A alone answers the actual question. If the deterministic layer shows the user nothing they didn't know, adding generated prose on top will not create signal - it will only make its absence harder to detect.

---

## 6. Open questions for the user

1. **Access.** Upper-right menu, as stated. Generated on demand or on a cadence? On-demand is cheaper and avoids notification-driven checking; a cadence is what makes drift visible.
2. **Does the report enter the corpus?** If Enso can see its own reports, later conversation is influenced by earlier analysis and the corpus stops being independent. Recommendation: it does not - the report reads the event log, and never writes to it.
3. **Where does the unsolicited-advice rule land?** A page the user deliberately opens is arguably a direct question, which Enso is already permitted to answer plainly. That reading needs stating explicitly rather than being assumed, since a report is otherwise exactly the verdict-surface the persona rules exclude.
4. **Tester scope.** On a new tester's corpus this page is empty for weeks and its early output would be its least reliable. Gate it behind a data threshold, or hold it back from the first round entirely.
