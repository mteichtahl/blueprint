# Staging scans: ZAP and load test (Phase 6)

The workflow is `.github/workflows/staging-scans.yml`, and it runs on the CI CodeBuild runner. It needs no AWS credentials and no Docker.

| When                                               | What                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Every Monday, about 04:23 Melbourne                | ZAP **baseline** (passive) scan, then the load test                                                                                       |
| On demand (Actions → Staging scans → Run workflow) | ZAP **full** active scan (the "extended ZAP scan" in the design), up to 90 minutes, and the load test. Optionally the WAF rate-rule check |

The target is `vars.STAGING_WEB_URL`, defaulting to the staging CloudFront URL. Set the variable when staging moves to `staging.blueprintmusic.group`.

## ZAP

- **Version and checksum:** ZAP 2.17.0 from its GitHub release, checked against a pinned SHA-256 before it runs. To upgrade, change `ZAP_VERSION` and `ZAP_SHA256` together.
- **Plan:** `tools/scans/zap-plan.mjs` writes it.
  - It seeds all 103 API routes from `infra/lib/api-stack.ts`, with harmless sample ids, so the scan reaches the API and not only the web app.
  - Then it spiders the app and runs a passive scan. In `full` mode, an active scan follows.
  - The active scan is paced to 1 thread at 400 ms, at most 750 requests per 5 minutes, so the API WAF doesn't block the scanner partway through.
- **Unauthenticated:** the scan tests the edge, the security headers, the WAF, the token authorizer and how the gateway handles bad input. Authenticated, per-role checks are the job of the authorisation matrix, which runs in CI.
- **Gate:** `tools/scans/zap-gate.mjs` fails the run on any **High** alert that isn't listed, with a reason, in `tools/scans/zap-accepted.json`. Every alert is summarised in the run's summary page.

## Load test

- **Script:** `tools/load/load.mjs`, plain Node. It uses an open model: a request starts every 1/rps seconds, so a slow backend shows up as latency.
- **Mix:**
  - The web shell, `config.json` and the JS bundle, served by CloudFront.
  - Unauthenticated API calls. These still go through the WAF, API Gateway and the token authorizer Lambda, which doesn't cache, so they load the real per-request path.
- **Default and pass criteria:**
  - 5 requests a second for 3 minutes (900 API requests, under the WAF limit).
  - Pass when web p95 is ≤ 800 ms and API p95 is ≤ 1,500 ms, with under 1% unexpected answers. For web, expected means 200. For API, expected means 401 or 403.
- **WAF rate-rule check:** opt-in. It sends bursts past the limit and passes if the WAF answers 403. It runs last, because it leaves the edge address blocked for a few minutes.
- **Why the rate is low:** the app has a handful of users. This proves the request path stays fast under steady use and that the per-request authorizer doesn't fall over. Capacity is bounded by Lambda and API Gateway quotas, not by the app.

## Finding from this work: W5 (medium, open)

- **The problem:** the API's regional WAF rate rule uses `aggregateKeyType: IP`. Behind CloudFront, it sees **CloudFront edge addresses**, not users. Users who share an edge address share one 1,000-per-5-minute budget, and one client can spread across edges. The limit is also 1,000, not the design's 2,000.
- **Why not key on `X-Forwarded-For`:** clients can spoof it.
- **Fix:** the edge WAF (us-east-1, CloudFront scope), which sees real client IPs, is already planned for when the custom domain is attached. At the same time, keep `/v1` reachable only through CloudFront: the `execute-api` URL is public today. Tracked with W1 in [security-review.md](security-review.md).
