# Security Policy

## Reporting a vulnerability

If you discover a security issue in `withvibe`, **please do not open
a public GitHub issue.** Instead, report it privately so we can fix it before
the details become public.

**Preferred channel:** [GitHub Security Advisories](https://github.com/withvibe/withvibe/security/advisories/new) — opens a private report.

If that isn't available to you, reach the maintainers via
**<https://withvibe.dev/contact>** and include:

- A description of the issue.
- Steps to reproduce (proof of concept welcome).
- The affected version / commit SHA.
- Your assessment of impact.

We aim to acknowledge reports within **3 business days** and provide a status
update or fix plan within **10 business days**.

## Scope

In scope:

- Authentication / authorization bypass
- Remote code execution
- SQL / command / template injection
- Sandbox escape from environment containers
- Sensitive data exposure (secrets, credentials, PII)
- Privilege escalation across workspace members

Out of scope:

- Issues in third-party dependencies (please report upstream).
- Vulnerabilities requiring physical access to a developer's machine.
- Self-XSS or social-engineering scenarios.
- Denial of service from resource exhaustion in self-hosted setups.

## Disclosure

We follow coordinated disclosure: once a fix is available, we'll publish a
security advisory crediting the reporter (unless you'd prefer to remain
anonymous).
