# Design decisions (from the solution design, 8 Nov 2026)

The full design is in the [solution design document](https://claude.ai/artifact/N3KZsLiPgrwHmjRrBMkZm1).

| #   | Decision               | Outcome                                                                                                                                                  |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Region                 | Sydney (ap-southeast-2) for all workloads and data. us-east-1 only for CloudFront certificates and WAF. Backups are copied to Melbourne (ap-southeast-4) |
| D2  | Social login           | Kept, with an app-level MFA step-up for Google, Apple and Facebook sessions                                                                              |
| D3  | Cognito plan           | Plus in prod, Essentials in staging                                                                                                                      |
| D4  | Native apps            | None. No iOS or Android apps                                                                                                                             |
| D5  | Phone experience       | Responsive web app, installable as a PWA, with web push                                                                                                  |
| D6  | Agent SDK              | Strands Agents TypeScript SDK on AgentCore Runtime                                                                                                       |
| D7  | Cross-region inference | On, Australia-only geographic profile                                                                                                                    |
| D8  | AWS budget             | USD 400 a month, with alarms at 50%, 80% and 100% (estimate ≈ USD 330)                                                                                   |
| D9  | External pen test      | No. Automated scans plus a policy review instead                                                                                                         |
| D10 | GitHub                 | Personal account, public repo on GitHub Free, Dependabot allowed                                                                                         |
| D11 | App email              | Sent as kyra@blueprintmusic.group through Gmail SMTP (smtp.gmail.com:587, STARTTLS) with a Gmail app password stored in Secrets Manager. No Google Cloud |
| D12 | AWS accounts           | One account, no AWS Organizations. Permission boundary instead of SCPs                                                                                   |
| D13 | AI knowledge           | One Bedrock knowledge base per artist plus one for BMG. Artists never see each other's content; BMG sees everything except items marked private          |
| D14 | Repository             | github.com/mteichtahl/blueprint                                                                                                                          |
| D15 | AI prompts             | Every prompt editable by a BMG admin, versioned, with preview and rollback. Safety rules stay in code                                                    |

## Notes from Phase 1

- **Audit archive Object Lock:** it starts in GOVERNANCE mode while the platform is being set up. Switch `audit.objectLockMode` to `COMPLIANCE` once stable. This is irreversible.
- **Merging on main:** branch protection requires the CI checks but not a review approval. GitHub won't let a solo maintainer approve their own PR. Production deploys still need an environment reviewer.
- **Dependabot:** its GitHub user id (49699333) is in `allowedActorIds` so its PRs can run CI. The CI runner role has no deploy rights.
