# Web addresses (DNS)

The web app answers on two addresses per environment. Both serve the same
app; artists use the artist address and the Blueprint team uses the admin one.

| Environment | Artists                            | Blueprint team                    |
| ----------- | ---------------------------------- | --------------------------------- |
| Staging     | `artist-beta.blueprintmusic.group` | `admin-beta.blueprintmusic.group` |
| Production  | `artist.blueprintmusic.group`      | `admin.blueprintmusic.group`      |

The names come from `environments.<env>.hosts` in `bmg.config.json`. DNS for
blueprintmusic.group stays where it is (no Route 53): you add CNAME records
there by hand.

## How it fits together

- **Certificate:** one ACM certificate per environment, in us-east-1 (the only
  region CloudFront takes certificates from), covering both addresses. It's
  validated by DNS, so its validation CNAMEs must stay in place for ACM to
  renew it.
- **CloudFront:** once `environments.<env>.certificateArn` is set, the web
  stack adds both addresses to the distribution, with TLS 1.2 minimum
  (security review W1). Until then the app stays on its `*.cloudfront.net`
  address and nothing changes.
- **Passkeys** move to the root domain (`blueprintmusic.group`), so one
  passkey works on both addresses. Passkeys made on the CloudFront address
  stop working: people sign in with their password and authenticator code,
  then add a new passkey in Profile & preferences.
- **The old address** redirects to the artist address (permanent redirect),
  so bookmarks keep working. An app installed from the old address has to be
  installed again from the new one, and push notifications turned on again.
- **Links:** emails to artists link to the artist address; team invites and
  notification emails to the Blueprint team link to the admin address.
- **Connectors:** Blueprint's own connectors (set up by admins) return to the
  admin address, artists' connectors to the artist address. Connectors →
  Connector apps shows every redirect address a vendor app must allow.
- **Upload CORS** is narrowed from `*.cloudfront.net` to the two addresses
  (security review W3).

## Steps (do staging first, then prod)

1. **Request the certificate:**

   ```sh
   npm run blueprint -- dns cert --env staging
   ```

   It prints two validation CNAMEs (one per address). Add them at the name
   server, then:

   ```sh
   npm run blueprint -- dns cert --env staging --wait
   ```

   Once ACM issues the certificate (usually 5–30 minutes), the command saves
   its ARN into `bmg.config.json`.

2. **Point the addresses at CloudFront:**

   ```sh
   npm run blueprint -- dns records --env staging
   ```

   Add the two app CNAMEs it prints (`artist-beta` and `admin-beta` →
   the distribution's `*.cloudfront.net` name). Do this before the deploy, so
   the addresses work the moment CloudFront accepts them.

3. **Deploy:** commit `bmg.config.json` and merge to `main`. Deploy staging
   attaches the addresses. For prod, ship a release as usual.

4. **Check:**

   ```sh
   npm run blueprint -- dns check --env staging
   ```

5. **After the switch:**
   - Re-run `npm run blueprint -- e2e setup` so the E2E accounts use the new
     address.
   - Update the redirect address in each vendor's developer console (Meta,
     Google, Mailchimp, TikTok, LinkedIn): Connectors → Connector apps lists
     them. Keep the old one until everyone has reconnected, then remove it.
   - Social sign-in providers (when on): add
     `https://<host>/auth/callback` for both addresses as allowed callbacks.
   - Tell people to sign in on the new address and add their passkey again.

## Records at a glance

| Host (relative to blueprintmusic.group) | Type  | Value                                                 |
| --------------------------------------- | ----- | ----------------------------------------------------- |
| `_<token>.artist-beta`                  | CNAME | `_<token>.<…>.acm-validations.aws` (printed)          |
| `_<token>.admin-beta`                   | CNAME | `_<token>.<…>.acm-validations.aws` (printed)          |
| `artist-beta`                           | CNAME | staging distribution, `d1e03n0k2euijp.cloudfront.net` |
| `admin-beta`                            | CNAME | staging distribution, `d1e03n0k2euijp.cloudfront.net` |
| `_<token>.artist`                       | CNAME | printed by `dns cert --env prod`                      |
| `_<token>.admin`                        | CNAME | printed by `dns cert --env prod`                      |
| `artist`                                | CNAME | prod distribution (`dns records --env prod`)          |
| `admin`                                 | CNAME | prod distribution (`dns records --env prod`)          |

The root (`blueprintmusic.group`, the Squarespace site) and the Google
Workspace mail records (MX, SPF, DKIM, DMARC) are not touched.
