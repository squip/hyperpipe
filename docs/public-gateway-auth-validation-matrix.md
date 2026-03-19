# Public Gateway Auth Validation Matrix

This fixture set is designed to validate the current gateway host-authorization logic for:

- `GATEWAY_AUTH_HOST_POLICY=allowlist`
- `GATEWAY_AUTH_HOST_POLICY=wot`
- `GATEWAY_AUTH_HOST_POLICY=allowlist+wot`

It deliberately separates graph position from allowlist status so each policy branch can be isolated without needing a large number of accounts.

## Recommendation

Use one deterministic fixture graph and reuse it across all policy runs.

That is better than generating a different social graph per policy because:

- the meaning of each test account stays stable across runs
- the allowlist-only branch can be isolated with an account that is intentionally outside WoT
- the WoT branch can be isolated with accounts that are intentionally not allowlisted
- the `allowlist+wot` union can be validated without a second account set

For the richest WoT validation, use:

- `GATEWAY_AUTH_WOT_MAX_DEPTH=2`
- `GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2=2`

That gives you both a passing and failing depth-2 case.

## Fixture Accounts

Primary validation accounts:

- `operator`
- `allowlist_only`
- `wot_depth1`
- `wot_depth2_pass`
- `wot_depth2_fail`
- `wot_depth3`
- `outsider`

Helper accounts:

- `wot_anchor_1`
- `wot_anchor_2`
- additional `wot_anchor_*` accounts if you raise the depth-2 follower threshold

## Social Graph Shape

Recommended graph:

- `operator -> wot_depth1`
- `operator -> wot_anchor_1`
- `operator -> wot_anchor_2`
- each `wot_anchor_* -> wot_depth2_pass`
- only `threshold - 1` anchors follow `wot_depth2_fail`
- `wot_depth2_pass -> wot_depth3`
- `allowlist_only` is isolated from the WoT graph
- `outsider` is isolated from both allowlist and WoT

This means:

- `wot_depth1` is shortest distance 1
- `wot_depth2_pass` is shortest distance 2 with enough in-graph followers
- `wot_depth2_fail` is shortest distance 2 with too few in-graph followers
- `wot_depth3` is shortest distance 3
- `allowlist_only` is not in WoT
- `outsider` is neither in allowlist nor WoT

Scenario `not in allowlist, but is in wot` is not a unique graph position. It is already covered by `wot_depth1` and `wot_depth2_pass`.

## Expected Outcomes

Recommended policy profiles:

1. `allowlist`
2. `wot` with `maxDepth=1`
3. `wot` with `maxDepth=2` and `minFollowersDepth2=2`
4. `allowlist+wot` with `maxDepth=2` and `minFollowersDepth2=2`

Expected host-approval results:

| Account | allowlist | wot depth 1 | wot depth 2 + threshold | allowlist+wot |
| ------- | --------- | ----------- | ----------------------- | ------------- |
| `operator` | allow if explicitly allowlisted | allow | allow | allow |
| `allowlist_only` | allow | deny | deny | allow |
| `wot_depth1` | deny | allow | allow | allow |
| `wot_depth2_pass` | deny | deny | allow | allow |
| `wot_depth2_fail` | deny | deny | deny | deny |
| `wot_depth3` | deny | deny | deny | deny |
| `outsider` | deny | deny | deny | deny |

## Script

Use the deterministic fixture generator:

```bash
cd /Users/essorensen/hypertuna-electron/hypertuna-worker
npm run gateway:auth-fixture -- \
  --seed your-stable-seed \
  --relays wss://relay.damus.io/,wss://relay.primal.net/,wss://nos.lol/ \
  --depth2-min-followers 2 \
  --out ../test-logs/gateway-auth-fixture/manifest.json
```

The script will:

- generate the operator and validation accounts
- derive stable pubkeys and `nsec` values from the supplied seed
- publish kind `0` profile metadata
- publish kind `3` contact lists to construct the social graph
- subscribe back to the target relay set, fetch the published events, and reconstruct the resulting graph
- verify that the fetched metadata/contact lists and shortest-path graph match the expected fixture
- write a JSON manifest and Markdown summary with the generated credentials and recommended allowlist env values

## Live Gateway Validation

After the fixture accounts have been published, validate a deployed gateway directly against the manifest:

```bash
cd /Users/essorensen/hypertuna-electron/hypertuna-worker
npm run gateway:auth-validate -- \
  --manifest ../test-logs/gateway-auth-fixture/manifest.json \
  --gateway-origin https://hypertuna.com \
  --policy-column wotDepth2Threshold \
  --out ../test-logs/gateway-auth-fixture/live-wot-validation.json
```

Policy-column mapping:

- `open` for `GATEWAY_AUTH_HOST_POLICY=open`
- `allowlist` for `GATEWAY_AUTH_HOST_POLICY=allowlist`
- `wotDepth1` for `GATEWAY_AUTH_HOST_POLICY=wot` with `GATEWAY_AUTH_WOT_MAX_DEPTH=1`
- `wotDepth2Threshold` for `GATEWAY_AUTH_HOST_POLICY=wot` with `GATEWAY_AUTH_WOT_MAX_DEPTH=2` and `GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2=2`
- `allowlistPlusWot` for `GATEWAY_AUTH_HOST_POLICY=allowlist+wot` with `GATEWAY_AUTH_WOT_MAX_DEPTH=2` and `GATEWAY_AUTH_WOT_MIN_FOLLOWERS_DEPTH2=2`

For WoT-backed policy runs, prefer setting `GATEWAY_AUTH_WOT_RELAYS` explicitly to the same relay set the fixture publisher used. The gateway falls back to `GATEWAY_NOSTR_DISCOVERY_RELAYS` when `GATEWAY_AUTH_WOT_RELAYS` is unset, but keeping auth on a smaller dedicated relay set makes validation more deterministic.

The validator:

- uses the `secretHex` values from the manifest to sign real `POST /api/auth/challenge` and `POST /api/auth/verify` requests
- checks every fixture account against the selected manifest policy column
- writes a JSON and Markdown report when `--out` is provided
- exits nonzero if any live gateway result does not match the expected matrix

## Allowlist Values

Recommended env values produced by the script:

- pure `allowlist` testing should include both the operator and `allowlist_only`
- `allowlist+wot` testing only needs `allowlist_only` in the allowlist, because the operator is auto-approved through the WoT evaluator when configured as `GATEWAY_AUTH_OPERATOR_PUBKEY`
