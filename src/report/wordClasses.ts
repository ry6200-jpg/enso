/**
 * Report page, Stage A (enso-report-methodology.md Section 2.1). Explicit,
 * version-controlled word-class lists — deliberately NOT a pull from LIWC
 * or any other licensed/black-box dictionary (the methodology doc's own
 * "Implementation note on dictionaries"). These are closed-class function
 * words, the category the Pennebaker line of work actually finds signal
 * in — never topic vocabulary, never an attempt to reproduce LIWC's exact
 * category boundaries or norms. A hand-checked list is auditable; treat
 * this as a reasonable, inspectable substitute, not a validated
 * replication of any published instrument.
 *
 * All lowercase, matched against lowercased, tokenized message text
 * (wordClassMarkers.ts). Multi-word entries ("sort of", "kind of") are
 * matched as substrings of the lowercased text, not as single tokens.
 */

export type WordClass = "firstPersonSingular" | "firstPersonPlural" | "secondPerson" | "thirdPerson" | "negation" | "causal" | "insight" | "tentative" | "certainty" | "valencedAffect";

export const WORD_CLASS_LABELS: Record<WordClass, string> = {
  firstPersonSingular: "First-person singular",
  firstPersonPlural: "First-person plural",
  secondPerson: "Second person",
  thirdPerson: "Third person",
  negation: "Negation",
  causal: "Causal",
  insight: "Insight",
  tentative: "Tentative",
  certainty: "Certainty",
  valencedAffect: "Valenced affect (lower confidence)"
};

export const WORD_CLASSES: Record<WordClass, readonly string[]> = {
  firstPersonSingular: ["i", "me", "my", "mine", "myself", "i'm", "i've", "i'll", "i'd"],
  firstPersonPlural: ["we", "us", "our", "ours", "ourselves", "we're", "we've", "we'll", "we'd"],
  secondPerson: ["you", "your", "yours", "yourself", "yourselves", "you're", "you've", "you'll", "you'd"],
  thirdPerson: [
    "he", "him", "his", "himself", "he's", "he'd", "he'll",
    "she", "her", "hers", "herself", "she's", "she'd", "she'll",
    "they", "them", "their", "theirs", "themselves", "they're", "they've", "they'll", "they'd",
    "it", "its", "itself", "it's"
  ],
  negation: [
    "no", "not", "never", "none", "nobody", "nothing", "neither", "nor", "nowhere",
    "cannot", "can't", "won't", "don't", "doesn't", "didn't",
    "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't",
    "shouldn't", "wouldn't", "couldn't"
  ],
  causal: [
    "because", "cause", "caused", "causing", "reason", "reasons",
    "therefore", "thus", "hence", "since", "why",
    "effect", "affects", "affected", "consequently",
    "result", "results", "resulted", "resulting",
    "leads", "led", "leading", "due"
  ],
  insight: [
    "think", "thinking", "thought", "thoughts",
    "know", "knew", "known", "knowing",
    "realize", "realized", "realizing",
    "understand", "understood", "understanding",
    "believe", "believed", "believing",
    "consider", "considered", "considering",
    "wonder", "wondered", "wondering",
    "recognize", "recognized", "recognizing",
    "figure", "figured", "figuring",
    "notice", "noticed", "noticing"
  ],
  tentative: [
    "maybe", "perhaps", "guess", "guessed", "possibly", "probably",
    "might", "could", "seem", "seems", "seemed", "seeming",
    "apparently", "somewhat", "sort of", "kind of", "unsure", "uncertain"
  ],
  certainty: [
    "always", "never", "definitely", "absolutely", "certainly", "sure",
    "clearly", "obviously", "undoubtedly", "surely", "totally", "completely", "entirely"
  ],
  valencedAffect: [
    "good", "great", "happy", "love", "loved", "glad", "nice", "wonderful", "excited", "grateful", "relieved",
    "bad", "sad", "angry", "hate", "hated", "upset", "worried", "afraid", "stressed", "anxious", "frustrated", "hurt", "tired", "exhausted"
  ]
};

export const ALL_WORD_CLASSES: readonly WordClass[] = Object.keys(WORD_CLASSES) as WordClass[];
