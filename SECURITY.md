# Security policy

miganGO runs tools on your machine (files, shell, browser, desktop input) after owner approval.
Please report vulnerabilities **privately**: email **fahmiwol@gmail.com** with the subject
`miganGO security`. Do not open a public issue for an unpatched vulnerability.

In scope: approval bypass, permission-intersection bypass, spend-cap bypass, silent provider switching,
path/workspace escapes, local bridge authentication, recovery-journal replay of uncertain effects,
secret leakage to logs or providers.

Known, documented limits (not vulnerabilities by themselves): the approved shell, SSH and MCP tools are
trusted and unsandboxed by design; the AppContainer sandbox is not LPAC or a VM.
