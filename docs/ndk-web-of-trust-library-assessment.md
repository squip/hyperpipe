# NDK Web-of-Trust system overview + practical use cases

after reading the library’s docs and source, the clean mental model is: `@nostr-dev-kit/wot` is a **personal, rooted trust graph** plus a small set of **local filtering and ranking helpers**. You give it an NDK instance and a root pubkey, it treats that root as depth `0`, then walks outward through contact lists from that user’s perspective. The docs explicitly describe the intended pattern as **“fetch broadly, filter locally”**: pull a broad set of events from relays once, then adjust trust strictness in memory without re-fetching.

## How it works

Under the hood, `NDKWoT.load()` effectively does a breadth-first expansion: for each depth level, it gathers all users at that level, fetches their contact lists in batch, extracts valid `p` tags, and adds the discovered pubkeys as the next hop in the graph. Each node stores the pubkey, its **shortest known depth** from the root, and a `followedBy` set containing in-graph users who follow it. If the same pubkey is found through multiple paths, the node keeps the shorter depth and accumulates more entries in `followedBy`. The builder also validates pubkeys, ignores invalid `p` tags, supports `maxFollows` as a hard per-user fan-out cap, and can stop on timeout.

For fetching, the current implementation tries to be efficient on larger batches: `load()` defaults to negentropy-based syncing through `NDKSync` once the author batch reaches the configured threshold (`negentropyMinAuthors`, default `5`), and falls back to subscription-based fetching if negentropy is disabled or unavailable. The changelog describes this as a bandwidth optimization for larger WoT builds.

Once built, the graph gives you a few simple primitives: `includes(pubkey, { maxDepth })`, `getDistance(pubkey)`, `getScore(pubkey)`, `getNode(pubkey)`, and helpers like `filterByWoT`, `rankByWoT`, and `createWoTComparator`. Filtering is binary-ish; ranking is where the different algorithms come in.

## Depth vs. score

One important implementation detail: in the current library, **depth/distance and score are not separate trust models**. The ranking algorithm name is `distance`, but the underlying graph field is `depth`; meanwhile `getScore(pubkey)` is literally `1 / (depth + 1)`. So `algorithm: "distance"` sorts by hop count, and `algorithm: "score"` sorts by that inverse-depth value. Because score is just a monotonic transform of depth, those two algorithms produce the **same ordering today**.

So the real difference is mostly **how you express policy**:

- **Depth / distance** is easiest to explain to humans: “only direct follows,” “friends of friends,” “up to 3 hops.”
    
- **Score** is easier to mix into a numeric ranker, but it is still the same signal underneath. A score cutoff is just a depth cutoff in disguise: `1.0` = root only, `0.5` = depth 1, about `0.333` = depth 2, `0.25` = depth 3.
    

A subtle consequence: **score does not reward multiple independent trust paths**. If two authors are both at depth 2, they get the same score even if one is followed by one trusted user and the other is followed by twenty trusted users. The built-in signal for that second idea is the **`followers`** algorithm, which ranks by `followedBy.size` inside your constructed WoT. That is better understood as **“consensus within my trust graph”** than “closeness to me.” It is also **not** the author’s global follower count on Nostr; it is only the count of followers discovered inside your WoT build.

A tiny example makes this clearer. Suppose **you** follow Alice and Bob, and both Alice and Bob follow Carol. Alice and Bob are depth 1, so their score is `0.5`. Carol is depth 2, so her score is about `0.333`. With `distance` or `score`, Alice and Bob rank above Carol because they are closer to you. With `followers`, Carol may rank highest because **two** people in your trust graph independently follow her. That matches the source exactly: depth measures proximity; followers measures in-WoT endorsement count.

## Which one to use

Use **depth/distance** when you want a clear, explainable trust boundary. It is the right default for moderation and “strictness” controls. Use **score** when you want to blend the same trust signal into a larger formula with recency, engagement, or other app-specific weights via a custom comparator. Use **followers** when the goal is discovery or consensus — surfacing accounts that many trusted people already follow.

One small implementation gotcha: `filterByWoT()` first checks `includes(pubkey, { maxDepth })`, and if that fails it returns `includeUnknown`. In practice that means authors **outside your chosen depth slice** are treated the same as “unknown” for filtering purposes. So if you want a hard depth cap, keep `includeUnknown: false`.

## Practical use cases

The repo docs do not name specific production apps, but they clearly support these product patterns:

- **Spam-resistant home feed or replies.** Fetch notes broadly, then keep only authors within 1–2 hops, or rank closer authors first. This matches the documented “fetch broadly, filter locally” model.
    
- **Automatic moderation at the NDK layer.** The docs show plugging WoT into `ndk.muteFilter` so subscriptions and fetches automatically exclude authors outside your trust graph.
    
- **Hybrid moderation.** The docs also show combining manual mutes, WoT inclusion, and keyword/content filters, which is a realistic social-product moderation stack.
    
- **User-visible “trust slider.”** The documented pattern of switching between depth 1, 2, and 3 is a natural UX for “strict / balanced / broad” feeds.
    
- **Trusted discovery.** Ranking by `followers` is useful for “people you may want to follow” or “popular in your network” views, because it favors authors endorsed by many people already inside your WoT.
    
- **Blended ranking.** The docs show a custom comparator using WoT score; in a real app you’d combine that with recency or engagement to get a more nuanced feed.
    

My practical takeaway: **pick depth for policy, score for composition, followers for discovery.** If you were expecting `score` to be a richer propagation algorithm than depth, the current implementation is simpler than that — it is just inverse depth, not PageRank, not path-weighted trust, and not a multi-signal reputation system.

I can also turn this into a one-page “decision guide” with example thresholds and sample ranking formulas if that would help.


## NDK WoT decision guide

### 1) Pick the trust boundary first

For the current `@nostr-dev-kit/wot`, the cleanest first decision is **how far out from the root user you want to trust**. The library exposes that as either `maxDepth` or `minScore`. In the current implementation, those are directly linked because `getScore(pubkey)` is `1 / (depth + 1)`. That means these pairs are equivalent today: depth `1` ↔ score `0.5`, depth `2` ↔ score `~0.333`, depth `3` ↔ score `0.25`. The docs also use 1, 2, and 3 hops as the adjustable strictness examples.

My recommended starting presets:

- `maxDepth: 1` or `minScore >= 0.5` — **strict**. Use this for high-spam surfaces such as replies, mentions, or “only show people I directly trust.”
    
- `maxDepth: 2` or `minScore >= 0.333` — **balanced**. Good default for a main social feed.
    
- `maxDepth: 3` or `minScore >= 0.25` — **broad**. Better for discovery, but still rooted in the user’s social graph.
    

### 2) Then choose the ranking signal

Use `distance` when you want the most explainable behavior: it sorts by hop count from the root, so closer authors rank higher.

Use `score` when you want to blend trust into a larger numeric model. In the current code, though, `score` is just inverse depth, and the built-in comparator sorts it descending. So **`distance` and `score` produce the same ordering today**; `score` is mainly useful because it is already normalized into a 0–1 number.

Use `followers` when you want **consensus inside the user’s trust graph**. The ranking code uses `getNode(pubkey)?.followedBy.size`, and the `WoTNode` type defines `followedBy` as “who follows this user.” So this is **not global Nostr follower count**; it is “how many people inside my WoT follow this account.” That makes it best for discovery, not for a hard safety boundary.

### 3) Hard boundary or soft boundary?

If you want a **hard trust wall**, filter with `includeUnknown: false`. In `filterByWoT`, the library first checks `wot.includes(pubkey, { maxDepth })`; if that fails, it immediately returns `includeUnknown`.

If you want a **soft boundary**, keep unknowns but rank them lower with `unknownsLast: true`. That setting is handled in the ranking comparator, not the filter.

One practical gotcha: avoid setting both `maxDepth` and `minScore` unless you mean to double-restrict. In the built-in filter, depth is checked first and score second; because score is inverse depth, those two knobs are mostly redundant right now. For example, `maxDepth: 2` plus `minScore: 0.5` effectively collapses back to depth `1`.

## Suggested presets

const wotPresets = {  
  strict: {  
    filter: { maxDepth: 1, includeUnknown: false },  
    rank:   { algorithm: "distance", unknownsLast: true }  
  },  
  
  balanced: {  
    filter: { maxDepth: 2, includeUnknown: false },  
    rank:   { algorithm: "distance", unknownsLast: true }  
  },  
  
  discovery: {  
    filter: { maxDepth: 3, includeUnknown: true },  
    rank:   { algorithm: "followers", unknownsLast: true }  
  }  
};

These are recommendations, not library defaults. They are based on the docs’ 1/2/3-hop strictness pattern and the current source definition of score as inverse depth.

## Sample ranking formulas

The library supports a custom comparator in `rankByWoT`, so the built-in algorithms are best thought of as primitives you can compose with recency, engagement, or app-specific signals. The API also exposes `getScore`, `getDistance`, and `getNode`, which is enough to build richer models.

A good default main-feed formula:

feedScore = 0.7 * wotScore + 0.3 * recency24h

Use this after filtering at depth `2`. It keeps the trust model simple while still letting newer content rise.

A good discovery formula:

discoverScore = 0.55 * followerConsensus + 0.25 * wotScore + 0.20 * recency72h

Where:

wotScore = wot.getScore(pubkey)  
followerConsensus = log2(1 + wotFollowers) / log2(1 + 16)  
wotFollowers = wot.getNode(pubkey)?.followedBy.size ?? 0

This favors authors followed by several people inside the user’s WoT, while still preferring closer nodes.

A good reply-triage formula:

allow = depth <= 2 || wotFollowers >= 2  
replyScore = 0.6 * wotScore + 0.4 * engagementNorm

That last pattern requires a small custom filter because the built-in `filterByWoT` only exposes `maxDepth`, `minScore`, and `includeUnknown`.

Here is a minimal custom-comparator example:

const now = Math.floor(Date.now() / 1000);  
  
const recency24h = (ts: number) =>  
  Math.max(0, 1 - (now - ts) / 86400);  
  
const blendedScore = (event: NDKEvent) =>  
  0.7 * wot.getScore(event.pubkey) +  
  0.3 * recency24h(event.created_at ?? 0);  
  
const ranked = rankByWoT(wot, events, {  
  comparator: (a, b) => blendedScore(b) - blendedScore(a)  
});

That works because `rankByWoT` accepts a custom comparator directly.

## The shortest possible rule of thumb

Use **depth** when you need a policy boundary you can explain to users. Use **score** when you want the same trust signal in a numeric formula. Use **followers** when you want “popular among people I trust.” Use `includeUnknown: false` for hard filtering, and `unknownsLast: true` for softer exploration.

If you want, I can turn this into a small TypeScript helper module with `strict`, `balanced`, and `discovery` presets plus reusable comparator functions.


---


is it possible to use both distance and followers in a composite trust model? for example, could I set up a trust model to filter for anyone in my network with depth 1 by default, and then extends to anyone with depth 2 that meets a minimum followers rank threshold?

---


Thought for 31s

Yes — and that’s actually one of the most **practical and powerful patterns** you can build with this library.

Short answer: **you can absolutely combine distance (depth) + followers into a composite trust model**, but you’ll need to do it with a **custom filter + optional custom ranking**, not just the built-in helpers.

---

## 🧠 The model you’re describing

You want:

- ✅ Always include **depth = 1** (direct follows)
    
- ✅ Include **depth = 2 only if they have enough “trusted followers”**
    
- ❌ Exclude everything else
    

That’s essentially:

ALLOW if:  
  depth <= 1  
  OR (depth == 2 AND followers >= threshold)

This is a **tiered trust model**:

- Tier 1 → proximity (strong trust)
    
- Tier 2 → proximity + consensus (conditional trust)
    

---

## ⚙️ How to implement it

You’ll need to bypass `filterByWoT()` and write your own filter using:

- `wot.getDistance(pubkey)`
    
- `wot.getNode(pubkey)?.followedBy.size`
    

### Example filter

function passesCompositeTrust(wot, pubkey) {  
  const depth = wot.getDistance(pubkey);  
  if (depth === undefined) return false;  
  
  // Always trust direct follows  
  if (depth <= 1) return true;  
  
  // Conditional trust for depth 2  
  if (depth === 2) {  
    const followers = wot.getNode(pubkey)?.followedBy.size ?? 0;  
    return followers >= 2; // ← your threshold  
  }  
  
  return false;  
}

Then apply it:

const filtered = events.filter(e => passesCompositeTrust(wot, e.pubkey));

---

## 🔢 Choosing a followers threshold

This matters a lot. Since `followers` is **within your WoT only**, not global:

- `>= 1` → very permissive (basically “someone I trust follows them”)
    
- `>= 2–3` → good default (independent validation)
    
- `>= 5+` → strong consensus (good for high-signal feeds)
    

👉 A good starting point:

followers >= 2

That avoids single-hop spam chains.

---

## 📊 Optional: composite ranking (recommended)

After filtering, you can **rank within the allowed set** using both signals:

function score(event) {  
  const depth = wot.getDistance(event.pubkey) ?? 999;  
  const followers = wot.getNode(event.pubkey)?.followedBy.size ?? 0;  
  
  const proximityScore = 1 / (depth + 1); // same as getScore()  
  const followerScore = Math.log2(1 + followers) / Math.log2(1 + 8);  
  
  return 0.6 * proximityScore + 0.4 * followerScore;  
}

Then:

const ranked = filtered.sort((a, b) => score(b) - score(a));

---

## 🔍 Why this works well

This hybrid model fixes a key limitation of pure depth:

### Problem with depth-only

- A spammer can get into depth 2 with **just one weak connection**
    

### Your model fixes it

- Depth 2 requires **multiple independent endorsements**
    
- Depth 1 remains frictionless
    

This is very similar to:

- **“friends vs friends-of-friends with reputation”**
    
- Lightweight **Sybil resistance**
    

---

## 🧩 Variations you might consider

### 1. Progressive thresholds

if (depth === 2) return followers >= 2;  
if (depth === 3) return followers >= 5;

→ Expands reach but tightens requirements

---

### 2. Weighted followers (more advanced)

Right now, all followers count equally. But you could weight them:

weightedFollowers = sum(1 / (followerDepth + 1))

→ A follow from someone at depth 1 counts more than depth 3

---

### 3. Soft inclusion instead of hard cutoff

Instead of filtering depth 2:

- Include them all
    
- Rank low-follower ones near the bottom
    

This feels more “open network” and less binary.

---

## ⚠️ One subtle gotcha

Because WoT is built via BFS:

- A node’s `depth` is **shortest path only**
    
- But `followers` may include users from **multiple depths**
    

So you can get cases like:

- depth = 2
    
- followers = 3  
    (but those followers might be weakly connected)
    

That’s not wrong — just something to be aware of.

---

## ✅ Bottom line

Yes — your idea is not only possible, it’s **one of the best ways to use NDK WoT in practice**.

- Use **depth for baseline trust**
    
- Use **followers for validation**
    
- Combine them with a **custom filter**
    
- Optionally layer in a **composite ranking**
    

---

If you want, I can package this into a reusable `createCompositeWoTFilter()` utility with configurable thresholds so you can drop it straight into your app.
