# Security policy

This repository is public. Its security comes from keys, IAM and Cognito, not from keeping the code secret.

## Reporting a vulnerability

Please do **not** open a public issue. Report it privately through GitHub's **Report a vulnerability** button (Security tab → Advisories). We aim to acknowledge reports within 3 business days.

## What we protect

- Artist data. Each artist has their own KMS key, and AI access to their data depends on a KMS grant that exists only while they opt in.
- The AWS account. A permission boundary sits on every role; GuardDuty, Security Hub, CloudTrail and Config are always on.
- The pipeline. Ephemeral CodeBuild runners, actor-ID webhook filters, fork-PR approval, SHA-pinned actions, and no secrets in GitHub.

Never commit secrets. `bmg.config.json` holds non-secret settings only. Secrets live in AWS Secrets Manager (`npm run bmg -- secrets set`).
